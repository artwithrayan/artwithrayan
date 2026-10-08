const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const f = require("./fixture.cjs");
const { createAuctionService, proxyPrice, cents } = require("../src/auctions");
let service, clock, sdk, calls, sessions, intents, setups, messages;
beforeEach(() => {
  f.sql.exec("DELETE FROM auction_mail; DELETE FROM auction_entries; DELETE FROM art_auctions; DELETE FROM auction_sessions; DELETE FROM auction_logins; DELETE FROM auction_accounts; DELETE FROM payments;");
  f.sql.prepare("UPDATE originals SET status='active', reservation_payment_id=NULL WHERE id='the-light'").run();
  clock = Date.parse("2026-10-07T12:00:00Z");
  calls = { creates: 0, charges: 0, cancelled: 0, checkouts: 0, orders: 0 };
  sessions = new Map(); intents = new Map(); setups = new Map(); messages = [];
  sdk = {
    customers: { create: async ({ email }) => ({ id: `cus_${email}` }) },
    checkout: { sessions: {
      create: async (config, options) => {
        if (config.mode === "setup") {
          assert.deepEqual(Object.keys(config.setup_intent_data), ["metadata"], "Checkout only accepts its documented SetupIntent subset");
          assert.ok(config.custom_text.submit.message.length <= 1200);
        }
        if (sessions.has(options.idempotencyKey)) return sessions.get(options.idempotencyKey);
        calls.checkouts++;
        const result = { ...config, id: `cs_auction_${calls.checkouts}`, url: "https://checkout.stripe.com/test", status: "open", payment_status: "unpaid" };
        if (config.mode === "setup") {
          result.setup_intent = `seti_${calls.checkouts}`;
          setups.set(result.setup_intent, { status: "succeeded", usage: "off_session", customer: config.customer, payment_method: `pm_${calls.checkouts}`, metadata: config.setup_intent_data.metadata });
        }
        sessions.set(result.id, result); sessions.set(options.idempotencyKey, result);
        return result;
      }, retrieve: async (id) => sessions.get(id)
    } },
    setupIntents: { retrieve: async (id) => setups.get(id) },
    paymentIntents: {
      create: async (config) => { calls.creates++; const pi = { ...config, id: `pi_auction_${calls.creates}`, status: "requires_confirmation" }; intents.set(pi.id, pi); return pi; },
      retrieve: async (id) => intents.get(id),
      confirm: async (id) => { calls.charges++; const pi = intents.get(id); pi.status = "succeeded"; pi.amount_received = pi.amount; return pi; },
      cancel: async (id) => { calls.cancelled++; const pi = intents.get(id); pi.status = "canceled"; return pi; }
    }
  };
  service = createAuctionService({ db: f.db, stripe: sdk, email: { isEmailEnabled: () => true, sendEmail: async (mail) => { messages.push(mail); return { sent: true }; } }, orders: { processPayment: async () => { calls.orders++; } }, baseUrl: "https://example.test", now: () => clock });
  service.configure([{ id: "light-test", originalId: "the-light", startingPrice: 300, startsAt: new Date(clock - 1000).toISOString(), endsAt: new Date(clock + 600000).toISOString() }]);
});
after(() => { f.sql.close(); });
async function user(email) {
  const result = await service.requestCode(email);
  const code = messages.at(-1).html.match(/<strong>(\d+)<\/strong>/)[1];
  const session = service.verifyCode(result.challenge, code);
  return service.authenticate(session);
}
function body(maximum = 500) { return { maximum, name: "Test Buyer", country: "US", state: "NC", address1: "123 Main Street", address2: "", city: "Raleigh", postalCode: "27601" }; }
async function bid(buyer, maximum) {
  const quote = service.quote("light-test", buyer, body(maximum));
  const authorization = await service.authorize(buyer, quote.quoteId, true);
  if (authorization.checkoutUrl) {
    const row = f.sql.prepare("SELECT * FROM auction_entries WHERE id=?").get(quote.quoteId);
    const session = sessions.get(row.setup_id); session.status = "complete";
    await service.completeSetup(session);
  }
  return quote;
}
test("money and proxy bidding keep maximums private and resolve equal bids by acceptance order", () => {
  assert.equal(cents("123.45"), 12345);
  for (const value of ["1e4", -1, "3.001", NaN, "100001"]) assert.throws(() => cents(value));
  assert.equal(proxyPrice(30000, [{ max_cents: 50000, seq: 1 }]).price, 30000);
  assert.equal(proxyPrice(30000, [{ max_cents: 50000, seq: 1 }, { max_cents: 45000, seq: 2 }]).price, 46000);
  assert.equal(proxyPrice(30000, [{ max_cents: 50000, seq: 1, accepted_order: 2 }, { max_cents: 50000, seq: 2, accepted_order: 1 }]).winner.seq, 2);
});
test("email codes are one-use, expire, and stop after five incorrect attempts", async () => {
  const { challenge } = await service.requestCode("verify@example.com");
  const code = messages.at(-1).html.match(/<strong>(\d+)<\/strong>/)[1];
  for (let i = 0; i < 5; i++) assert.throws(() => service.verifyCode(challenge, "000000"));
  assert.throws(() => service.verifyCode(challenge, code));
  const next = await service.requestCode("second@example.com");
  const correct = messages.at(-1).html.match(/<strong>(\d+)<\/strong>/)[1];
  const session = service.verifyCode(next.challenge, correct);
  assert.equal(service.authenticate(session).email, "second@example.com");
  assert.throws(() => service.verifyCode(next.challenge, correct));
  assert.equal(service.authenticate("arbitrary"), null);
  clock += 8 * 86400000;
  assert.equal(service.authenticate(session), null);
});
test("server locks shipping, computes authorized total, and requires explicit consent and ownership", async () => {
  const alice = await user("alice@example.com"), bob = await user("bob@example.com");
  const quote = service.quote("light-test", alice, { ...body(500), shippingCents: 1, total: 1 });
  assert.equal(quote.shippingCents, 4500); assert.equal(quote.maximumTotalCents, 54500);
  assert.match(quote.consentText, /ONLY if I win/); assert.match(quote.consentText, /545.00/);
  await assert.rejects(service.authorize(alice, quote.quoteId, false), /Explicit/);
  await assert.rejects(service.authorize(bob, quote.quoteId, true), /not found/);
  assert.throws(() => service.quote("light-test", alice, { ...body(), state: "HI" }), /contiguous/);
  assert.throws(() => service.quote("light-test", alice, { ...body(), postalCode: "bad" }), /ZIP/);
  clock += 900001;
  await assert.rejects(service.authorize(alice, quote.quoteId, true));
  assert.equal(calls.charges, 0);
});
test("saving a card admits the bid only after verified Stripe setup; duplicates are harmless", async () => {
  const alice = await user("alice@example.com");
  const quote = service.quote("light-test", alice, body());
  await service.authorize(alice, quote.quoteId, true);
  const e = f.sql.prepare("SELECT * FROM auction_entries WHERE id=?").get(quote.quoteId);
  const session = sessions.get(e.setup_id);
  await assert.rejects(service.completeSetup(session), /Invalid/);
  session.status = "complete";
  await assert.rejects(service.completeSetup({ ...session, customer: "someone_else" }), /Invalid/);
  await service.completeSetup(session); await service.completeSetup(session);
  assert.equal(service.publicAuction(service.get("light-test")).bidCount, 1);
  assert.equal(service.publicAuction(service.get("light-test")).mine, undefined);
  assert.equal(calls.charges, 0);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM payments").get().n, 0);
});
test("expired setup webhooks reject only the unfinished bid and allow a fresh review", async () => {
  const alice = await user("alice@example.com");
  const quote = service.quote("light-test", alice, body());
  await service.authorize(alice, quote.quoteId, true);
  const row = f.sql.prepare("SELECT * FROM auction_entries WHERE id=?").get(quote.quoteId);
  const session = sessions.get(row.setup_id); session.status = "expired";
  const event = { type: "checkout.session.expired", data: { object: session } };
  await service.webhook(event); await service.webhook(event);
  const state = service.publicAuction(service.get("light-test"), alice);
  assert.equal(state.latestBid.status, "rejected");
  assert.match(state.latestBid.reason, /Card setup expired.*try again/);
  assert.equal(state.bidCount, 0);
  assert.equal((await service.authorize(alice, quote.quoteId, true)).status, "rejected");
  assert.equal(calls.charges, 0);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM auction_mail WHERE id=?").get(`rejected-${quote.quoteId}`).n, 1);
  await bid(alice, 500);
  assert.equal(service.publicAuction(service.get("light-test"), alice).latestBid.status, "accepted");
  assert.equal(calls.checkouts, 2);
  assert.equal(calls.charges, 0);
});

