const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

test("Printful credentials never follow redirects or go to another origin", async () => {
  process.env.PRINTFUL_API_KEY = "synthetic-printful-token";
  const { printfulFetch } = require("../src/printful");
  let requests = 0;
  global.fetch = async (url, options) => {
    requests++;
    assert.equal(new URL(url).origin, "https://api.printful.com");
    assert.equal(options.redirect, "error");
    return response({ result: [] });
  };
  for (const destination of ["https://example.invalid/products", "//example.invalid/products", "http://api.printful.com/products", "https://user:pass@api.printful.com/products"]) {
    await assert.rejects(printfulFetch(destination), /Untrusted Printful/);
  }
  assert.equal(requests, 0);
  await printfulFetch("/store/products");
  assert.equal(requests, 1);
});

test("Printful retries reuse an existing external order ID", async () => {
  process.env.PRINTFUL_API_KEY = "test-key";
  process.env.PRINTFUL_AUTO_CREATE_DRAFT_ORDER = "true";
  const printful = require("../src/printful");
  let created = false;
  let posts = 0;
  global.fetch = async (url, options) => {
    if (options.method === "GET") return created ? response({ result: { id: 75 } }) : response({ error: { message: "Not found" } }, 404);
    assert.match(url, /orders\?confirm=false$/);
    assert.equal(JSON.parse(options.body).external_id, "rayan-payment-123");
    posts++;
    created = true;
    return response({ result: { id: 75 } });
  };
  const params = { payment: { id: 123, shipping_json: JSON.stringify({ recipient: { name: "Test", address1: "Address", city: "Raleigh", state_code: "NC", zip: "27601", country_code: "US" } }) }, print: { printfulSyncVariantId: "100" }, stripeSession: {} };
  assert.equal((await printful.createDraftOrderFromStripeSession(params)).printfulOrderId, 75);
  assert.equal((await printful.createDraftOrderFromStripeSession(params)).printfulOrderId, 75);
  assert.equal(posts, 1);
});

test("Printful recovers an accepted POST whose response was lost", async () => {
  const printful = require("../src/printful");
  let created = false;
  global.fetch = async (_url, options) => {
    if (options.method === "GET") return created ? response({ result: { id: 76 } }) : response({ error: { message: "Not found" } }, 404);
    created = true;
    throw new Error("Connection lost after Printful accepted the order");
  };
  const result = await printful.createDraftOrderFromStripeSession({ payment: { id: 124, shipping_json: JSON.stringify({ recipient: { name: "Test", address1: "Address", city: "Raleigh", state_code: "NC", zip: "27601", country_code: "US" } }) }, print: { printfulSyncVariantId: "100" }, stripeSession: {} });
  assert.equal(result.printfulOrderId, 76);
});

test("international Printful drafts forward shipping phone, email, and optional region", async () => {
  const printful = require("../src/printful");
  global.fetch = async (_url, options) => {
    if (options.method === "GET") return response({ error: { message: "Not found" } }, 404);
    const { recipient } = JSON.parse(options.body);
    assert.equal(recipient.country_code, "GB");
    assert.equal(recipient.state_code, "");
    assert.equal(recipient.address2, "");
    assert.equal(recipient.zip, "SW1A 1AA");
    assert.equal(recipient.phone, "+447700900123");
    assert.equal(recipient.email, "test@example.com");
    const payload = JSON.parse(options.body);
    assert.equal(payload.items[0].retail_price, "19.00");
    assert.deepEqual(payload.retail_costs, { currency: "USD", subtotal: "19.00" });
    return response({ result: { id: 77 } });
  };
  const recipient = { name: "Test", address1: "10 Test Street", city: "London", country_code: "GB", zip: "SW1A 1AA", phone: "+447700900123", email: "test@example.com" };
  const result = await printful.createDraftOrderFromStripeSession({ payment: { id: 125, subtotal_amount: 19, shipping_json: JSON.stringify({ recipient }) }, print: { printfulSyncVariantId: "100" }, stripeSession: { customer_details: { address: { line2: "Billing apartment", state: "NC", country: "US", postal_code: "27601" } } } });
  assert.equal(result.printfulOrderId, 77);
});

test("international estimates pass the actual displayed retail value in USD", async () => {
  const printful = require("../src/printful");
  global.fetch = async (url, options) => {
    assert.match(url, /orders\/estimate-costs$/);
    const payload = JSON.parse(options.body);
    assert.equal(payload.items[0].retail_price, "19.00");
    assert.deepEqual(payload.retail_costs, { currency: "USD", subtotal: "19.00" });
    return response({ result: { costs: { currency: "USD", total: "14.00" } } });
  };
  assert.equal((await printful.estimatePrintCosts({ print: { printfulVariantId: "16364" }, recipient: { country_code: "GB" }, retailPrice: 19 })).costs.currency, "USD");
});

test("destinations without postal codes do not borrow a ZIP code from the billing address", async () => {
  const printful = require("../src/printful");
  global.fetch = async (_url, options) => {
    if (options.method === "GET") return response({ error: { message: "Not found" } }, 404);
    const { recipient } = JSON.parse(options.body);
    assert.equal(recipient.country_code, "HK");
    assert.equal(recipient.zip, "");
    assert.equal(recipient.state_code, "");
    assert.equal(recipient.address2, "");
    return response({ result: { id: 79 } });
  };
  const recipient = { name: "Test", address1: "Test Street", city: "Hong Kong", country_code: "HK", zip: "", state_code: "", phone: "+85221234567" };
  const params = { payment: { id: 127, shipping_json: JSON.stringify({ recipient }) }, print: { printfulSyncVariantId: "100" }, stripeSession: { customer_details: { address: { state: "CA", line2: "Billing apartment", postal_code: "94103", country: "US" } } } };
  assert.equal((await printful.createDraftOrderFromStripeSession(params)).printfulOrderId, 79);
});

