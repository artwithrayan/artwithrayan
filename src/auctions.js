const crypto = require("node:crypto");
const validator = require("validator");
const { estimateOriginalDestinationShipping, hasOriginalShippingProfile } = require("./shipping");
const { logger } = require("./security");

const RULES_VERSION = "2026-10-07-v1";
const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
const token = () => crypto.randomBytes(32).toString("hex");
const escape = (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const dollars = (cents) => `$${(cents / 100).toFixed(2)} USD`;
function fail(message, statusCode = 400) { throw Object.assign(new Error(message), { statusCode }); }
function cents(value) {
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(String(value))) fail("Enter an amount with no more than two decimal places.");
  const amount = Math.round(Number(value) * 100);
  if (amount < 100 || amount > 10000000) fail("Bid must be between $1 and $100,000.");
  return amount;
}
function increment(price) { return price < 10000 ? 500 : price < 50000 ? 1000 : price < 100000 ? 2500 : 5000; }
function proxyPrice(start, maxima) {
  const sorted = [...maxima].sort((a, b) => b.max_cents - a.max_cents || (a.accepted_order ?? a.seq) - (b.accepted_order ?? b.seq));
  if (!sorted.length) return { price: start, winner: null };
  const second = sorted[1];
  return { winner: sorted[0], price: second ? Math.min(sorted[0].max_cents, Math.max(start, second.max_cents + increment(second.max_cents))) : start };
}