test("refresh detects expired setup when its webhook was missed", async () => {
  const alice = await user("alice@example.com");
  const quote = service.quote("light-test", alice, body());
  await service.authorize(alice, quote.quoteId, true);
  const row = f.sql.prepare("SELECT * FROM auction_entries WHERE id=?").get(quote.quoteId);
  sessions.get(row.setup_id).status = "expired";
  await service.refreshSetup(alice, "light-test");
  assert.equal(service.publicAuction(service.get("light-test"), alice).latestBid.status, "rejected");
  assert.equal(calls.charges, 0);
});

test("unrelated expiration events cannot reject a bidder's setup", async () => {
  const alice = await user("alice@example.com");
  const quote = service.quote("light-test", alice, body());
  await service.authorize(alice, quote.quoteId, true);
  const row = f.sql.prepare("SELECT * FROM auction_entries WHERE id=?").get(quote.quoteId);
  const session = { ...sessions.get(row.setup_id), status: "expired" };
  for (const changes of [{ id: "cs_other" }, { customer: "cus_other" }, { mode: "payment" }, { status: "open" }]) {
    await assert.rejects(service.webhook({ type: "checkout.session.expired", data: { object: { ...session, ...changes } } }));
    assert.equal(service.publicAuction(service.get("light-test"), alice).latestBid.status, "authorizing");
  }
});

