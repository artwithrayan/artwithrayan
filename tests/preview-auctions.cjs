// Isolated local demo only. The fixture replaces payment, fulfillment and email providers.
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const express = require("express");
const port = Number(process.env.PREVIEW_PORT || 3115);
process.env.TEST_BASE_URL = `http://localhost:${port}`;
const f = require("./fixture.cjs");
const email = require("../src/email");
email.isEmailEnabled = () => true;
email.sendEmail = async () => ({ sent: true });
const requestCode = f.auctions.requestCode;
f.auctions.requestCode = async (address) => {
  const result = await requestCode(address);
  f.sql.prepare("UPDATE auction_logins SET code_hash=? WHERE id=?").run(crypto.createHash("sha256").update(`${result.challenge}:123456`).digest("hex"), result.challenge);
  return result;
};
const authorize = f.auctions.authorize;
f.auctions.authorize = async (...args) => {
  const result = await authorize(...args);
  if (result.checkoutUrl) {
    const entry = f.sql.prepare("SELECT setup_id FROM auction_entries WHERE id=?").get(args[1]);
    result.checkoutUrl = `/demo-card/${entry.setup_id}`;
  }
  return result;
};
f.auctions.configure([{ id: "light-demo", originalId: "the-light", startingPrice: 300, startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: new Date(Date.now() + 7 * 86400000).toISOString() }]);
const preview = express();
preview.get(["/auction.html", "/originals.html"], (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", req.path.slice(1)), "utf8");
  res.type("html").send(html.replace("<body>", '<body><div style="padding:12px;background:#fff4cc;color:#222;text-align:center">Local demo only. Example prices. No emails or charges. Use email code <strong>123456</strong>; do not enter real card details.</div>'));
});
preview.get("/demo-card/:id", (req, res) => {
  if (!f.sessions.has(req.params.id)) return res.sendStatus(404);
  res.type("html").send(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><title>Demo Card Setup</title></head><body><main class="auction-rules"><h1>Simulated card setup</h1><p>No card details or payments are collected. On the real website, this step is hosted securely by Stripe.</p><form method="post"><button type="submit">Finish simulated card setup</button></form></main></body></html>`);
});
preview.post("/demo-card/:id", async (req, res) => {
  const session = f.sessions.get(req.params.id);
  if (!session) return res.sendStatus(404);
  session.status = "complete";
  await f.auctions.completeSetup(session);
  res.redirect("/auction.html?id=light-demo&returned=1");
});
preview.use(f.app);
// No settlement worker is started in this demo.
preview.listen(port, "127.0.0.1", () => console.log(`Isolated auction demo: http://localhost:${port}/auction.html?id=light-demo (code 123456)`));
