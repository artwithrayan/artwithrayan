const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const RealStripe = require("stripe");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rayan-site-tests-"));
Object.assign(process.env, {
  DB_PATH: path.join(tempDir, "test.sqlite"), STRIPE_SECRET_KEY: "sk_test_local_fixture",
  STRIPE_WEBHOOK_SECRET: "whsec_local_fixture", PRINTFUL_API_KEY: "",
  PRINTFUL_AUTO_CREATE_DRAFT_ORDER: "true", PRINTFUL_SYNC_ON_STARTUP: "false",
  PRINTFUL_WEBHOOK_ON_STARTUP: "false", PRINTFUL_WEBHOOK_SECRET: "test-printful",
  RESEND_API_KEY: "", FROM_EMAIL: "Rayan Rao Art <shipping@artwithrayan.com>",
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "", GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "", GOOGLE_SHEETS_SPREADSHEET_ID: "",
  BASE_URL: "http://localhost:3000"
});

const sessions = new Map();
const calls = { drafts: 0, sheets: 0, emails: 0, refunds: 0, checkouts: 0 };
const failures = { drafts: false, sheets: false, emails: false };
const sdk = new RealStripe("sk_test_local_fixture");
class StripeMock {
  constructor() {
    this.webhooks = sdk.webhooks;
    this.checkout = { sessions: {
      create: async (config) => {
        calls.checkouts++;
        const id = `cs_test_${calls.checkouts}`;
        const session = { ...config, id, url: `https://example.invalid/${id}`, status: "open", payment_status: "unpaid", currency: "usd",
          amount_total: config.line_items.reduce((sum, line) => sum + line.price_data.unit_amount * line.quantity, 0),
          payment_intent: { id: `pi_${id}`, latest_charge: { refunded: false, amount_refunded: 0 } } };
        sessions.set(id, session);
        return session;
      },
      retrieve: async (id) => {
        if (!sessions.has(id)) throw new Error("Unknown test session");
        return sessions.get(id);
      }
    } };
    this.refunds = { create: async () => { calls.refunds++; return { id: "re_test" }; } };
  }
}
const load = Module._load;
Module._load = function (id, parent, ...args) {
  if (id === "stripe" && parent?.filename === path.resolve(__dirname, "../server.js")) return StripeMock;
  return load.call(this, id, parent, ...args);
};
const db = require("../src/db");
const printful = require("../src/printful");
const sheets = require("../src/google-sheets");
const email = require("../src/email");
const originalSheetsAppend = sheets.appendPaidOrder;
printful.createDraftOrderFromStripeSession = async ({ payment }) => {
  calls.drafts++;
  if (failures.drafts) throw new Error("Temporary draft outage");
  return { printfulOrderId: `draft-${payment.id}` };
};
printful.getShippingRatesForPrint = async () => [{ id: "STANDARD", name: "Standard", rate: "4.99", currency: "USD" }];
printful.estimatePrintCosts = async () => ({ costs: { subtotal: "8.00", shipping: "4.99", tax: "0.76", total: "13.75" } });
sheets.isConfigured = () => true;
sheets.appendPaidOrder = async () => {
  calls.sheets++;
  if (failures.sheets) throw new Error("Temporary sheet outage");
  return true;
};
email.sendShipmentTrackingEmail = async () => {
  calls.emails++;
  return failures.emails ? { failed: true, reason: "Resend rejected email" } : { sent: true };
};
const server = require("../server");
Module._load = load;
const Database = require("better-sqlite3");
const sql = new Database(process.env.DB_PATH);
for (const [id, size, price] of [["test-small", "5x7", 15], ["test-large", "11.69x16.54", 21]]) {
  sql.prepare(`INSERT INTO prints (id,title,product_type,sizes,price,description,color_one,color_two,fulfillment_type,source,status,is_active,printful_sync_variant_id,printful_variant_id,artwork_key,image_url,image_urls)
    VALUES (?,?,?,?,?,'Test product','#fff','#000','printful','printful','active',1,'101','102','test-artwork','/images/flower.jpg','["/images/flower.jpg"]')`)
    .run(id, '"Test Artwork" Poster', "Poster", size, price);
}

function payment(id, kind = "print", extra = {}) {
  const record = db.createPayment({ kind, printId: kind === "print" ? "test-small" : null, originalId: kind === "original" ? "the-light" : null,
    stripeSessionId: id, checkoutUrl: "https://example.invalid/checkout", customerName: "Test Buyer", customerEmail: "test@example.com",
    subtotalAmount: 16, shippingAmount: 4.99, totalAmount: 21.75, amount: 21.75,
    shippingJson: { recipient: { name: "Test Buyer", address1: "1 E Edenton St", city: "Raleigh", state_code: "NC", zip: "27601", country_code: "US" }, method: "STANDARD", fulfillmentTax: 0.76 }, ...extra });
  sessions.set(id, { id, mode: "payment", payment_status: "paid", status: "complete", currency: "usd", amount_total: 2175,
    payment_intent: { id: `pi_${id}`, latest_charge: { refunded: false, amount_refunded: 0 } } });
  return record;
}

function signedEvent(type, object) {
  const payload = JSON.stringify({ id: `evt_${Date.now()}`, type, data: { object } });
  return { payload, signature: sdk.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET }) };
}

module.exports = { ...server, db, sql, calls, failures, sessions, payment, signedEvent, tempDir, sheets, originalSheetsAppend };