test("late expiration cannot remove an accepted bid or revive a rejected one", async () => {
  const alice = await user("alice@example.com");
  const quote = await bid(alice, 500);
  const row = f.sql.prepare("SELECT * FROM auction_entries WHERE id=?").get(quote.quoteId);
  const session = sessions.get(row.setup_id);
  await service.webhook({ type: "checkout.session.expired", data: { object: { ...session, status: "expired" } } });
  assert.equal(service.publicAuction(service.get("light-test"), alice).bidCount, 1);
  assert.equal(service.publicAuction(service.get("light-test"), alice).latestBid.status, "accepted");
  const bob = await user("bob@example.com");
  const otherQuote = service.quote("light-test", bob, body(550));
  await service.authorize(bob, otherQuote.quoteId, true);
  const other = sessions.get(f.sql.prepare("SELECT setup_id FROM auction_entries WHERE id=?").get(otherQuote.quoteId).setup_id);
  await service.webhook({ type: "checkout.session.expired", data: { object: { ...other, status: "expired" } } });
  await service.completeSetup({ ...other, status: "complete" });
  assert.equal(service.publicAuction(service.get("light-test"), bob).latestBid.status, "rejected");
  assert.equal(service.publicAuction(service.get("light-test")).bidCount, 1);
  assert.equal(calls.charges, 0);
});

