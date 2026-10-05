const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const f = require("./fixture.cjs");
let server;
let base;
before(async () => {
  server = f.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); f.sql.close(); });

async function webhook(type, object) {
  const signed = f.signedEvent(type, object);
  return fetch(`${base}/api/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": signed.signature }, body: signed.payload });
}

test("payment records preserve cents", () => {
  const payment = f.payment("cs_cents");
  assert.equal(payment.total_amount, 21.75);
  assert.equal(payment.shipping_amount, 4.99);
});

test("unpaid completed events do not mark paid or fulfill", async () => {
  const payment = f.payment("cs_unpaid");
  const before = f.calls.drafts;
  assert.equal((await webhook("checkout.session.completed", { ...f.sessions.get("cs_unpaid"), payment_status: "unpaid" })).status, 200);
  assert.equal(f.db.getPaymentById(payment.id).status, "pending");
  assert.equal(f.calls.drafts, before);
});

test("Sheets retries independently after a saved Printful draft", async () => {
  const payment = f.payment("cs_sheet_retry");
  f.failures.sheets = true;
  assert.equal((await webhook("checkout.session.completed", f.sessions.get("cs_sheet_retry"))).status, 503);
  assert.ok(f.db.getPaymentById(payment.id).printful_order_id);
  const drafts = f.calls.drafts;
  f.failures.sheets = false;
  assert.equal((await webhook("checkout.session.completed", f.sessions.get("cs_sheet_retry"))).status, 200);
  assert.ok(f.db.getPaymentById(payment.id).google_sheets_synced_at);
  assert.equal(f.calls.drafts, drafts);
});

test("Printful failures remain queued, still reach Sheets, and recover without another payment", async () => {
  const payment = f.payment("cs_draft_retry");
  f.failures.drafts = true;
  assert.equal((await webhook("checkout.session.completed", f.sessions.get("cs_draft_retry"))).status, 503);
  const failed = f.db.getPaymentById(payment.id);
  assert.ok(failed.google_sheets_synced_at);
  assert.equal(failed.printful_order_id, null);
  assert.ok(failed.order_retry_at > Date.now());
  f.failures.drafts = false;
  f.sql.prepare("UPDATE payments SET order_retry_at=0 WHERE id=?").run(payment.id);
  await f.orders.tick();
  assert.ok(f.db.getPaymentById(payment.id).printful_order_id);
  assert.equal(f.db.getPaymentById(payment.id).order_processing_error, null);
});

test("duplicate paid events do not duplicate fulfillment or sheet updates", async () => {
  f.payment("cs_duplicate");
  const event = f.sessions.get("cs_duplicate");
  await webhook("checkout.session.completed", event);
  const before = { ...f.calls };
  await Promise.all([webhook("checkout.session.completed", event), webhook("checkout.session.completed", event)]);
  assert.equal(f.calls.drafts, before.drafts);
  assert.equal(f.calls.sheets, before.sheets);
});

test("an old cancelled expiration does not release the current original reservation", async () => {
  f.db.markOriginalStatus("the-light", "active");
  f.payment("cs_old_original", "original", { status: "cancelled" });
  assert.ok(f.db.reserveOriginalCheckout("the-light"));
  const current = f.payment("cs_current_original", "original");
  f.db.setOriginalReservationOwner("the-light", current.id);
  await webhook("checkout.session.expired", { id: "cs_old_original" });
  assert.equal(f.db.getOriginalById("the-light").status, "payment_pending");
  assert.equal(f.db.getPaymentById(current.id).status, "pending");
  await webhook("checkout.session.expired", { id: "cs_current_original" });
  assert.equal(f.db.getOriginalById("the-light").status, "active");
});

test("late payment conflicting with a new reservation is refunded rather than selling twice", async () => {
  const old = f.payment("cs_late_old", "original", { status: "cancelled" });
  assert.ok(f.db.reserveOriginalCheckout("the-light"));
  const current = f.payment("cs_late_current", "original");
  f.db.setOriginalReservationOwner("the-light", current.id);
  assert.equal((await webhook("checkout.session.completed", f.sessions.get("cs_late_old"))).status, 200);
  assert.equal(f.db.getPaymentById(old.id).status, "refunded");
  assert.equal(f.db.getOriginalById("the-light").status, "payment_pending");
  assert.equal(f.db.getPaymentById(current.id).status, "pending");
  f.db.cancelCheckoutReservation("cs_late_current");
});

test("refunded historical payments are never turned into new Printful orders", async () => {
  const payment = f.payment("cs_historical_refund", "print", { status: "paid" });
  f.sessions.get("cs_historical_refund").payment_intent.latest_charge.refunded = true;
  const before = f.calls.drafts;
  await f.orders.processPayment(payment.id);
  assert.equal(f.calls.drafts, before);
  assert.equal(f.db.getPaymentById(payment.id).status, "refunded");
});

test("tracking failures retry and duplicate shipment events do not send twice", async () => {
  const payment = f.payment("cs_tracking", "print", { status: "paid" });
  f.db.setPaymentPrintfulOrderId(payment.id, "tracking-order");
  const body = { type: "package_shipped", data: { order: { id: "tracking-order" }, shipment: { tracking_number: "TRACK123", tracking_url: "https://example.invalid/tracking" } } };
  const send = () => fetch(`${base}/api/printful/webhook?token=test-printful`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  f.failures.emails = true;
  assert.equal((await send()).status, 503);
  assert.equal(f.db.getPaymentById(payment.id).tracking_email_sent_at, null);
  f.failures.emails = false;
  assert.equal((await send()).status, 200);
  assert.ok(f.db.getPaymentById(payment.id).tracking_email_sent_at);
  const before = f.calls.emails;
  await send();
  assert.equal(f.calls.emails, before);
});

test("checkout validates totals, preserves cents, and restricts to immediate card payments", async () => {
  const body = { name: "Test Buyer", email: "test@example.com", address1: "1 E Edenton St", city: "Raleigh", state: "NC", postalCode: "27601", country: "US", expectedTotal: 1 };
  let response = await fetch(`${base}/api/prints/test-small/checkout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 409);
  body.expectedTotal = 21.75;
  response = await fetch(`${base}/api/prints/test-small/checkout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  const session = f.sessions.get(`cs_test_${f.calls.checkouts}`);
  assert.deepEqual(session.payment_method_types, ["card"]);
  assert.equal(session.amount_total, 2175);
  assert.equal(f.db.getPaymentByStripeSessionId(session.id).checkout_expires_at, session.expires_at);
});

test("unsigned Stripe and unauthorized Printful webhooks remain rejected", async () => {
  assert.equal((await fetch(`${base}/api/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 400);
  assert.equal((await fetch(`${base}/api/printful/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
});

test("original listings use base prices and provide the inquiry address", async () => {
  const catalog = await (await fetch(`${base}/api/originals`)).json();
  assert.equal(catalog.inquiryEmail, "artwithrayan@gmail.com");
  for (const art of catalog.originals) {
    assert.equal(art.price, f.db.getOriginalById(art.id).price);
  }
  const detail = await (await fetch(`${base}/api/originals/the-light`)).json();
  assert.equal(detail.original.price, f.db.getOriginalById("the-light").price);
  assert.equal(detail.inquiryEmail, catalog.inquiryEmail);
});

test("original checkout and shipping endpoints cannot create orders or reservations", async () => {
  const paymentsBefore = f.sql.prepare("SELECT COUNT(*) AS count FROM payments").get().count;
  const artBefore = f.db.getOriginalById("the-light");
  const checkoutsBefore = f.calls.checkouts;
  for (const id of ["the-light", "unknown-original"]) {
    for (const endpoint of ["checkout", "shipping-rate"]) {
      const response = await fetch(`${base}/api/originals/${id}/${endpoint}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
      });
      assert.equal(response.status, 410);
      const result = await response.json();
      assert.match(result.error, /email inquiry only/);
      assert.equal(result.inquiryEmail, "artwithrayan@gmail.com");
      assert.equal(result.checkoutUrl, undefined);
    }
  }
  assert.equal(f.calls.checkouts, checkoutsBefore);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS count FROM payments").get().count, paymentsBefore);
  assert.deepEqual(f.db.getOriginalById("the-light"), artBefore);
});

test("missing webhook signing configuration fails closed", async () => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = "";
  try {
    assert.equal((await fetch(`${base}/api/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 503);
  } finally { process.env.STRIPE_WEBHOOK_SECRET = secret; }
});

test("local clock cleanup never releases a real Stripe session prematurely", () => {
  assert.ok(f.db.reserveOriginalCheckout("the-light"));
  const payment = f.payment("cs_real_open", "original");
  f.db.setOriginalReservationOwner("the-light", payment.id);
  f.sql.prepare("UPDATE payments SET created_at=datetime('now','-1 hour') WHERE id=?").run(payment.id);
  f.db.releaseStaleCheckoutReservations();
  assert.equal(f.db.getOriginalById("the-light").status, "payment_pending");
  f.db.cancelCheckoutReservation(payment.stripe_session_id);
});
