const path = require("path");
const Database = require("better-sqlite3");
const { parseSizeInches, estimateOriginalShipping } = require("./shipping");

const dbPath = path.join(__dirname, "..", "data.sqlite");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS originals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  medium TEXT NOT NULL,
  size TEXT NOT NULL,
  year TEXT NOT NULL,
  description TEXT NOT NULL,
  starting_bid INTEGER NOT NULL,
  bid_increment INTEGER NOT NULL DEFAULT 10,
  ends_at TEXT NOT NULL,
  image_url TEXT,
  color_one TEXT NOT NULL,
  color_two TEXT NOT NULL,
  width_in REAL,
  height_in REAL,
  depth_in REAL,
  weight_lb REAL,
  auto_charge_enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS bidders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  location TEXT,
  shipping_name TEXT,
  shipping_line1 TEXT,
  shipping_line2 TEXT,
  shipping_city TEXT,
  shipping_state TEXT,
  shipping_postal_code TEXT,
  shipping_country TEXT NOT NULL DEFAULT 'US',
  stripe_customer_id TEXT,
  stripe_payment_method_id TEXT,
  stripe_setup_session_id TEXT,
  stripe_setup_intent_id TEXT,
  payment_method_saved INTEGER NOT NULL DEFAULT 0,
  approved_to_bid INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  terms_accepted INTEGER NOT NULL DEFAULT 0,
  auto_charge_authorized INTEGER NOT NULL DEFAULT 0,
  terms_accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS bids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_id TEXT NOT NULL,
  bidder_id INTEGER,
  bidder_name TEXT NOT NULL,
  bidder_email TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (original_id) REFERENCES originals(id),
  FOREIGN KEY (bidder_id) REFERENCES bidders(id)
);