test("only the winner is charged the final bid plus accepted shipping, once", async () => {
  const alice = await user("alice@example.com"), bob = await user("bob@example.com");
  await bid(alice, 500); await bid(bob, 450);
  await service.tick(); assert.equal(calls.charges, 0);
  clock += 600001;
  await service.tick(); await service.tick();
  assert.equal(calls.creates, 1); assert.equal(calls.charges, 1);
  const pi = [...intents.values()][0];
  assert.equal(pi.customer, "cus_alice@example.com"); assert.equal(pi.amount, 50500);
  assert.equal(service.get("light-test").status, "paid");
  assert.equal(f.db.getOriginalById("the-light").status, "sold");
  assert.equal(f.sql.prepare("SELECT * FROM payments").get().shipping_amount, 45);
  await service.webhook({ type: "payment_intent.succeeded", data: { object: pi } });
  assert.equal(f.sql.prepare("SELECT count(*) n FROM payments").get().n, 1);
});
test("last minute competition extends closing; own maximum increase does not", async () => {
  const alice = await user("alice@example.com"), bob = await user("bob@example.com");
  await bid(alice, 500);
  const originalEnd = service.get("light-test").ends_at;
  clock += 550000;
  await bid(alice, 600);
  assert.equal(service.get("light-test").ends_at, originalEnd);
  await bid(bob, 450);
  assert.equal(service.get("light-test").ends_at, clock + 120000);
  assert.throws(() => service.quote("light-test", alice, { ...body(650), city: "Charlotte" }), /locked/);
});
test("late card setup cannot insert a bid after closing", async () => {
  const alice = await user("alice@example.com");
  const quote = service.quote("light-test", alice, body());
  await service.authorize(alice, quote.quoteId, true);
  const e = f.sql.prepare("SELECT * FROM auction_entries WHERE id=?").get(quote.quoteId);
  const session = sessions.get(e.setup_id); session.status = "complete";
  clock += 600001;
  const result = await service.completeSetup(session);
  assert.equal(result.status, "rejected");
  await service.tick(); assert.equal(service.get("light-test").status, "no_bids"); assert.equal(calls.charges, 0);
});
test("a lost successful confirmation is recovered without a second charge", async () => {
  const alice = await user("alice@example.com"); await bid(alice, 500);
  sdk.paymentIntents.confirm = async (id) => { calls.charges++; const pi = intents.get(id); pi.status = "succeeded"; pi.amount_received = pi.amount; throw new Error("Connection lost after confirmation"); };
  clock += 600001; await service.tick();
  assert.equal(service.get("light-test").status, "charging");
  clock += 60001; await service.tick();
  assert.equal(service.get("light-test").status, "paid"); assert.equal(calls.charges, 1); assert.equal(calls.creates, 1);
});
test("failed winning payment is cancelled before a recovery checkout, never charged to a loser", async () => {
  const alice = await user("alice@example.com"), bob = await user("bob@example.com");
  await bid(alice, 500); await bid(bob, 450);
  sdk.paymentIntents.confirm = async (id) => { calls.charges++; const pi = intents.get(id); pi.status = "requires_action"; return pi; };
  clock += 600001; await service.tick();
  let a = service.get("light-test");
  assert.equal(a.status, "payment_required"); assert.equal(calls.cancelled, 1);
  assert.equal(intents.get(a.intent_id).status, "canceled");
  const session = sessions.get(a.checkout_id);
  assert.equal(session.line_items.reduce((sum, item) => sum + item.price_data.unit_amount, 0), 50500);
  assert.equal(service.publicAuction(a, bob).checkoutUrl, null);
  assert.ok(service.publicAuction(a, alice).checkoutUrl);
  session.status = "expired"; clock += 86400001; await service.tick();
  assert.equal(service.get("light-test").status, "unpaid"); assert.equal(calls.charges, 1);
  assert.notEqual(f.db.getOriginalById("the-light").status, "sold");
});
test("an unknown successful payment or an incorrect total cannot mark an auction paid", async () => {
  const alice = await user("alice@example.com"); await bid(alice, 500);
  sdk.paymentIntents.confirm = async (id) => { const pi = intents.get(id); pi.status = "processing"; return pi; };
  clock += 600001; await service.tick();
  const a = service.get("light-test"), pi = intents.get(a.intent_id);
  await assert.rejects(service.webhook({ type: "payment_intent.succeeded", data: { object: { ...pi, id: "pi_other", status: "succeeded" } } }), /Unknown/);
  await assert.rejects(service.webhook({ type: "payment_intent.succeeded", data: { object: { ...pi, status: "succeeded", amount: 1, amount_received: 1 } } }), /validation/);
  assert.equal(service.get("light-test").status, "charging");
});
test("configuration never overwrites existing auction bids or dates on restart", async () => {
  await bid(await user("alice@example.com"), 500);
  const existing = service.get("light-test");
  service.configure([{ id: "light-test", startingPrice: 1, startsAt: "invalid", endsAt: "invalid" }]);
  assert.deepEqual(service.get("light-test"), existing);
});
test("checkout cleanup never cancels a pending auction settlement or winner reservation", async () => {
  await bid(await user("alice@example.com"), 500);
  sdk.paymentIntents.confirm = async (id) => { const pi = intents.get(id); pi.status = "processing"; return pi; };
  clock += 600001; await service.tick();
  const auction = service.get("light-test");
  f.sql.prepare("UPDATE payments SET created_at=datetime('now','-2 hours') WHERE id=?").run(auction.payment_id);
  f.db.releaseStaleCheckoutReservations();
  assert.equal(f.db.getPaymentById(auction.payment_id).status, "pending");
  assert.equal(f.db.getOriginalById("the-light").status, "auto_charge_processing");
});
test("owner cancellation informs bidders and prevents later setup or charging", async () => {
  const alice = await user("alice@example.com"); await bid(alice, 500);
  assert.throws(() => service.cancel("light-test", ""), /reason/);
  service.cancel("light-test", "Artwork is no longer available for auction.");
  assert.equal(service.get("light-test").status, "cancelled");
  assert.equal(service.forOriginal("the-light"), null);
  assert.throws(() => service.quote("light-test", alice, body(600)), /not open/);
  clock += 600001; await service.tick();
  assert.equal(calls.charges, 0);
  assert.ok(messages.some((mail) => /Auction cancelled/.test(mail.subject)));
});
test("an uncertain intent creation older than the idempotency window requires manual review", async () => {
  await bid(await user("alice@example.com"), 500);
  sdk.paymentIntents.create = async () => { calls.creates++; throw new Error("Uncertain creation outcome"); };
  clock += 600001; await service.tick();
  clock += 24 * 3600000; await service.tick();
  assert.equal(calls.creates, 1);
  assert.equal(service.get("light-test").status, "review");
  assert.ok(messages.some((mail) => /settlement delayed/.test(mail.subject)));
});
test("recovery Checkout completion records the same winner and total exactly once", async () => {
  const alice = await user("alice@example.com"); await bid(alice, 500);
  sdk.paymentIntents.confirm = async (id) => { const pi = intents.get(id); pi.status = "requires_payment_method"; return pi; };
  clock += 600001; await service.tick();
  const a = service.get("light-test"), session = sessions.get(a.checkout_id);
  const recovery = { id: "pi_recovery", status: "succeeded", customer: "cus_alice@example.com", amount: 34500, amount_received: 34500, currency: "usd", metadata: session.metadata };
  intents.set(recovery.id, recovery);
  session.payment_intent = recovery.id; session.payment_status = "paid"; session.status = "complete";
  await service.webhook({ type: "checkout.session.completed", data: { object: session } });
  await service.webhook({ type: "payment_intent.succeeded", data: { object: recovery } });
  assert.equal(service.get("light-test").status, "paid");
  assert.equal(f.db.getPaymentById(a.payment_id).total_amount, 345);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM payments WHERE status='paid'").get().n, 1);
});
