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

const internationalAddress = { name: "Test Buyer", email: "test@example.com", address1: "10 Test Street", city: "London", country: "GB", phone: "+44 7700 900123", postalCode: "SW1A 1AA" };
async function printRequest(endpoint, body) {
  return fetch(`${base}/api/prints/test-small/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

test("shipping metadata exposes country-specific regions", async () => {
  const response = await fetch(`${base}/api/shipping/countries`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /max-age=3600/);
  const { countries } = await response.json();
  assert.ok(countries.find((country) => country.code === "CA").states.some((state) => state.code === "ON"));
  assert.deepEqual(countries.find((country) => country.code === "GB").states, []);
});

test("international checkout preserves destination, phone, currency, and cents", async () => {
  for (const fields of [
    { country: "CA", state: "ON", city: "Toronto", postalCode: "M5V 2T6", phone: "+1 (416) 555-0123" },
    { country: "AU", state: "NSW", city: "Sydney", postalCode: "2000", phone: "+61 412 345 678" },
    { country: "GB", state: "", city: "London", postalCode: "SW1A 1AA", phone: "+44 7700 900123" },
    { country: "HK", state: "", city: "Hong Kong", postalCode: "", phone: "+852 2123 4567" },
    { country: "BR", state: "SP", city: "Sao Paulo", postalCode: "01310-100", phone: "+55 11 95555 0123", taxNumber: "52998224725" }
  ]) {
    const body = { ...internationalAddress, ...fields, expectedTotal: 21.75 };
    const quote = await printRequest("shipping-rate", body);
    assert.equal(quote.status, 200, JSON.stringify(fields));
    assert.equal((await quote.json()).currency, "USD");
    assert.equal((await printRequest("checkout", body)).status, 200);
    const session = f.sessions.get(`cs_test_${f.calls.checkouts}`);
    const payment = f.db.getPaymentByStripeSessionId(session.id);
    const recipient = JSON.parse(payment.shipping_json).recipient;
    assert.equal(recipient.country_code, fields.country);
    assert.equal(recipient.state_code, fields.state);
    assert.equal(recipient.zip, fields.postalCode);
    assert.match(recipient.phone, /^\+[1-9]\d{6,14}$/);
    if (fields.country === "BR") assert.equal(recipient.tax_number, "529.982.247-25");
    else assert.equal(Object.hasOwn(recipient, "tax_number"), false);
    assert.equal(session.amount_total, 2175);
    assert.ok(session.line_items.every((line) => line.price_data.currency === "usd"));
  }
});

test("invalid country, province, and international phone are rejected before quoting", async () => {
  const quote = f.printful.getShippingRatesForPrint;
  let calls = 0;
  f.printful.getShippingRatesForPrint = async () => { calls++; return []; };
  try {
    for (const fields of [
      { country: "ZZ" }, { country: "Canada" }, { phone: "" }, { phone: "123" },
      { country: "CA", state: "", postalCode: "M5V 2T6" },
      { country: "CA", state: "NC", postalCode: "M5V 2T6" },
      { country: "AU", state: "NSW", postalCode: "" },
      { country: "GB", postalCode: "" },
      { country: "BR", state: "SP", postalCode: "01310-100", taxNumber: "" },
      { country: "BR", state: "SP", postalCode: "01310-100", taxNumber: "11111111111" }
    ]) assert.equal((await printRequest("shipping-rate", { ...internationalAddress, ...fields })).status, 400);
    assert.equal(calls, 0);
  } finally { f.printful.getShippingRatesForPrint = quote; }
});

test("Brazilian shipping tax IDs are forwarded to the estimate and do not leak across destinations", async () => {
  const rates = f.printful.getShippingRatesForPrint;
  const costs = f.printful.estimatePrintCosts;
  const recipients = [];
  f.printful.getShippingRatesForPrint = async (params) => { recipients.push(params.recipient); return rates(params); };
  f.printful.estimatePrintCosts = async (params) => { recipients.push(params.recipient); return costs(params); };
  try {
    assert.equal((await printRequest("shipping-rate", { ...internationalAddress, country: "BR", state: "SP", postalCode: "01310-100", taxNumber: "529.982.247-25" })).status, 200);
    assert.equal((await printRequest("shipping-rate", { ...internationalAddress, taxNumber: "529.982.247-25" })).status, 200);
    assert.equal(recipients[0].tax_number, "529.982.247-25");
    assert.equal(recipients[1].tax_number, recipients[0].tax_number);
    assert.equal(Object.hasOwn(recipients[2], "tax_number"), false);
    assert.equal(Object.hasOwn(recipients[3], "tax_number"), false);
  } finally { f.printful.getShippingRatesForPrint = rates; f.printful.estimatePrintCosts = costs; }
});

test("self-fulfilled prints cannot use domestic estimates for international orders", async () => {
  f.sql.prepare("UPDATE prints SET fulfillment_type='self' WHERE id='test-small'").run();
  const before = f.calls.checkouts;
  try {
    assert.equal((await printRequest("shipping-rate", internationalAddress)).status, 400);
    assert.equal((await printRequest("checkout", internationalAddress)).status, 400);
    assert.equal(f.calls.checkouts, before);
  } finally { f.sql.prepare("UPDATE prints SET fulfillment_type='printful' WHERE id='test-small'").run(); }
});

test("unavailable shipping and mixed-currency estimates never create checkout", async () => {
  const rates = f.printful.getShippingRatesForPrint;
  const costs = f.printful.estimatePrintCosts;
  const before = f.calls.checkouts;
  try {
    f.printful.getShippingRatesForPrint = async () => [];
    assert.equal((await printRequest("checkout", internationalAddress)).status, 400);
    f.printful.getShippingRatesForPrint = async () => [{ id: "STANDARD", rate: "4.99", currency: "EUR" }];
    assert.equal((await printRequest("checkout", internationalAddress)).status, 502);
    f.printful.getShippingRatesForPrint = rates;
    f.printful.estimatePrintCosts = async () => ({ costs: { currency: "EUR", shipping: "4.99" } });
    assert.equal((await printRequest("checkout", internationalAddress)).status, 502);
    f.printful.estimatePrintCosts = async () => ({ costs: { currency: "USD", shipping: "-1" } });
    assert.equal((await printRequest("checkout", internationalAddress)).status, 502);
    assert.equal(f.calls.checkouts, before);
  } finally { f.printful.getShippingRatesForPrint = rates; f.printful.estimatePrintCosts = costs; }
});

test("fulfillment shipping and VAT are reflected in the customer quote", async () => {
  const costs = f.printful.estimatePrintCosts;
  f.printful.estimatePrintCosts = async () => ({ costs: { currency: "USD", shipping: "8.22", vat: "2.31", tax: "0" } });
  try {
    const response = await printRequest("shipping-rate", internationalAddress);
    assert.equal(response.status, 200);
    const quote = await response.json();
    assert.equal(quote.shipping, 8.22);
    assert.equal(quote.fulfillmentTax, 2.31);
    assert.equal(Math.round(quote.total * 100), 2653);
  } finally { f.printful.estimatePrintCosts = costs; }
});

test("a country metadata outage fails closed internationally but leaves US quotes usable", async () => {
  const countries = f.printful.getShippingCountries;
  f.printful.getShippingCountries = async () => { throw new Error("Temporary country metadata outage"); };
  try {
    assert.equal((await fetch(`${base}/api/shipping/countries`)).status, 502);
    assert.equal((await printRequest("shipping-rate", internationalAddress)).status, 502);
    assert.equal((await printRequest("shipping-rate", { ...internationalAddress, country: "US", state: "NC", postalCode: "27601", phone: "" })).status, 200);
  } finally { f.printful.getShippingCountries = countries; }
});

test("original listings omit public prices while preserving internal records and the inquiry address", async () => {
  const storedOriginals = f.db.getOriginals();
  const catalog = await (await fetch(`${base}/api/originals`)).json();
  assert.equal(catalog.inquiryEmail, "artwithrayan@gmail.com");
  for (const art of catalog.originals) {
    assert.equal(Object.hasOwn(art, "price"), false);
    assert.equal(Object.hasOwn(art, "startingBid"), false);
    assert.equal(art.title, f.db.getOriginalById(art.id).title);
  }
  const detail = await (await fetch(`${base}/api/originals/the-light`)).json();
  assert.equal(Object.hasOwn(detail.original, "price"), false);
  assert.equal(Object.hasOwn(detail.original, "startingBid"), false);
  assert.equal(detail.inquiryEmail, catalog.inquiryEmail);
  assert.deepEqual(f.db.getOriginals(), storedOriginals);
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
