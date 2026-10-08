// Real Stripe TEST-mode integration, isolated from the store database and fulfillment.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const express = require("express");
const dotenv = require("dotenv");
const Stripe = require("stripe");
const root = path.resolve(__dirname, "..");
const local = dotenv.parse(fs.readFileSync(path.join(root, ".env")));
const testKey = local.STRIPE_SECRET_KEY || "";
const testSender = process.env.AUCTION_TEST_FROM_EMAIL || "Rayan Rao Art <shipping@artwithrayan.com>";
if (!testKey.startsWith("sk_test_")) throw new Error("Refusing to start: the local Stripe key must be a test key.");
if (!local.RESEND_API_KEY || /onboarding@resend.dev/i.test(testSender)) throw new Error("A configured verified email sender is required for this integration test.");
const port = 3116;
const base = `http://localhost:${port}`;
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "rayan-auction-stripe-test-"));
const databasePath = path.join(runtime, "isolated.sqlite");
// Set every local .env name first, so server.js cannot reload production integrations.
for (const name of Object.keys(local)) process.env[name] = "";
Object.assign(process.env, {
  NODE_ENV: "test", PORT: String(port), BASE_URL: base, DB_PATH: databasePath,
  STRIPE_SECRET_KEY: testKey, STRIPE_API_KEY: testKey, STRIPE_WEBHOOK_SECRET: "",
  RESEND_API_KEY: local.RESEND_API_KEY, FROM_EMAIL: testSender,
  AUCTION_OWNER_EMAIL: "artwithrayan@gmail.com",
  PRINTFUL_API_KEY: "", PRINTFUL_SYNC_ON_STARTUP: "false", PRINTFUL_WEBHOOK_ON_STARTUP: "false",
  PRINTFUL_SYNC_INTERVAL_MS: "0", PRINTFUL_AUTO_CREATE_DRAFT_ORDER: "false", PRINTFUL_WEBHOOK_SECRET: "",
  GOOGLE_SHEETS_SPREADSHEET_ID: "", GOOGLE_SERVICE_ACCOUNT_EMAIL: "", GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: ""
});
const { logger, redactSecrets } = require("../src/security");
const sdk = new Stripe(testKey, { timeout: 15000, maxNetworkRetries: 1 });
let listener, server, worker;
let webhookReady = false;
function shutdown() {
  clearInterval(worker);
  listener?.kill();
  server?.close();
}
process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });

async function main() {
  // Read-only API call verifies the key works and cannot be a live key.
  await sdk.balance.retrieve();
  const cli = process.env.STRIPE_CLI_PATH || "stripe";
  listener = spawn(cli, ["listen", "--skip-update", "--events", "checkout.session.completed,checkout.session.expired,payment_intent.succeeded,payment_intent.payment_failed",
    "--forward-to", `${base}/api/stripe/webhook`, "--config", path.join(runtime, "stripe.toml")], { windowsHide: true, env: { ...process.env, STRIPE_API_KEY: testKey }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    let buffered = "";
    const timeout = setTimeout(() => reject(new Error("Stripe listener did not become ready within 45 seconds.")), 45000);
    function output(chunk) {
      buffered = (buffered + chunk.toString()).slice(-16000);
      const secret = buffered.match(/(whsec_[A-Za-z0-9]+)(?:\s|['"])/);
      if (secret && !webhookReady) {
        process.env.STRIPE_WEBHOOK_SECRET = secret[1]; webhookReady = true;
        clearTimeout(timeout); resolve();
        console.log("[test listener] Connected in test mode; signing secret retained only in memory.");
      }
      // No listener secret is written to disk or printed.
      if (/\b(?:FATAL|ERROR)\b/.test(buffered) && buffered.endsWith("\n")) console.error(redactSecrets(buffered));
    }
    listener.stdout.on("data", output); listener.stderr.on("data", output);
    listener.once("error", (error) => { clearTimeout(timeout); reject(error); });
    listener.once("exit", (code) => { clearTimeout(timeout); webhookReady = false; reject(new Error(`Stripe listener exited (${code}).`)); });
  });
  const email = require("../src/email");
  const realSend = email.sendEmail;
  email.sendEmail = (message) => {
    if (!/^artwithrayan(?:\+[a-z0-9._-]+)?@gmail\.com$/i.test(String(message.to))) return Promise.resolve({ failed: true, reason: "Local test emails are limited to Rayan's Gmail address and plus aliases." });
    return realSend({ ...message, subject: `[AUCTION TEST - NO REAL PAYMENT] ${message.subject}`, html: `<p><strong>Local Stripe test. No real purchase or shipment.</strong></p>${message.html}` });
  };
  // Do not import configured production auctions in the isolated test process.
  const configurationPath = require.resolve("../config/auctions.json");
  require.cache[configurationPath] = { id: configurationPath, filename: configurationPath, loaded: true, exports: [] };
  const { app, auctions, orders } = require("../server");
  const db = require("../src/db");
  if (path.resolve(process.env.DB_PATH) !== databasePath) throw new Error("Unexpected database path; refusing to proceed.");
  const sheets = require("../src/google-sheets");
  if (sheets.isConfigured() || process.env.PRINTFUL_API_KEY) throw new Error("Fulfillment isolation failed.");
  const id = `stripe-test-${Date.now()}`;
  auctions.configure([{ id, originalId: "the-light", startingPrice: 10,
    startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: new Date(Date.now() + 7 * 86400000).toISOString() }]);
  const wrapper = express();
  const intro = '<div style="padding:12px;background:#fff4cc;color:#222;text-align:center">LOCAL STRIPE TEST ONLY. No real money. Use your Gmail address or +bidder2 alias. <a href="/test-control">Test controls</a></div>';
  wrapper.get(["/auction.html", "/originals.html"], (req, res) => {
    res.type("html").send(fs.readFileSync(path.join(root, "public", req.path.slice(1)), "utf8").replace("<body>", `<body>${intro}`));
  });
  wrapper.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const event = sdk.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
      if (event.livemode !== false) return res.status(400).json({ error: "Live events are forbidden in the test server." });
      const object = event.data.object;
      const localSetup = object.metadata?.flow === "art_auction_setup" && db.sqlite.prepare("SELECT id FROM auction_entries WHERE id=?").get(object.metadata.entryId || "");
      const localPayment = object.metadata?.flow === "art_auction_payment" && object.metadata.auctionId === id;
      if (!localSetup && !localPayment) return res.json({ ignoredUnrelatedTestEvent: true });
      await auctions.webhook(event);
      res.json({ received: true });
    } catch (error) { logger.error("[test webhook]", error.message); res.status(500).json({ error: "Test webhook failed." }); }
  });
  wrapper.get("/test-control", (req, res) => {
    const auction = auctions.publicAuction(auctions.get(id));
    res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Isolated Stripe Auction Test</title><link rel="stylesheet" href="/styles.css"></head><body>${intro}<main class="auction-rules"><h1>Stripe test controls</h1><p>No changes to the live website, Printful, or Google Sheets. This is a fresh local database.</p><p>Listener: ${webhookReady ? "connected" : "disconnected"}. Auction: ${auction.status}. Accepted bids: ${auction.bidCount}.</p><p><a class="button" href="/auction.html?id=${id}">Open test auction</a></p><p>Use artwithrayan@gmail.com, then artwithrayan+bidder2@gmail.com for a second bidder. Use the real verification codes sent to your inbox, not 123456.</p><p>Stripe test card: 4242 4242 4242 4242, a future expiry, and any three-digit CVC. Never use a real card here.</p><form method="post" action="/test-control/close"><button ${auction.status !== "open" || !auction.bidCount ? "disabled" : ""}>Close auction and process test payment</button></form><p>The test starts at $10, plus the existing fixed shipping charge. All amounts are test money.</p><p>After closing, refresh to see payment status. Check your email and Stripe's test-mode Payments page. Production Google Sheets is deliberately disconnected.</p></main></body></html>`);
  });
  wrapper.post("/test-control/close", async (req, res) => {
    if (req.headers.origin !== base || !webhookReady) return res.sendStatus(403);
    db.sqlite.prepare("UPDATE art_auctions SET ends_at=? WHERE id=? AND status='open'").run(Date.now() - 1, id);
    await auctions.tick(); await orders.tick();
    res.redirect("/test-control");
  });
  wrapper.use(app);
  server = wrapper.listen(port, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  worker = setInterval(() => { if (webhookReady) auctions.tick().then(() => orders.tick()).catch((error) => logger.error("[test worker]", error.message)); }, 15000);
  const status = { url: `${base}/test-control`, auctionUrl: `${base}/auction.html?id=${id}`, pid: process.pid, listenerPid: listener.pid, runtime, databasePath, stripeMode: "test", printful: "disabled", googleSheets: "disabled" };
  fs.writeFileSync(path.join(runtime, "status.json"), JSON.stringify(status, null, 2));
  console.log(JSON.stringify(status));
}
main().catch((error) => { logger.error("[isolated test setup]", error.message); shutdown(); process.exitCode = 1; });