CREATE TABLE IF NOT EXISTS prints (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  product_type TEXT NOT NULL,
  sizes TEXT NOT NULL,
  price INTEGER NOT NULL,
  description TEXT NOT NULL,
  checkout_url TEXT,
  image_url TEXT,
  color_one TEXT NOT NULL,
  color_two TEXT NOT NULL,
  printful_variant_id TEXT,
  printful_sync_variant_id TEXT,
  printful_product_id TEXT,
  printful_currency TEXT,
  print_file_url TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'active',
  is_active INTEGER NOT NULL DEFAULT 1,
  printful_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  original_id TEXT,
  print_id TEXT,
  bid_id INTEGER,
  bidder_id INTEGER,
  stripe_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT,
  checkout_url TEXT NOT NULL,
  customer_name TEXT,
  customer_email TEXT,
  subtotal_amount INTEGER,
  shipping_amount INTEGER NOT NULL DEFAULT 0,
  total_amount INTEGER,
  amount INTEGER NOT NULL,
  shipping_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  failure_reason TEXT,
  printful_order_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS auction_charge_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_id TEXT NOT NULL,
  bid_id INTEGER NOT NULL,
  bidder_id INTEGER,
  stripe_payment_intent_id TEXT,
  subtotal_amount INTEGER NOT NULL,
  shipping_amount INTEGER NOT NULL,
  total_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'started',
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT,
  UNIQUE(original_id, bid_id)
);
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Migration-safe updates for older local databases.
ensureColumn("originals", "status", "TEXT NOT NULL DEFAULT 'active'");
ensureColumn("originals", "width_in", "REAL");
ensureColumn("originals", "height_in", "REAL");
ensureColumn("originals", "depth_in", "REAL");
ensureColumn("originals", "weight_lb", "REAL");
ensureColumn("originals", "auto_charge_enabled", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("originals", "updated_at", "TEXT");
ensureColumn("bids", "bidder_id", "INTEGER");
ensureColumn("bidders", "shipping_name", "TEXT");
ensureColumn("bidders", "shipping_line1", "TEXT");
ensureColumn("bidders", "shipping_line2", "TEXT");
ensureColumn("bidders", "shipping_city", "TEXT");
ensureColumn("bidders", "shipping_state", "TEXT");
ensureColumn("bidders", "shipping_postal_code", "TEXT");
ensureColumn("bidders", "shipping_country", "TEXT NOT NULL DEFAULT 'US'");
ensureColumn("bidders", "stripe_payment_method_id", "TEXT");
ensureColumn("bidders", "auto_charge_authorized", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("prints", "status", "TEXT NOT NULL DEFAULT 'active'");
ensureColumn("prints", "printful_variant_id", "TEXT");
ensureColumn("prints", "printful_sync_variant_id", "TEXT");
ensureColumn("prints", "printful_product_id", "TEXT");
ensureColumn("prints", "printful_currency", "TEXT");
ensureColumn("prints", "print_file_url", "TEXT");
ensureColumn("prints", "source", "TEXT NOT NULL DEFAULT 'manual'");
ensureColumn("prints", "printful_synced_at", "TEXT");
ensureColumn("prints", "updated_at", "TEXT");
ensureColumn("payments", "printful_order_id", "TEXT");
ensureColumn("payments", "bidder_id", "INTEGER");
ensureColumn("payments", "stripe_payment_intent_id", "TEXT");
ensureColumn("payments", "subtotal_amount", "INTEGER");
ensureColumn("payments", "shipping_amount", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("payments", "total_amount", "INTEGER");
ensureColumn("payments", "shipping_json", "TEXT");
ensureColumn("payments", "failure_reason", "TEXT");

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "print";
}

if (db.prepare("SELECT COUNT(*) AS count FROM originals").get().count === 0) {
  const insert = db.prepare(`
    INSERT INTO originals
    (id,title,medium,size,year,description,starting_bid,bid_increment,ends_at,image_url,color_one,color_two,width_in,height_in,depth_in,weight_lb,status,auto_charge_enabled)
    VALUES
    (@id,@title,@medium,@size,@year,@description,@startingBid,@bidIncrement,@endsAt,@imageUrl,@colorOne,@colorTwo,@widthIn,@heightIn,@depthIn,@weightLb,'active',1)
  `);

  const rows = [
    {
      id: "memory-portrait",
      title: "Memory Portrait",
      medium: "Acrylic on canvas",
      size: "18 × 24 in",
      year: "2026",
      description: "A one-of-one expressive portrait painting. Replace this with your real artwork description.",
      startingBid: 175,
      bidIncrement: 10,
      endsAt: "2026-12-31T20:00:00-05:00",
      imageUrl: "",
      colorOne: "#d9d9d9",
      colorTwo: "#f7f7f7",
      widthIn: 18,
      heightIn: 24,
      depthIn: 2,
      weightLb: 4
    },
    {
      id: "cloud-study",
      title: "Cloud Study",
      medium: "Oil on canvas",
      size: "16 × 20 in",
      year: "2026",
      description: "A one-of-one atmospheric piece focused on light, movement, and imagination.",
      startingBid: 150,
      bidIncrement: 10,
      endsAt: "2026-12-28T20:00:00-05:00",
      imageUrl: "",
      colorOne: "#eeeeee",
      colorTwo: "#cfcfcf",
      widthIn: 16,
      heightIn: 20,
      depthIn: 2,
      weightLb: 3
    },
    {
      id: "figure-in-gold",
      title: "Figure in Gold",
      medium: "Mixed media",
      size: "24 × 30 in",
      year: "2026",
      description: "A larger original piece with layered color and figurative detail.",
      startingBid: 250,
      bidIncrement: 25,
      endsAt: "2027-01-05T20:00:00-05:00",
      imageUrl: "",
      colorOne: "#f4f4f4",
      colorTwo: "#d8d8d8",
      widthIn: 24,
      heightIn: 30,
      depthIn: 2,
      weightLb: 7
    }
  ];

  const seed = db.transaction((items) => items.forEach((item) => insert.run(item)));
  seed(rows);
}

if (db.prepare("SELECT COUNT(*) AS count FROM prints").get().count === 0) {
  const insert = db.prepare(`
    INSERT INTO prints
    (id,title,product_type,sizes,price,description,checkout_url,image_url,color_one,color_two,printful_variant_id,printful_sync_variant_id,printful_product_id,printful_currency,print_file_url,source,status)
    VALUES
    (@id,@title,@productType,@sizes,@price,@description,@checkoutUrl,@imageUrl,@colorOne,@colorTwo,@printfulVariantId,@printfulSyncVariantId,@printfulProductId,@printfulCurrency,@printFileUrl,'manual','active')
  `);

  const rows = [
    {
      id: "memory-portrait-print",
      title: "Memory Portrait Print",
      productType: "Fine art paper print",
      sizes: "8×10, 11×14, 16×20",
      price: 35,
      description: "Made-to-order archival-style print. Stripe collects payment; Printful can fulfill after setup.",
      checkoutUrl: "",
      imageUrl: "",
      colorOne: "#d9d9d9",
      colorTwo: "#f7f7f7",
      printfulVariantId: "",
      printfulSyncVariantId: "",
      printfulProductId: "",
      printfulCurrency: "USD",
      printFileUrl: ""
    }
  ];

  const seed = db.transaction((items) => items.forEach((item) => insert.run(item)));
  seed(rows);
}

function normalizeOriginalRow(row) {
  const parsed = parseSizeInches(row.size);
  const widthIn = row.width_in || parsed.widthIn;
  const heightIn = row.height_in || parsed.heightIn;
  const depthIn = row.depth_in || parsed.depthIn;
  const weightLb = row.weight_lb || 4;

  return {
    id: row.id,
    title: row.title,
    medium: row.medium,
    size: row.size,
    year: row.year,
    description: row.description,
    startingBid: row.starting_bid,
    bidIncrement: row.bid_increment,
    endsAt: row.ends_at,
    imageUrl: row.image_url,
    colorOne: row.color_one,
    colorTwo: row.color_two,
    widthIn,
    heightIn,
    depthIn,
    weightLb,
    autoChargeEnabled: Boolean(row.auto_charge_enabled),
    status: row.status,
    shippingEstimate: estimateOriginalShipping({ ...row, widthIn, heightIn, depthIn, weightLb })
  };
}

function mapBidder(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    location: row.location,
    shippingName: row.shipping_name,
    shippingLine1: row.shipping_line1,
    shippingLine2: row.shipping_line2,
    shippingCity: row.shipping_city,
    shippingState: row.shipping_state,
    shippingPostalCode: row.shipping_postal_code,
    shippingCountry: row.shipping_country,
    stripeCustomerId: row.stripe_customer_id,
    stripePaymentMethodId: row.stripe_payment_method_id,
    stripeSetupSessionId: row.stripe_setup_session_id,
    stripeSetupIntentId: row.stripe_setup_intent_id,
    paymentMethodSaved: Boolean(row.payment_method_saved),
    approvedToBid: Boolean(row.approved_to_bid),
    blocked: Boolean(row.blocked),
    termsAccepted: Boolean(row.terms_accepted),
    autoChargeAuthorized: Boolean(row.auto_charge_authorized),
    termsAcceptedAt: row.terms_accepted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapPrint(row) {
  return {
    id: row.id,
    title: row.title,
    productType: row.product_type,
    sizes: row.sizes,
    price: row.price,
    description: row.description,
    checkoutUrl: row.checkout_url,
    imageUrl: row.image_url,
    colorOne: row.color_one,
    colorTwo: row.color_two,
    printfulVariantId: row.printful_variant_id,
    printfulSyncVariantId: row.printful_sync_variant_id,
    printfulProductId: row.printful_product_id,
    printfulCurrency: row.printful_currency,
    printFileUrl: row.print_file_url,
    source: row.source,
    status: row.status,
    printfulSyncedAt: row.printful_synced_at
  };
}

function getOriginals() {
  return db.prepare(`
    SELECT * FROM originals
    WHERE is_active = 1
      AND status != 'draft'
    ORDER BY created_at DESC
  `).all().map(normalizeOriginalRow);
}

function getAllOriginalsForAdmin() {
  return db.prepare(`
    SELECT * FROM originals
    WHERE is_active = 1
    ORDER BY updated_at DESC, created_at DESC
  `).all().map(normalizeOriginalRow);
}

function getOriginalById(id) {
  const row = db.prepare(`
    SELECT * FROM originals
    WHERE id = ? AND is_active = 1
  `).get(id);

  return row ? normalizeOriginalRow(row) : null;
}

function getCurrentBid(originalId) {
  const art = getOriginalById(originalId);
  if (!art) return null;

  const highest = db.prepare(`
    SELECT MAX(amount) AS amount
    FROM bids
    WHERE original_id = ?
  `).get(originalId);

  return highest.amount || art.startingBid;
}

function createBid({ originalId, bidderId, bidderName, bidderEmail, amount }) {
  const result = db.prepare(`
    INSERT INTO bids (original_id,bidder_id,bidder_name,bidder_email,amount)
    VALUES (?,?,?,?,?)
  `).run(originalId, bidderId || null, bidderName, bidderEmail, Math.round(amount));

  return db.prepare(`
    SELECT id, original_id, bidder_id, bidder_name, bidder_email, amount, created_at
    FROM bids
    WHERE id = ?
  `).get(result.lastInsertRowid);
}

function getBidsForOriginal(originalId) {
  return db.prepare(`
    SELECT id,bidder_id,bidder_name,bidder_email,amount,created_at
    FROM bids
    WHERE original_id=?
    ORDER BY amount DESC, created_at ASC
  `).all(originalId);
}

function getWinningBid(originalId) {
  return db.prepare(`
    SELECT id,original_id,bidder_id,bidder_name,bidder_email,amount,created_at
    FROM bids
    WHERE original_id=?
    ORDER BY amount DESC, created_at ASC
    LIMIT 1
  `).get(originalId);
}

function getSecondHighestBid(originalId) {
  return db.prepare(`
    SELECT id,original_id,bidder_id,bidder_name,bidder_email,amount,created_at
    FROM bids
    WHERE original_id=?
    ORDER BY amount DESC, created_at ASC
    LIMIT 1 OFFSET 1
  `).get(originalId);
}

function markOriginalStatus(originalId, status) {
  db.prepare(`UPDATE originals SET status=? WHERE id=?`).run(status, originalId);
}

function updateOriginalEndsAt(originalId, endsAt) {
  db.prepare(`UPDATE originals SET ends_at=? WHERE id=?`).run(endsAt, originalId);
}

function createOriginalArtwork(item) {
  const payload = {
    id: item.id,
    title: item.title,
    medium: item.medium,
    size: item.size,
    year: item.year,
    description: item.description,
    startingBid: Math.round(Number(item.startingBid)),
    bidIncrement: Math.round(Number(item.bidIncrement)),
    endsAt: item.endsAt,
    imageUrl: item.imageUrl || "",
    colorOne: item.colorOne || "#f4f4f4",
    colorTwo: item.colorTwo || "#d8d8d8",
    widthIn: item.widthIn === null || item.widthIn === undefined || item.widthIn === "" ? null : Number(item.widthIn),
    heightIn: item.heightIn === null || item.heightIn === undefined || item.heightIn === "" ? null : Number(item.heightIn),
    depthIn: item.depthIn === null || item.depthIn === undefined || item.depthIn === "" ? null : Number(item.depthIn),
    weightLb: item.weightLb === null || item.weightLb === undefined || item.weightLb === "" ? null : Number(item.weightLb),
    status: item.status || "draft",
    autoChargeEnabled: item.autoChargeEnabled ? 1 : 0
  };

  db.prepare(`
    INSERT INTO originals
    (id,title,medium,size,year,description,starting_bid,bid_increment,ends_at,image_url,color_one,color_two,width_in,height_in,depth_in,weight_lb,status,auto_charge_enabled,created_at,updated_at)
    VALUES
    (@id,@title,@medium,@size,@year,@description,@startingBid,@bidIncrement,@endsAt,@imageUrl,@colorOne,@colorTwo,@widthIn,@heightIn,@depthIn,@weightLb,@status,@autoChargeEnabled,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  `).run(payload);

  return getOriginalById(payload.id);
}

function updateOriginalArtwork(id, item) {
  const payload = {
    id,
    title: item.title,
    medium: item.medium,
    size: item.size,
    year: item.year,
    description: item.description,
    startingBid: Math.round(Number(item.startingBid)),
    bidIncrement: Math.round(Number(item.bidIncrement)),
    endsAt: item.endsAt,
    imageUrl: item.imageUrl || "",
    colorOne: item.colorOne || "#f4f4f4",
    colorTwo: item.colorTwo || "#d8d8d8",
    widthIn: item.widthIn === null || item.widthIn === undefined || item.widthIn === "" ? null : Number(item.widthIn),
    heightIn: item.heightIn === null || item.heightIn === undefined || item.heightIn === "" ? null : Number(item.heightIn),
    depthIn: item.depthIn === null || item.depthIn === undefined || item.depthIn === "" ? null : Number(item.depthIn),
    weightLb: item.weightLb === null || item.weightLb === undefined || item.weightLb === "" ? null : Number(item.weightLb),
    status: item.status || "draft",
    autoChargeEnabled: item.autoChargeEnabled ? 1 : 0
  };

  db.prepare(`
    UPDATE originals
    SET title=@title,
        medium=@medium,
        size=@size,
        year=@year,
        description=@description,
        starting_bid=@startingBid,
        bid_increment=@bidIncrement,
        ends_at=@endsAt,
        image_url=@imageUrl,
        color_one=@colorOne,
        color_two=@colorTwo,
        width_in=@widthIn,
        height_in=@heightIn,
        depth_in=@depthIn,
        weight_lb=@weightLb,
        status=@status,
        auto_charge_enabled=@autoChargeEnabled,
        updated_at=CURRENT_TIMESTAMP
    WHERE id=@id AND is_active=1
  `).run(payload);

  return getOriginalById(id);
}

function archiveOriginalArtwork(id) {
  db.prepare(`
    UPDATE originals
    SET is_active=0,
        status='archived',
        updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(id);
}

function markOriginalPaymentPending(originalId) { markOriginalStatus(originalId, "payment_pending"); }
function markOriginalSold(originalId) { markOriginalStatus(originalId, "sold"); }
function markOriginalAutoChargeProcessing(originalId) { markOriginalStatus(originalId, "auto_charge_processing"); }
function markOriginalAutoChargeFailed(originalId) { markOriginalStatus(originalId, "auto_charge_failed"); }

function getEndedActiveOriginalsForAutoCharge() {
  return db.prepare(`
    SELECT * FROM originals
    WHERE is_active = 1
      AND status = 'active'
      AND auto_charge_enabled = 1
      AND datetime(ends_at) <= datetime('now')
      AND EXISTS (SELECT 1 FROM bids WHERE bids.original_id = originals.id)
    ORDER BY ends_at ASC
  `).all().map(normalizeOriginalRow);
}

function getPrints() {
  return db.prepare(`
    SELECT * FROM prints
    WHERE is_active=1 AND status='active'
    ORDER BY created_at DESC
  `).all().map(mapPrint);
}

function getAllPrintsForAdmin() {
  return db.prepare(`
    SELECT * FROM prints
    WHERE is_active=1
    ORDER BY updated_at DESC, created_at DESC
  `).all().map(mapPrint);
}

function getPrintById(id) {
  const row = db.prepare(`
    SELECT * FROM prints
    WHERE id=? AND is_active=1
  `).get(id);

  return row ? mapPrint(row) : null;
}

function upsertPrintfulPrint(item) {
  const existing = item.printfulSyncVariantId
    ? db.prepare(`SELECT * FROM prints WHERE printful_sync_variant_id = ?`).get(String(item.printfulSyncVariantId))
    : null;

  const id = existing?.id || item.id || `printful-${slugify(item.title)}-${item.printfulSyncVariantId || item.printfulProductId}`;

  const payload = {
    id,
    title: item.title || "Untitled Print",
    productType: item.productType || "Printful product",
    sizes: item.sizes || "See product details",
    price: Math.round(Number(item.price || 0)) || 35,
    description: item.description || "Made-to-order product fulfilled through Printful.",
    checkoutUrl: item.checkoutUrl || "",
    imageUrl: item.imageUrl || "",
    colorOne: item.colorOne || "#f4f4f4",
    colorTwo: item.colorTwo || "#d8d8d8",
    printfulVariantId: item.printfulVariantId ? String(item.printfulVariantId) : "",
    printfulSyncVariantId: item.printfulSyncVariantId ? String(item.printfulSyncVariantId) : "",
    printfulProductId: item.printfulProductId ? String(item.printfulProductId) : "",
    printfulCurrency: item.printfulCurrency || "USD",
    printFileUrl: item.printFileUrl || "",
    source: "printful"
  };

  if (existing) {
    db.prepare(`
      UPDATE prints
      SET title=@title,
          product_type=@productType,
          sizes=@sizes,
          price=@price,
          description=@description,
          checkout_url=@checkoutUrl,
          image_url=@imageUrl,
          color_one=@colorOne,
          color_two=@colorTwo,
          printful_variant_id=@printfulVariantId,
          printful_sync_variant_id=@printfulSyncVariantId,
          printful_product_id=@printfulProductId,
          printful_currency=@printfulCurrency,
          print_file_url=@printFileUrl,
          source=@source,
          status='active',
          is_active=1,
          printful_synced_at=CURRENT_TIMESTAMP,
          updated_at=CURRENT_TIMESTAMP
      WHERE id=@id
    `).run(payload);

    return { action: "updated", id: payload.id, title: payload.title };
  }

  db.prepare(`
    INSERT INTO prints
    (id,title,product_type,sizes,price,description,checkout_url,image_url,color_one,color_two,printful_variant_id,printful_sync_variant_id,printful_product_id,printful_currency,print_file_url,source,status,is_active,printful_synced_at,created_at,updated_at)
    VALUES
    (@id,@title,@productType,@sizes,@price,@description,@checkoutUrl,@imageUrl,@colorOne,@colorTwo,@printfulVariantId,@printfulSyncVariantId,@printfulProductId,@printfulCurrency,@printFileUrl,@source,'active',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  `).run(payload);

  return { action: "created", id: payload.id, title: payload.title };
}

function upsertPrintfulPrints(items) {
  const upsertMany = db.transaction((rows) => rows.map((row) => upsertPrintfulPrint(row)));
  return upsertMany(items);
}

function createOrUpdateBidder({
  name,
  email,
  phone,
  location,
  shippingName,
  shippingLine1,
  shippingLine2,
  shippingCity,
  shippingState,
  shippingPostalCode,
  shippingCountry,
  stripeCustomerId,
  stripeSetupSessionId,
  termsAccepted,
  autoChargeAuthorized
}) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const existing = db.prepare(`SELECT * FROM bidders WHERE email = ?`).get(normalizedEmail);

  const payload = {
    name: String(name || "").trim(),
    email: normalizedEmail,
    phone: String(phone || "").trim(),
    location: String(location || "").trim(),
    shippingName: String(shippingName || name || "").trim(),
    shippingLine1: String(shippingLine1 || "").trim(),
    shippingLine2: String(shippingLine2 || "").trim(),
    shippingCity: String(shippingCity || "").trim(),
    shippingState: String(shippingState || "").trim(),
    shippingPostalCode: String(shippingPostalCode || "").trim(),
    shippingCountry: String(shippingCountry || "US").trim().toUpperCase(),
    stripeCustomerId: stripeCustomerId || existing?.stripe_customer_id || "",
    stripeSetupSessionId: stripeSetupSessionId || existing?.stripe_setup_session_id || "",
    termsAccepted: termsAccepted ? 1 : existing?.terms_accepted || 0,
    autoChargeAuthorized: autoChargeAuthorized ? 1 : existing?.auto_charge_authorized || 0
  };

  if (existing) {
    db.prepare(`
      UPDATE bidders
      SET name=@name,
          phone=@phone,
          location=@location,
          shipping_name=@shippingName,
          shipping_line1=@shippingLine1,
          shipping_line2=@shippingLine2,
          shipping_city=@shippingCity,
          shipping_state=@shippingState,
          shipping_postal_code=@shippingPostalCode,
          shipping_country=@shippingCountry,
          stripe_customer_id=@stripeCustomerId,
          stripe_setup_session_id=@stripeSetupSessionId,
          terms_accepted=@termsAccepted,
          auto_charge_authorized=@autoChargeAuthorized,
          terms_accepted_at=CASE WHEN @termsAccepted = 1 THEN COALESCE(terms_accepted_at, CURRENT_TIMESTAMP) ELSE terms_accepted_at END,
          updated_at=CURRENT_TIMESTAMP
      WHERE email=@email
    `).run(payload);

    return getBidderByEmail(normalizedEmail);
  }

  const result = db.prepare(`
    INSERT INTO bidders
    (name,email,phone,location,shipping_name,shipping_line1,shipping_line2,shipping_city,shipping_state,shipping_postal_code,shipping_country,stripe_customer_id,stripe_setup_session_id,terms_accepted,auto_charge_authorized,terms_accepted_at,approved_to_bid,payment_method_saved,blocked)
    VALUES
    (@name,@email,@phone,@location,@shippingName,@shippingLine1,@shippingLine2,@shippingCity,@shippingState,@shippingPostalCode,@shippingCountry,@stripeCustomerId,@stripeSetupSessionId,@termsAccepted,@autoChargeAuthorized,CASE WHEN @termsAccepted = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,0,0,0)
  `).run(payload);

  return getBidderById(result.lastInsertRowid);
}

function getBidderById(id) {
  const row = db.prepare(`SELECT * FROM bidders WHERE id = ?`).get(id);
  return mapBidder(row);
}

function getBidderByEmail(email) {
  const row = db.prepare(`SELECT * FROM bidders WHERE email = ?`).get(String(email || "").trim().toLowerCase());
  return mapBidder(row);
}

function getBidderByStripeSessionId(sessionId) {
  const row = db.prepare(`SELECT * FROM bidders WHERE stripe_setup_session_id = ?`).get(sessionId);
  return mapBidder(row);
}

function getAllBidders() {
  return db.prepare(`
    SELECT * FROM bidders
    ORDER BY created_at DESC
  `).all().map(mapBidder);
}

function markBidderSetupComplete({ stripeSessionId, stripeSetupIntentId, stripeCustomerId, stripePaymentMethodId }) {
  const row = db.prepare(`SELECT * FROM bidders WHERE stripe_setup_session_id = ?`).get(stripeSessionId);
  if (!row) return null;

  db.prepare(`
    UPDATE bidders
    SET stripe_setup_intent_id = ?,
        stripe_customer_id = COALESCE(NULLIF(?, ''), stripe_customer_id),
        stripe_payment_method_id = COALESCE(NULLIF(?, ''), stripe_payment_method_id),
        payment_method_saved = 1,
        approved_to_bid = CASE WHEN blocked = 0 AND terms_accepted = 1 AND auto_charge_authorized = 1 THEN 1 ELSE approved_to_bid END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(stripeSetupIntentId || "", stripeCustomerId || "", stripePaymentMethodId || "", row.id);

  return getBidderById(row.id);
}

function setBidderApproval(id, approved) {
  db.prepare(`
    UPDATE bidders
    SET approved_to_bid = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(approved ? 1 : 0, id);

  return getBidderById(id);
}

function setBidderBlocked(id, blocked) {
  db.prepare(`
    UPDATE bidders
    SET blocked = ?,
        approved_to_bid = CASE WHEN ? = 1 THEN 0 ELSE approved_to_bid END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(blocked ? 1 : 0, blocked ? 1 : 0, id);

  return getBidderById(id);
}

function createPayment({
  kind,
  originalId = null,
  printId = null,
  bidId = null,
  bidderId = null,
  stripeSessionId,
  stripePaymentIntentId = null,
  checkoutUrl,
  customerName = "",
  customerEmail = "",
  subtotalAmount = null,
  shippingAmount = 0,
  totalAmount = null,
  amount,
  shippingJson = null,
  status = "pending",
  failureReason = null
}) {
  const finalSubtotal = subtotalAmount == null ? amount : subtotalAmount;
  const finalTotal = totalAmount == null ? amount : totalAmount;
  const result = db.prepare(`
    INSERT INTO payments
    (kind,original_id,print_id,bid_id,bidder_id,stripe_session_id,stripe_payment_intent_id,checkout_url,customer_name,customer_email,subtotal_amount,shipping_amount,total_amount,amount,shipping_json,status,failure_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    kind,
    originalId,
    printId,
    bidId,
    bidderId,
    stripeSessionId,
    stripePaymentIntentId,
    checkoutUrl,
    customerName,
    customerEmail,
    Math.round(finalSubtotal || 0),
    Math.round(shippingAmount || 0),
    Math.round(finalTotal || amount || 0),
    Math.round(amount),
    shippingJson ? JSON.stringify(shippingJson) : null,
    status,
    failureReason
  );

  return db.prepare(`SELECT * FROM payments WHERE id=?`).get(result.lastInsertRowid);
}

function createAutoChargeAttempt({ originalId, bidId, bidderId, subtotalAmount, shippingAmount, totalAmount }) {
  try {
    const result = db.prepare(`
      INSERT INTO auction_charge_attempts
      (original_id,bid_id,bidder_id,subtotal_amount,shipping_amount,total_amount,status)
      VALUES (?,?,?,?,?,?,'started')
    `).run(originalId, bidId, bidderId || null, Math.round(subtotalAmount), Math.round(shippingAmount), Math.round(totalAmount));
    return db.prepare(`SELECT * FROM auction_charge_attempts WHERE id=?`).get(result.lastInsertRowid);
  } catch (error) {
    if (String(error.message || "").includes("UNIQUE")) return null;
    throw error;
  }
}

function updateAutoChargeAttempt({ attemptId, status, stripePaymentIntentId = null, failureReason = null }) {
  db.prepare(`
    UPDATE auction_charge_attempts
    SET status=?,
        stripe_payment_intent_id=COALESCE(?, stripe_payment_intent_id),
        failure_reason=?,
        updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(status, stripePaymentIntentId, failureReason, attemptId);
}

function getAutoChargeAttempts() {
  return db.prepare(`
    SELECT * FROM auction_charge_attempts
    ORDER BY created_at DESC
  `).all();
}

function getPaymentByStripeSessionId(stripeSessionId) {
  return db.prepare(`
    SELECT * FROM payments
    WHERE stripe_session_id=?
  `).get(stripeSessionId);
}

function markPaymentPaid(stripeSessionId) {
  db.prepare(`
    UPDATE payments
    SET status='paid', paid_at=CURRENT_TIMESTAMP
    WHERE stripe_session_id=?
  `).run(stripeSessionId);
}

function setPaymentPrintfulOrderId(paymentId, printfulOrderId) {
  db.prepare(`
    UPDATE payments
    SET printful_order_id=?
    WHERE id=?
  `).run(printfulOrderId, paymentId);
}

function getLatestPaymentForOriginal(originalId) {
  return db.prepare(`
    SELECT * FROM payments
    WHERE original_id=?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(originalId);
}

function getPaidPaymentForOriginal(originalId) {
  return db.prepare(`
    SELECT * FROM payments
    WHERE original_id=? AND status='paid'
    LIMIT 1
  `).get(originalId);
}

module.exports = {
  getOriginals,
  getAllOriginalsForAdmin,
  getOriginalById,
  getCurrentBid,
  createBid,
  getBidsForOriginal,
  getWinningBid,
  getSecondHighestBid,
  markOriginalStatus,
  updateOriginalEndsAt,
  createOriginalArtwork,
  updateOriginalArtwork,
  archiveOriginalArtwork,
  markOriginalPaymentPending,
  markOriginalSold,
  markOriginalAutoChargeProcessing,
  markOriginalAutoChargeFailed,
  getEndedActiveOriginalsForAutoCharge,
  getPrints,
  getAllPrintsForAdmin,
  getPrintById,
  upsertPrintfulPrint,
  upsertPrintfulPrints,
  createOrUpdateBidder,
  getBidderById,
  getBidderByEmail,
  getBidderByStripeSessionId,
  getAllBidders,
  markBidderSetupComplete,
  setBidderApproval,
  setBidderBlocked,
  createPayment,
  createAutoChargeAttempt,
  updateAutoChargeAttempt,
  getAutoChargeAttempts,
  getPaymentByStripeSessionId,
  markPaymentPaid,
  setPaymentPrintfulOrderId,
  getLatestPaymentForOriginal,
  getPaidPaymentForOriginal
};
