const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const output = process.argv[2] || "orders.csv";
const db = new Database(path.join(__dirname, "..", "data.sqlite"), { readonly: true });
const rows = db.prepare(`
  SELECT payments.*, prints.title AS print_title, prints.fulfillment_type, prints.source
  FROM payments
  LEFT JOIN prints ON prints.id = payments.print_id
  ORDER BY payments.created_at DESC
`).all();

const columns = ["order_id", "created_at", "paid_at", "status", "customer_name", "customer_email", "product", "fulfillment", "source", "subtotal", "shipping", "total", "address", "city", "state", "postal_code", "country", "stripe_session_id", "printful_order_id"];
const csv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const lines = [columns.join(",")];

rows.forEach((row) => {
  let shipping = {};
  try { shipping = JSON.parse(row.shipping_json || "{}"); } catch { shipping = {}; }
  const recipient = shipping.recipient || {};
  lines.push([
    row.id, row.created_at, row.paid_at, row.status, row.customer_name, row.customer_email,
    row.print_title || row.original_id || row.print_id || "", row.fulfillment_type === "self" ? "Self-fulfilled" : "Printful", row.source || "",
    row.subtotal_amount, row.shipping_amount, row.total_amount, recipient.address1, recipient.city, recipient.state_code, recipient.zip, recipient.country_code,
    row.stripe_session_id, row.printful_order_id || ""
  ].map(csv).join(","));
});

fs.writeFileSync(path.resolve(process.cwd(), output), `${lines.join("\n")}\n`, "utf8");
console.log(`Exported ${rows.length} order(s) to ${path.resolve(process.cwd(), output)}`);
db.close();
