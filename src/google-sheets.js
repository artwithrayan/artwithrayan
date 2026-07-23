const crypto = require("crypto");

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const DEFAULT_HEADERS = [
  "Order ID", "Date", "Status", "Product", "Fulfillment", "Customer", "Email",
  "Product Amount", "Shipping Charged", "Total Charged", "Stripe Fee Estimate",
  "Estimated Net Before Fulfillment", "Printful Draft ID", "Address", "City", "State", "ZIP", "Country"
];

let tokenCache = { value: "", expiresAt: 0 };

function getConfig() {
  return {
    spreadsheetId: String(process.env.GOOGLE_SHEETS_SPREADSHEET_ID || "").trim(),
    email: String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "").trim(),
    privateKey: String(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    range: String(process.env.GOOGLE_SHEETS_RANGE || "Sheet1!A:R").trim()
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
  const existing = await sheetsRequest(`/values/${encodeURIComponent(firstCell)}`);
  if (existing.values?.[0]?.[0]) return;
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

async function appendPaidOrder({ payment, print, original }) {
  if (!isConfigured() || payment.google_sheets_synced_at) return false;
  const config = getConfig();
  await ensureHeaders();
  const total = Number(payment.total_amount || payment.amount || 0);
  const stripeFeeEstimate = total > 0 ? total * 0.029 + 0.30 : 0;
  const [address, city, state, zip, country] = shippingFields(payment);
  const row = [
    payment.id,
    payment.paid_at || payment.created_at || new Date().toISOString(),
    payment.status,
    print?.title || original?.title || payment.print_id || payment.original_id || "",
    print?.fulfillmentType === "self" ? "Self-fulfilled" : payment.kind === "print" ? "Printful" : "Self-fulfilled",
    payment.customer_name || "",
    payment.customer_email || "",
    money(payment.subtotal_amount),
    money(payment.shipping_amount),
    money(total),
    money(stripeFeeEstimate),
    money(total - stripeFeeEstimate),
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
