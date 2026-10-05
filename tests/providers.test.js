const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

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