test("country metadata is public, caches concurrent requests, and retries failed responses", async () => {
  const printful = require("../src/printful");
  let requests = 0;
  global.fetch = async (url, options) => {
    requests++;
    assert.equal(url, "https://api.printful.com/countries");
    assert.equal(options.headers, undefined);
    assert.ok(options.signal);
    if (requests === 1) return response({}, 503);
    return response({ result: [{ code: "US", name: "United States", states: [{ code: "NC", name: "North Carolina" }] }, { code: "GB", name: "United Kingdom", states: null }] });
  };
  await assert.rejects(printful.getShippingCountries(), /Could not load/);
  const [first, second] = await Promise.all([printful.getShippingCountries(), printful.getShippingCountries()]);
  assert.deepEqual(first, second);
  assert.deepEqual(first[1].states, []);
  await printful.getShippingCountries();
  assert.equal(requests, 2);
});

test("Printful Brazilian drafts include the recipient's required tax ID", async () => {
  const printful = require("../src/printful");
  global.fetch = async (_url, options) => {
    if (options.method === "GET") return response({ error: { message: "Not found" } }, 404);
    const { recipient } = JSON.parse(options.body);
    assert.equal(recipient.country_code, "BR");
    assert.equal(recipient.tax_number, "529.982.247-25");
    return response({ result: { id: 78 } });
  };
  const recipient = { name: "Test", address1: "Test Street", city: "Sao Paulo", state_code: "SP", country_code: "BR", zip: "01310-100", phone: "+5511955550123", tax_number: "529.982.247-25" };
  assert.equal((await printful.createDraftOrderFromStripeSession({ payment: { id: 126, shipping_json: JSON.stringify({ recipient }) }, print: { printfulSyncVariantId: "100" }, stripeSession: {} })).printfulOrderId, 78);
});

test("Resend returned error objects are failures, not successful sends", async () => {
  process.env.RESEND_API_KEY = "test-resend";
  process.env.FROM_EMAIL = "Rayan <shipping@artwithrayan.com>";
  delete require.cache[require.resolve("../src/email")];
  const email = require("../src/email");
  global.fetch = async () => response({ name: "validation_error", message: "Domain is not verified" }, 403);
  const result = await email.sendShipmentTrackingEmail({ to: "test@example.com", trackingNumber: "TEST123", idempotencyKey: "test-shipment" });
  assert.equal(result.sent, undefined);
  assert.equal(result.failed, true);
  assert.match(result.reason, /Domain is not verified/);
});

test("tracking emails preserve provider idempotency and require an accepted ID", async () => {
  const email = require("../src/email");
  global.fetch = async (_url, options) => {
    assert.equal(new Headers(options.headers).get("Idempotency-Key"), "test-shipment");
    assert.ok(options.signal);
    return response({ id: "email-123" });
  };
  assert.equal((await email.sendShipmentTrackingEmail({ to: "test@example.com", idempotencyKey: "test-shipment" })).sent, true);
});

test("Resend test sender is refused before a network call", async () => {
  process.env.FROM_EMAIL = "Rayan <onboarding@resend.dev>";
  delete require.cache[require.resolve("../src/email")];
  const email = require("../src/email");
  global.fetch = async () => { throw new Error("Unexpected network call"); };
  assert.equal(email.isEmailEnabled(), false);
  const result = await email.sendShipmentTrackingEmail({ to: "test@example.com" });
  assert.equal(result.failed, true);
  assert.match(result.reason, /verified Resend domain/);
});

test("Sheets customer fields are RAW, money remains numeric, and a lost append does not duplicate a row", async () => {
  const key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  Object.assign(process.env, { GOOGLE_SERVICE_ACCOUNT_EMAIL: "test@example.invalid", GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: key, GOOGLE_SHEETS_SPREADSHEET_ID: "test-sheet", GOOGLE_SHEETS_RANGE: "Sheet1!A:AC" });
  const sheets = require("../src/google-sheets");
  let storedRow;
  let appends = 0;
  let updates = 0;
  global.fetch = async (url, options) => {
    if (url.includes("oauth2.googleapis.com")) return response({ access_token: "local-token", expires_in: 3600 });
    if (!options.method) return response({ values: url.includes("AC1") ? [Array.from({ length: 29 }, (_, i) => i ? "Header" : "Order ID")] : storedRow ? [["Order ID"], storedRow] : [["Order ID"]] });
    assert.match(url, /valueInputOption=RAW/);
    const row = JSON.parse(options.body).values[0];
    assert.equal(row[11], '=IMPORTXML("https://example.invalid","//a")');
    assert.equal(row[14], 4.99);
    assert.equal(row[16], 21.75);
    assert.equal(typeof row[22], "number");
    storedRow = row;
    if (options.method === "POST") { appends++; throw new Error("Response lost after append"); }
    updates++;
    return response({ updatedCells: 29 });
  };
  const params = { payment: { id: 123, status: "paid", customer_name: '=IMPORTXML("https://example.invalid","//a")', subtotal_amount: 16, shipping_amount: 4.99, total_amount: 21.75, kind: "original" }, original: { title: "Test", medium: "Acrylic", size: "9x12" } };
  await assert.rejects(sheets.appendPaidOrder(params), /Response lost/);
  assert.equal(await sheets.appendPaidOrder(params), true);
  assert.equal(appends, 1);
  assert.equal(updates, 1);
});
