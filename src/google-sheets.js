const crypto = require("crypto");

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const DEFAULT_HEADERS = [
  "Order ID", "Date", "Status", "Product", "Product Type", "Size", "Printful Product ID", "Printful Variant ID", "Printful Sync Variant ID", "Product Options",
  "Fulfillment", "Customer", "Email", "Product Amount", "Shipping Charged", "Fulfillment Tax Charged", "Total Charged", "Stripe Fee Estimate",
  "Printful Subtotal", "Printful Shipping", "Printful Tax/VAT", "Printful Total", "Estimated Profit", "Printful Draft ID", "Address", "City", "State", "ZIP", "Country"
];

let tokenCache = { value: "", expiresAt: 0 };

function getConfig() {
  const configuredRange = String(process.env.GOOGLE_SHEETS_RANGE || "").trim();
  return {
    spreadsheetId: String(process.env.GOOGLE_SHEETS_SPREADSHEET_ID || "").trim(),
    email: String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "").trim(),
    privateKey: String(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    range: configuredRange === "Sheet1!A:R" ? "Sheet1!A:AC" : configuredRange || "Sheet1!A:AC"
  };
}

function isConfigured() {
  const config = getConfig();
  return Boolean(config.spreadsheetId && config.email && config.privateKey);
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getAccessToken() {
  if (tokenCache.value && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.value;
  const config = getConfig();
  const now = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = encodeBase64Url(JSON.stringify({ iss: config.email, scope: SHEETS_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  signer.end();
  const assertion = `${header}.${claim}.${encodeBase64Url(signer.sign(config.privateKey))}`;
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(`Google authorization failed: ${data.error_description || data.error || response.statusText}`);
  tokenCache = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return tokenCache.value;
}

async function sheetsRequest(path, options = {}) {
  const token = await getAccessToken();
  const response = await fetch(`${API_BASE}/${getConfig().spreadsheetId}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Google Sheets API error ${response.status}: ${data.error?.message || response.statusText}`);
  return data;
}

async function ensureHeaders() {
  const config = getConfig();
  const firstCell = config.range.replace(/![^!]+$/, "!A1");
  const headerRange = firstCell.replace(/A1$/, "A1:AC1");
  const existing = await sheetsRequest(`/values/${encodeURIComponent(headerRange)}`);
  const existingHeaders = existing.values?.[0] || [];
  if (existingHeaders[0] && existingHeaders.length === DEFAULT_HEADERS.length) return;
  await sheetsRequest(`/values/${encodeURIComponent(firstCell)}?valueInputOption=USER_ENTERED`, {
    method: "PUT",
    body: JSON.stringify({ range: firstCell, majorDimension: "ROWS", values: [DEFAULT_HEADERS] })
  });
}

function money(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "";
}

function shippingFields(payment) {
  try {
    const parsed = JSON.parse(payment.shipping_json || "{}");
    const recipient = parsed.recipient || {};
    return [recipient.address1 || "", recipient.city || "", recipient.state_code || "", recipient.zip || "", recipient.country_code || ""];
  } catch {
    return ["", "", "", "", ""];
  }
}

function fulfillmentCosts(payment) {
  try {
    const parsed = JSON.parse(payment.shipping_json || "{}");
    return parsed.fulfillmentCosts || null;
  } catch {
    return null;
  }
}

function printOptions(print) {
  if (!Array.isArray(print?.printfulOptions)) return "";
  return print.printfulOptions.map((option) => `${option.id || ""}=${option.value || ""}`).filter(Boolean).join("; ");
}

async function appendPaidOrder({ payment, print, original }) {
  if (!isConfigured() || payment.google_sheets_synced_at) return false;
  const config = getConfig();
  await ensureHeaders();
  const total = Number(payment.total_amount || payment.amount || 0);
  const stripeFeeEstimate = total > 0 ? total * 0.029 + 0.30 : 0;
  const costs = fulfillmentCosts(payment);
  const printfulTotal = costs ? Number(costs.total || 0) : 0;
  const estimatedProfit = total - stripeFeeEstimate - printfulTotal;
  const [address, city, state, zip, country] = shippingFields(payment);
  let fulfillmentTaxCharged = 0;
  try { fulfillmentTaxCharged = Number(JSON.parse(payment.shipping_json || "{}").fulfillmentTax || 0); } catch { fulfillmentTaxCharged = 0; }
  const row = [
    payment.id,
    payment.paid_at || payment.created_at || new Date().toISOString(),
    payment.status,
    print?.title || original?.title || payment.print_id || payment.original_id || "",
    print?.productType || original?.medium || "Original artwork",
    print?.sizes || original?.size || "",
    print?.printfulProductId || "",
    print?.printfulVariantId || "",
    print?.printfulSyncVariantId || "",
    printOptions(print),
    print?.fulfillmentType === "self" ? "Self-fulfilled" : payment.kind === "print" ? "Printful" : "Self-fulfilled",
    payment.customer_name || "",
    payment.customer_email || "",
    money(payment.subtotal_amount),
    money(payment.shipping_amount),
    money(fulfillmentTaxCharged),
    money(total),
    money(stripeFeeEstimate),
    costs ? money(costs.subtotal) : "",
    costs ? money(costs.shipping) : "",
    costs ? money(Number(costs.tax || 0) + Number(costs.vat || 0)) : "",
    costs ? money(printfulTotal) : "",
    costs || payment.kind === "original" || print?.fulfillmentType === "self" ? money(estimatedProfit) : "",
    payment.printful_order_id || "",
    address, city, state, zip, country
  ];
  await sheetsRequest(`/values/${encodeURIComponent(config.range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ majorDimension: "ROWS", values: [row] })
  });
  return true;
}

module.exports = { isConfigured, appendPaidOrder };