function createAuctionService({ db, stripe, email, orders, baseUrl, now = Date.now }) {
  const sql = db.sqlite;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS art_auctions (
      id TEXT PRIMARY KEY, original_id TEXT NOT NULL UNIQUE, start_cents INTEGER NOT NULL,
      starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      winner_entry TEXT, final_cents INTEGER, payment_id INTEGER, intent_id TEXT, checkout_id TEXT,
      checkout_url TEXT, recovery_deadline INTEGER, create_started INTEGER, checkout_started INTEGER,
      next_attempt INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auction_accounts (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, customer_id TEXT, blocked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS auction_logins (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auction_sessions (
      hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auction_entries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, auction_id TEXT NOT NULL,
      account_id TEXT NOT NULL, max_cents INTEGER NOT NULL, shipping_cents INTEGER NOT NULL,
      recipient_json TEXT NOT NULL, consent_text TEXT NOT NULL, rules_version TEXT NOT NULL,
      consent_at INTEGER, accepted_order INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'quote', setup_id TEXT, method_id TEXT, reason TEXT);
    CREATE INDEX IF NOT EXISTS auction_entries_rank ON auction_entries(auction_id,status,account_id);
    CREATE TABLE IF NOT EXISTS auction_mail (
      id TEXT PRIMARY KEY, recipient TEXT NOT NULL, subject TEXT NOT NULL, html TEXT NOT NULL,
      sent_at INTEGER, next_attempt INTEGER NOT NULL DEFAULT 0);
  `);
  if (!sql.prepare("PRAGMA table_info(auction_entries)").all().some((column) => column.name === "accepted_order")) sql.exec("ALTER TABLE auction_entries ADD COLUMN accepted_order INTEGER");
  let running = false;
  const get = (id) => sql.prepare("SELECT * FROM art_auctions WHERE id=?").get(id);
  const entry = (id) => sql.prepare("SELECT * FROM auction_entries WHERE id=?").get(id);
  const account = (id) => sql.prepare("SELECT * FROM auction_accounts WHERE id=?").get(id);
  const art = (a) => db.getOriginalById(a.original_id);
  const ready = () => Boolean(stripe && email.isEmailEnabled() && process.env.STRIPE_WEBHOOK_SECRET);
  function maxima(id) {
    return sql.prepare(`SELECT e.* FROM auction_entries e WHERE e.auction_id=? AND e.status='accepted'
      AND e.seq=(SELECT e2.seq FROM auction_entries e2 WHERE e2.auction_id=e.auction_id
      AND e2.account_id=e.account_id AND e2.status='accepted' ORDER BY e2.max_cents DESC,e2.seq ASC LIMIT 1)`).all(id);
  }
  function requireOpen(a) {
    if (!a) fail("Auction not found.", 404);
    if (a.status !== "open" || now() < a.starts_at || now() >= a.ends_at) fail("This auction is not open for bidding.", 409);
    if (art(a)?.status !== "active") fail("Bidding is unavailable for this artwork.", 409);
  }
  function queue(id, to, subject, text) {
    sql.prepare("INSERT OR IGNORE INTO auction_mail (id,recipient,subject,html) VALUES (?,?,?,?)")
      .run(id, to, subject, `<p>${escape(text).replaceAll("\n", "</p><p>")}</p><p><a href="${escape(baseUrl)}/originals.html">View originals</a></p>`);
  }
  function publicAuction(a, user) {
    if (!a) return null;
    const ranked = proxyPrice(a.start_cents, maxima(a.id));
    const mine = user ? maxima(a.id).find((e) => e.account_id === user.id) : null;
    const latest = user ? sql.prepare("SELECT status,reason FROM auction_entries WHERE auction_id=? AND account_id=? AND consent_at IS NOT NULL ORDER BY seq DESC LIMIT 1").get(a.id, user.id) : null;
    const isWinner = Boolean(user && (a.winner_entry ? entry(a.winner_entry)?.account_id === user.id : ranked.winner?.account_id === user.id));
    return {
      id: a.id, originalId: a.original_id, title: art(a)?.title, startCents: a.start_cents,
      currentCents: a.final_cents ?? ranked.price, minimumCents: ranked.winner ? ranked.price + increment(ranked.price) : a.start_cents,
      startsAt: a.starts_at, endsAt: a.ends_at, serverTime: now(),
      status: a.status === "open" ? (now() < a.starts_at ? "scheduled" : now() >= a.ends_at ? "closing" : "open") : a.status,
      bidCount: sql.prepare("SELECT count(*) AS n FROM auction_entries WHERE auction_id=? AND status='accepted'").get(a.id).n,
      biddingEnabled: ready(), rulesVersion: RULES_VERSION,
      ...(user ? { mine: mine ? { maxCents: mine.max_cents, shippingCents: mine.shipping_cents, leading: isWinner, recipient: JSON.parse(mine.recipient_json) } : null,
        latestBid: latest || null, checkoutUrl: isWinner ? a.checkout_url : null, paymentDeadline: isWinner ? a.recovery_deadline : null } : {})
    };
  }
  function configure(configs) {
    sql.transaction(() => {
      for (const config of configs) {
        if (!/^[a-z0-9-]{2,80}$/.test(config.id || "")) fail("Auction configuration needs a unique lowercase id.");
        if (get(config.id)) continue; // Never reset bids, extensions, or payment state on deploy.
        const original = db.getOriginalById(config.originalId);
        if (!original || original.status !== "active" || !hasOriginalShippingProfile(original.id)) fail("Auction requires an available original with a shipping profile.");
        const starts = Date.parse(config.startsAt), ends = Date.parse(config.endsAt);
        if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends <= now() || ends <= starts) fail("Auction dates must include a timezone and a future closing time.");
        if (!/[Zz]|[+-]\d\d:\d\d$/.test(config.startsAt) || !/[Zz]|[+-]\d\d:\d\d$/.test(config.endsAt)) fail("Auction dates need explicit timezones.");
        sql.prepare("INSERT INTO art_auctions (id,original_id,start_cents,starts_at,ends_at,created_at) VALUES (?,?,?,?,?,?)")
          .run(config.id, original.id, cents(config.startingPrice), starts, ends, now());
      }
    }).immediate();
  }
  const cancel = sql.transaction((id, reason) => {
    const a = get(id);
    if (!a || a.status !== "open") fail("Only an open auction can be cancelled. Payment-stage auctions require individual review.");
    if (String(reason || "").trim().length < 5) fail("Provide a cancellation reason for bidders.");
    sql.prepare("UPDATE art_auctions SET status='cancelled' WHERE id=?").run(id);
    for (const bidder of maxima(id)) queue(`cancel-${id}-${bidder.account_id}`, account(bidder.account_id).email,
      `Auction cancelled: ${art(a).title}`, `${String(reason).trim()}\nYou will not be charged for this auction.`);
    return publicAuction(get(id));
  });
  async function requestCode(address) {
    if (!ready()) fail("Auction registration is temporarily unavailable.", 503);
    const addressClean = String(address || "").trim().toLowerCase();
    if (!validator.isEmail(addressClean) || addressClean.length > 254) fail("Enter a valid email address.");
    const recent = sql.prepare("SELECT count(*) AS n FROM auction_logins WHERE email=? AND created_at>?").get(addressClean, now() - 900000);
    if (recent.n >= 3) fail("Please wait 15 minutes before requesting another email code.", 429);
    const id = crypto.randomUUID(), code = String(crypto.randomInt(100000, 1000000));
    sql.prepare("INSERT INTO auction_logins (id,email,code_hash,expires_at,created_at) VALUES (?,?,?,?,?)")
      .run(id, addressClean, hash(`${id}:${code}`), now() + 600000, now());
    const result = await email.sendEmail({ to: addressClean, subject: "Your Rayan Rao Art bidding code", html: `<p>Your code is <strong>${code}</strong>. It expires in 10 minutes. Do not share it.</p>`, idempotencyKey: `auction-login-${id}` });
    if (!result?.sent) fail("We could not send your code. Please try again later.", 503);
    return { challenge: id };
  }
  function verifyCode(id, code) {
    const challenge = sql.prepare("SELECT * FROM auction_logins WHERE id=?").get(String(id || ""));
    if (!challenge || challenge.used || challenge.expires_at <= now() || challenge.attempts >= 5) fail("Code expired or invalid. Request a new code.", 401);
    sql.prepare("UPDATE auction_logins SET attempts=attempts+1 WHERE id=?").run(id);
    if (hash(`${id}:${String(code)}`) !== challenge.code_hash) fail("Incorrect code.", 401);
    const session = token();
    sql.transaction(() => {
      sql.prepare("UPDATE auction_logins SET used=1 WHERE id=?").run(id);
      sql.prepare("INSERT OR IGNORE INTO auction_accounts (id,email) VALUES (?,?)").run(crypto.randomUUID(), challenge.email);
      const user = sql.prepare("SELECT * FROM auction_accounts WHERE email=?").get(challenge.email);
      if (user.blocked) fail("Bidding is unavailable for this account.", 403);
      sql.prepare("INSERT INTO auction_sessions VALUES (?,?,?)").run(hash(session), user.id, now() + 7 * 86400000);
    }).immediate();
    return session;
  }
  function authenticate(session) {
    if (!/^[a-f0-9]{64}$/.test(session || "")) return null;
    return sql.prepare(`SELECT a.* FROM auction_accounts a JOIN auction_sessions s ON s.account_id=a.id
      WHERE s.hash=? AND s.expires_at>? AND a.blocked=0`).get(hash(session), now()) || null;
  }
  function logout(session) { if (session) sql.prepare("DELETE FROM auction_sessions WHERE hash=?").run(hash(session)); }
  function quote(id, user, body) {
    const a = get(id); requireOpen(a);
    const max = cents(body.maximum);
    const state = String(body.state || "").toUpperCase();
    const estimate = estimateOriginalDestinationShipping(a.original_id, { country: body.country, state });
    if (estimate.requiresManualQuote) fail("Auction shipping is currently limited to the contiguous United States. Email for other destinations.");
    const recipient = { country_code: "US", state_code: state };
    for (const [key, source] of Object.entries({ name: "name", address1: "address1", address2: "address2", city: "city", zip: "postalCode" })) {
      recipient[key] = String(body[source] || "").trim();
      if (recipient[key].length > 150 || (key !== "address2" && recipient[key].length < 2)) fail("Enter your complete shipping name and address.");
    }
    if (!validator.isPostalCode(recipient.zip, "US")) fail("Enter a valid US ZIP code.");
    const ranked = proxyPrice(a.start_cents, maxima(a.id));
    const previous = maxima(a.id).find((e) => e.account_id === user.id);
    const minimum = previous && ranked.winner?.account_id === user.id ? previous.max_cents + 100 : ranked.winner ? ranked.price + increment(ranked.price) : a.start_cents;
    if (max < minimum) fail(`Your maximum bid must be at least ${dollars(minimum)}.`, 409);
    if (previous && JSON.stringify(recipient) !== previous.recipient_json) fail("Your shipping address is locked for this auction. Contact us before changing it.");
    const shipping = previous?.shipping_cents ?? Math.round(estimate.total * 100);
    const text = `I authorize Rayan Rao Art to save my card with Stripe and automatically charge it ONLY if I win ${art(a).title}. My maximum bid is ${dollars(max)}. Shipping and protective packing are fixed at ${dollars(shipping)}. The charge will be the final winning bid plus this shipping charge, never more than ${dollars(max + shipping)} in total. There is no buyer premium or added processing fee. I will not be charged for this auction if I do not win. I accept the auction rules (${RULES_VERSION}).`;
    const idQuote = crypto.randomUUID();
    sql.prepare(`INSERT INTO auction_entries (id,auction_id,account_id,max_cents,shipping_cents,recipient_json,consent_text,rules_version,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(idQuote, id, user.id, max, shipping, JSON.stringify(recipient), text, RULES_VERSION, now(), now() + 900000);
    return { quoteId: idQuote, maximumCents: max, shippingCents: shipping, maximumTotalCents: max + shipping, consentText: text, expiresAt: now() + 900000 };
  }
  const accept = sql.transaction((id, method) => {
    const e = entry(id);
    if (!e || e.status === "accepted" || e.status === "rejected") return e;
    if (!e.consent_at || !method || account(e.account_id)?.blocked) fail("Payment authorization is incomplete.", 409);
    const a = get(e.auction_id);
    let reason;
    try {
      requireOpen(a);
      const all = maxima(a.id), before = proxyPrice(a.start_cents, all);
      const own = all.find((b) => b.account_id === e.account_id);
      const minimum = own && before.winner?.account_id === e.account_id ? own.max_cents + 100 : before.winner ? before.price + increment(before.price) : a.start_cents;
      if (e.max_cents < minimum) fail("Bidding changed while your card was being verified. Review the new minimum and bid again.");
      if (own && (own.recipient_json !== e.recipient_json || own.shipping_cents !== e.shipping_cents)) fail("Shipping details changed. Review your bid again.");
      sql.prepare("UPDATE auction_entries SET status='accepted',method_id=?,accepted_order=(SELECT COALESCE(MAX(accepted_order),0)+1 FROM auction_entries) WHERE id=?").run(method, id);
      const after = proxyPrice(a.start_cents, maxima(a.id));
      if (before.winner?.account_id !== e.account_id && a.ends_at - now() < 120000) sql.prepare("UPDATE art_auctions SET ends_at=? WHERE id=?").run(now() + 120000, a.id);
      if (before.winner && before.winner.account_id !== after.winner.account_id) queue(`outbid-${id}`, account(before.winner.account_id).email, `You were outbid: ${art(a).title}`, "Another bidder is now leading. You have not been charged. Visit the auction to increase your maximum.");
      queue(`bid-${id}`, account(e.account_id).email, `Bid accepted: ${art(a).title}`, `${e.consent_text}\n${after.winner.account_id === e.account_id ? "You are currently leading." : "Another bidder's earlier maximum is higher or equal. You are not currently leading."}`);
      return entry(id);
    } catch (error) { if (!error.statusCode) throw error; reason = error.message; }
    sql.prepare("UPDATE auction_entries SET status='rejected',reason=? WHERE id=?").run(reason, id);
    queue(`rejected-${id}`, account(e.account_id).email, "Your bid was not accepted", `${reason} You have not been charged.`);
    return entry(id);
  });
  async function authorize(user, id, agreed) {
    if (!ready()) fail("Bidding is temporarily unavailable.", 503);
    let e = entry(id);
    if (!e || e.account_id !== user.id) fail("Bid review not found.", 404);
    if (agreed !== true) fail("Explicit payment authorization is required.");
    if (e.status === "accepted" || e.status === "rejected") return { status: e.status, reason: e.reason };
    requireOpen(get(e.auction_id));
    if (e.expires_at <= now()) fail("Your bid review expired. Calculate your total again.", 409);
    sql.prepare("UPDATE auction_entries SET consent_at=COALESCE(consent_at,?),status='authorizing' WHERE id=?").run(now(), id);
    user = account(user.id);
    const previous = maxima(e.auction_id).find((b) => b.account_id === user.id);
    if (previous?.method_id) { const accepted = accept.immediate(id, previous.method_id); return { status: accepted.status, reason: accepted.reason }; }
    if (!user.customer_id) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { auctionAccount: user.id } }, { idempotencyKey: `auction-customer-${user.id}` });
      sql.prepare("UPDATE auction_accounts SET customer_id=? WHERE id=?").run(customer.id, user.id);
      user = account(user.id);
    }
    const a = get(e.auction_id);
    const session = await stripe.checkout.sessions.create({ mode: "setup", customer: user.customer_id, payment_method_types: ["card"],
      setup_intent_data: { metadata: { flow: "art_auction_setup", entryId: id } },
      metadata: { flow: "art_auction_setup", entryId: id },
      custom_text: { submit: { message: e.consent_text } },
      success_url: `${baseUrl}/auction.html?id=${encodeURIComponent(a.id)}&returned=1`, cancel_url: `${baseUrl}/auction.html?id=${encodeURIComponent(a.id)}`
    }, { idempotencyKey: `auction-setup-${id}` });
    sql.prepare("UPDATE auction_entries SET setup_id=? WHERE id=?").run(session.id, id);
    return { checkoutUrl: session.url, status: "authorizing" };
  }
  async function completeSetup(session) {
    const e = entry(session.metadata?.entryId);
    if (!e || !e.consent_at || session.customer !== account(e.account_id)?.customer_id || session.mode !== "setup" || session.status !== "complete") fail("Invalid auction card setup.");
    if (e.setup_id && session.id !== e.setup_id) fail("Mismatched auction card setup.");
    if (["accepted", "rejected"].includes(e.status)) return e;
    const intent = await stripe.setupIntents.retrieve(session.setup_intent);
    if (intent.status !== "succeeded" || intent.customer !== session.customer || intent.usage !== "off_session" || intent.metadata?.entryId !== e.id || !intent.payment_method) fail("Card setup is not complete.");
    sql.prepare("UPDATE auction_entries SET setup_id=? WHERE id=?").run(session.id, e.id);
    return accept.immediate(e.id, typeof intent.payment_method === "string" ? intent.payment_method : intent.payment_method.id);
  }
  const expireSetup = sql.transaction((session) => {
    const e = entry(session.metadata?.entryId);
    if (!e || !e.consent_at || session.customer !== account(e.account_id)?.customer_id || session.mode !== "setup" || session.status !== "expired") fail("Invalid expired auction card setup.");
    if (e.setup_id !== session.id) fail("Mismatched auction card setup.");
    // A delayed or repeated expiration event must never undo an accepted bid.
    if (e.status !== "authorizing") return;
    const reason = "Card setup expired. This bid was not accepted and no payment was taken for it. Review your bid and try again while bidding is open.";
    sql.prepare("UPDATE auction_entries SET status='rejected',reason=? WHERE id=? AND status='authorizing'").run(reason, e.id);
    queue(`rejected-${e.id}`, account(e.account_id).email, "Your bid was not accepted", reason);
  });
  const close = sql.transaction((id) => {
    const a = get(id);
    if (!a || a.status !== "open" || now() < a.ends_at) return;
    const ranked = proxyPrice(a.start_cents, maxima(id));
    if (!ranked.winner) { sql.prepare("UPDATE art_auctions SET status='no_bids' WHERE id=?").run(id); return; }
    if (art(a)?.status !== "active") { sql.prepare("UPDATE art_auctions SET status='review' WHERE id=?").run(id); return; }
    const e = ranked.winner, user = account(e.account_id);
    const payment = db.createPayment({ kind: "original", originalId: a.original_id, stripeSessionId: `pending-auction-${id}`, checkoutUrl: "",
      customerName: JSON.parse(e.recipient_json).name, customerEmail: user.email, subtotalAmount: ranked.price / 100,
      shippingAmount: e.shipping_cents / 100, totalAmount: (ranked.price + e.shipping_cents) / 100, amount: (ranked.price + e.shipping_cents) / 100,
      shippingJson: { recipient: JSON.parse(e.recipient_json), auctionId: id, shippingPolicy: RULES_VERSION }, status: "pending" });
    sql.prepare("UPDATE art_auctions SET status='charging',winner_entry=?,final_cents=?,payment_id=? WHERE id=?").run(e.id, ranked.price, payment.id, id);
    sql.prepare("UPDATE originals SET status='auto_charge_processing',reservation_payment_id=? WHERE id=?").run(payment.id, a.original_id);
    for (const loser of maxima(id).filter((bid) => bid.account_id !== e.account_id)) queue(`lost-${id}-${loser.account_id}`, account(loser.account_id).email, `Auction ended: ${art(a).title}`, "You did not win this auction and will not be charged. Thank you for taking part.");
  });
  function total(a) { return a.final_cents + entry(a.winner_entry).shipping_cents; }
  const paid = sql.transaction((id, intent) => {
    const a = get(id);
    if (!a || a.status === "paid") return;
    const winner = entry(a.winner_entry);
    if (!winner || intent.status !== "succeeded" || intent.currency !== "usd" || intent.amount !== total(a) || intent.amount_received !== total(a)
      || intent.customer !== account(winner.account_id).customer_id || intent.metadata?.auctionId !== id) fail("Auction payment validation failed.");
    if (db.getPaidPaymentForOriginal(a.original_id)) fail("Original already has a paid order.");
    sql.prepare("UPDATE art_auctions SET status='paid',intent_id=?,checkout_url=NULL WHERE id=?").run(intent.id, id);
    sql.prepare("UPDATE payments SET status='paid',paid_at=CURRENT_TIMESTAMP,stripe_payment_intent_id=?,order_retry_at=0,sheet_update_needed=1 WHERE id=?").run(intent.id, a.payment_id);
    sql.prepare("UPDATE originals SET status='sold',reservation_payment_id=NULL WHERE id=?").run(a.original_id);
    queue(`paid-${id}`, account(winner.account_id).email, `You won ${art(a).title}`, `Your payment of ${dollars(total(a))} was successful: ${dollars(a.final_cents)} for the artwork and ${dollars(winner.shipping_cents)} for shipping and packing. Rayan will arrange shipment.`);
    queue(`owner-paid-${id}`, process.env.AUCTION_OWNER_EMAIL || "artwithrayan@gmail.com", `Auction paid: ${art(a).title}`, `Order ${a.payment_id} is paid for ${dollars(total(a))}. Shipping details are saved in your order records and will sync to Google Sheets. Fulfill this original yourself; it is not a Printful order.`);
  });
  async function recoverPayment(a, intent) {
    if (intent.status === "succeeded") { paid.immediate(a.id, intent); return; }
    if (intent.status === "processing") return;
    // Cancel the original intent before offering another payment route: never two collectible payments.
    if (intent.status !== "canceled") {
      const cancelled = await stripe.paymentIntents.cancel(intent.id, {}, { idempotencyKey: `auction-cancel-${a.id}` });
      if (cancelled.status !== "canceled") return;
    }
    sql.prepare("UPDATE art_auctions SET status='payment_required',recovery_deadline=COALESCE(recovery_deadline,?) WHERE id=?").run(now() + 86400000, a.id);
    a = get(a.id);
    if (!a.checkout_id && now() > a.recovery_deadline - 1800000) { sql.prepare("UPDATE art_auctions SET status='review' WHERE id=?").run(a.id); return; }
    if (!a.checkout_id) {
      if (a.checkout_started && now() - a.checkout_started > 23 * 3600000) { sql.prepare("UPDATE art_auctions SET status='review' WHERE id=?").run(a.id); return; }
      sql.prepare("UPDATE art_auctions SET checkout_started=COALESCE(checkout_started,?) WHERE id=?").run(now(), a.id);
      const session = await stripe.checkout.sessions.create({ mode: "payment", customer: account(entry(a.winner_entry).account_id).customer_id,
        payment_method_types: ["card"], line_items: [{ price_data: { currency: "usd", unit_amount: a.final_cents, product_data: { name: `${art(a).title} - winning bid` } }, quantity: 1 },
          { price_data: { currency: "usd", unit_amount: entry(a.winner_entry).shipping_cents, product_data: { name: "Shipping and protective packing" } }, quantity: 1 }],
        metadata: { flow: "art_auction_payment", auctionId: a.id }, payment_intent_data: { metadata: { flow: "art_auction_payment", auctionId: a.id } },
        expires_at: Math.floor(a.recovery_deadline / 1000), success_url: `${baseUrl}/auction.html?id=${encodeURIComponent(a.id)}`, cancel_url: `${baseUrl}/auction.html?id=${encodeURIComponent(a.id)}`
      }, { idempotencyKey: `auction-recovery-${a.id}` });
      sql.prepare("UPDATE art_auctions SET checkout_id=?,checkout_url=? WHERE id=?").run(session.id, session.url, a.id);
    }
    queue(`payment-needed-${a.id}`, account(entry(a.winner_entry).account_id).email, `Payment needed: ${art(a).title}`, `You won. Automatic payment could not complete. Sign in at ${baseUrl}/auction.html?id=${a.id} to pay ${dollars(total(a))} securely within 24 hours. You have not been charged successfully.`);
    queue(`owner-payment-needed-${a.id}`, process.env.AUCTION_OWNER_EMAIL || "artwithrayan@gmail.com", `Auction payment needs attention: ${art(a).title}`, "The winner has received a secure payment link. Do not ship until the order is marked paid. No other bidder will be charged automatically.");
  }
  async function settle(a) {
    if (a.status === "payment_required" && a.checkout_id) {
      const session = await stripe.checkout.sessions.retrieve(a.checkout_id);
      if (session.payment_status === "paid") paid.immediate(a.id, await stripe.paymentIntents.retrieve(session.payment_intent));
      else if (session.status === "expired") sql.prepare("UPDATE art_auctions SET status='unpaid',checkout_url=NULL WHERE id=?").run(a.id);
      return;
    }
    if (!a.intent_id) {
      if (a.create_started && now() - a.create_started > 23 * 3600000) { sql.prepare("UPDATE art_auctions SET status='review' WHERE id=?").run(a.id); return; }
      sql.prepare("UPDATE art_auctions SET create_started=COALESCE(create_started,?) WHERE id=?").run(now(), a.id);
      const winner = entry(a.winner_entry), recipient = JSON.parse(winner.recipient_json);
      if (a.final_cents > winner.max_cents || total(a) > winner.max_cents + winner.shipping_cents || !winner.consent_at) fail("Winning payment exceeds authorization.");
      const intent = await stripe.paymentIntents.create({ amount: total(a), currency: "usd", customer: account(winner.account_id).customer_id,
        payment_method: winner.method_id, payment_method_types: ["card"], receipt_email: account(winner.account_id).email,
        description: `Winning auction: ${art(a).title}`, metadata: { flow: "art_auction_payment", auctionId: a.id },
        shipping: { name: recipient.name, address: { line1: recipient.address1, line2: recipient.address2, city: recipient.city, state: recipient.state_code, postal_code: recipient.zip, country: "US" } }
      }, { idempotencyKey: `auction-intent-${a.id}` });
      sql.prepare("UPDATE art_auctions SET intent_id=? WHERE id=?").run(intent.id, a.id);
      a = get(a.id);
    }
    let intent = await stripe.paymentIntents.retrieve(a.intent_id);
    if (intent.status === "requires_confirmation") {
      try { intent = await stripe.paymentIntents.confirm(intent.id, { off_session: true }, { idempotencyKey: `auction-confirm-${a.id}` }); }
      catch (error) { if (!error.payment_intent) throw error; intent = await stripe.paymentIntents.retrieve(a.intent_id); }
    }
    if (intent.status === "succeeded") paid.immediate(a.id, intent);
    else if (["requires_action", "requires_payment_method", "canceled"].includes(intent.status)) await recoverPayment(a, intent);
  }
  async function webhook(event) {
    const object = event.data.object;
    if (object.metadata?.flow === "art_auction_setup") {
      if (event.type === "checkout.session.completed") await completeSetup(object);
      else if (event.type === "checkout.session.expired") expireSetup.immediate(object);
      return true;
    }
    if (object.metadata?.flow !== "art_auction_payment") return false;
    const a = get(object.metadata.auctionId);
    if (!a?.winner_entry) fail("Unknown auction payment.");
    if (event.type === "payment_intent.succeeded") {
      // The metadata is not enough: only accept an intent created by this settlement or its recovery checkout.
      if (object.id !== a.intent_id) {
        if (!a.checkout_id) fail("Unknown auction payment intent.");
        const session = await stripe.checkout.sessions.retrieve(a.checkout_id);
        if (session.payment_intent !== object.id) fail("Unknown auction recovery payment.");
      }
      paid.immediate(a.id, object);
    } else if (event.type === "checkout.session.completed" && object.payment_status === "paid") {
      if (object.id !== a.checkout_id) fail("Unknown recovery checkout.");
      paid.immediate(a.id, await stripe.paymentIntents.retrieve(object.payment_intent));
    }
    if (get(a.id).status === "paid") await orders.processPayment(a.payment_id);
    return true;
  }
  async function refreshSetup(user, id) {
    const pending = sql.prepare("SELECT * FROM auction_entries WHERE account_id=? AND auction_id=? AND status='authorizing' AND setup_id IS NOT NULL ORDER BY seq DESC LIMIT 3").all(user.id, id);
    for (const e of pending) {
      const session = await stripe.checkout.sessions.retrieve(e.setup_id);
      if (session.status === "complete") await completeSetup(session);
      else if (session.status === "expired") expireSetup.immediate(session);
    }
  }
  async function tick() {
    if (running || !stripe) return;
    running = true;
    try {
      for (const a of sql.prepare("SELECT id FROM art_auctions WHERE status='open' AND ends_at<=?").all(now())) close.immediate(a.id);
      for (const a of sql.prepare("SELECT * FROM art_auctions WHERE status IN ('charging','payment_required') AND next_attempt<=?").all(now())) {
        sql.prepare("UPDATE art_auctions SET next_attempt=? WHERE id=?").run(now() + 60000, a.id);
        try { await settle(a); } catch (error) {
          logger.error(`[auction settlement] ${a.id}: ${error.message}`);
          queue(`owner-settlement-${a.id}`, process.env.AUCTION_OWNER_EMAIL || "artwithrayan@gmail.com", `Auction settlement delayed: ${art(a).title}`,
            "Payment processing encountered a problem and will retry safely. Do not ship or create a separate charge. Check the auction status and Stripe payment before intervening.");
        }
      }
      for (const a of sql.prepare("SELECT * FROM art_auctions WHERE status IN ('review','unpaid','no_bids')").all()) queue(`owner-${a.status}-${a.id}`, process.env.AUCTION_OWNER_EMAIL || "artwithrayan@gmail.com", `Auction ${a.status.replaceAll("_", " ")}: ${art(a).title}`, "This auction needs no further automatic charge. Review it before relisting or arranging another sale.");
      for (const mail of sql.prepare("SELECT * FROM auction_mail WHERE sent_at IS NULL AND next_attempt<=? LIMIT 30").all(now())) {
        sql.prepare("UPDATE auction_mail SET next_attempt=? WHERE id=?").run(now() + 300000, mail.id);
        try {
          const result = await email.sendEmail({ to: mail.recipient, subject: mail.subject, html: mail.html, idempotencyKey: `auction-mail-${mail.id}` });
          if (result?.sent) sql.prepare("UPDATE auction_mail SET sent_at=? WHERE id=?").run(now(), mail.id);
        } catch (error) { logger.error(`[auction email] ${error.message}`); }
      }
      sql.prepare("DELETE FROM auction_sessions WHERE expires_at<?").run(now());
      sql.prepare("DELETE FROM auction_logins WHERE expires_at<?").run(now() - 86400000);
      sql.prepare("DELETE FROM auction_entries WHERE status='quote' AND expires_at<?").run(now() - 86400000);
    } finally { running = false; }
  }
  return { configure, cancel: (id, reason) => cancel.immediate(id, reason), get, publicAuction, requestCode, verifyCode, authenticate, logout, quote, authorize, completeSetup, refreshSetup, webhook, tick,
    forOriginal: (id) => publicAuction(sql.prepare("SELECT * FROM art_auctions WHERE original_id=? AND status NOT IN ('cancelled','no_bids')").get(id)),
    list: () => sql.prepare("SELECT * FROM art_auctions ORDER BY created_at DESC").all().map((a) => publicAuction(a)) };
}
module.exports = { createAuctionService, proxyPrice, increment, cents, RULES_VERSION };
