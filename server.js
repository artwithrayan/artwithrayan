require("dotenv").config({ quiet: true });
const { redactSecrets, publicErrorMessage, logger } = require("./src/security");

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const morgan = require("morgan");
const validator = require("validator");
const Stripe = require("stripe");

const db = require("./src/db");
const email = require("./src/email");
const printful = require("./src/printful");
const sheets = require("./src/google-sheets");
const { estimateSelfFulfillmentShipping, hasOriginalShippingProfile, estimateOriginalDestinationShipping } = require("./src/shipping");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY, { timeout: 20000, maxNetworkRetries: 1 }) : null;
const { createOrderProcessor } = require("./src/order-processing");
const orders = createOrderProcessor({ db, stripe, printful, sheets, email });
const STRIPE_CARD_PERCENT = 0.029;
const STRIPE_CARD_FIXED_CENTS = 30;
const ORIGINAL_INQUIRY_EMAIL = "artwithrayan@gmail.com";

function grossUpStripeCardFee(amount) {
  const baseCents = Math.max(0, Math.round(Number(amount || 0) * 100));
  const grossCents = Math.ceil((baseCents + STRIPE_CARD_FIXED_CENTS) / (1 - STRIPE_CARD_PERCENT));
  return {
    baseCents,
    grossCents,
    adjustmentCents: grossCents - baseCents,
    baseAmount: baseCents / 100,
    grossAmount: grossCents / 100,
    adjustmentAmount: (grossCents - baseCents) / 100
  };
}

function prettyStripeAdjustedPrice(amount) {
  const grossCents = grossUpStripeCardFee(amount).grossCents;
  return Math.ceil(grossCents / 100);
}

app.set("trust proxy", 1);

const quoteRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many shipping requests. Please wait a minute and try again." }
});

const checkoutRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many checkout attempts. Please wait and try again." }
});

const footerScriptHash = crypto.createHash("sha256").update('document.getElementById("year").textContent = new Date().getFullYear();').digest("base64");
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", `'sha256-${footerScriptHash}'`],
  scriptSrcAttr: ["'none'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", "https:", "data:"],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'none'"],
  frameAncestors: ["'none'"],
  formAction: ["'self'", "https://checkout.stripe.com"],
  upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null
} } }));
app.use(morgan((tokens, req, res) => [
  tokens.method(req, res),
  redactSecrets(req.path),
  tokens.status(req, res),
  tokens["response-time"](req, res), "ms"
].join(" ")));

app.use((req, res, next) => {
  let pathname;
  try { pathname = decodeURIComponent(req.path); }
  catch { return res.status(400).json({ error: "Invalid request path." }); }
  if (/(?:^|\/)\.[^/]+|(?:^|\/)(?:node_modules|src|scripts|tests|secrets)(?:\/|$)|\.(?:pem|key|p12|pfx|sqlite(?:-shm|-wal)?|db|log|bak|map)$/i.test(pathname)
    || /(?:^|\/)(?:credentials[^/]*|[^/]*service[-_]account[^/]*)\.json$/i.test(pathname)) {
    return res.status(404).json({ error: "Not found." });
  }
  next();
});

function requireStripe(res) {
  if (!stripe) {
    res.status(500).json({ error: "Stripe is not configured. Add STRIPE_SECRET_KEY to your .env file." });
    return false;
  }
  return true;
}

function requireAdmin(req, res) {
  return res.status(404).json({ error: "Admin tools are disabled." });
}

// Stripe webhooks must receive the raw body.
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!requireStripe(res)) return;
  if (!process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: "Stripe webhook signing is not configured." });

  let event;

  try {
    const signature = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    return res.status(400).send("Invalid webhook signature.");
  }

  try {
    logger.log(`[stripe webhook] received ${event.type}${event.data?.object?.id ? ` (${event.data.object.id})` : ""}`);
    // Acknowledge retired auction events without modifying cards, orders, or inventory.
    const eventObject = event.data?.object;
    if (String(eventObject?.metadata?.kind || "").includes("auction") || String(eventObject?.metadata?.flow || "").startsWith("art_auction_") || eventObject?.metadata?.bidId || eventObject?.mode === "setup") {
      return res.json({ received: true, handled: false });
    }
    if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
      const expiredSession = event.data.object;
      let expiredPayment = db.getPaymentByStripeSessionId(expiredSession.id);
      if (!expiredPayment && expiredSession.metadata?.localPaymentId) {
        expiredPayment = db.getPaymentById(expiredSession.metadata.localPaymentId);
        if (expiredPayment) db.setPaymentCheckoutSession(expiredPayment.id, expiredSession.id, expiredPayment.checkout_url);
      }
      if (expiredPayment) db.cancelCheckoutReservation(expiredSession.id);
      return res.json({ received: true, handled: Boolean(expiredPayment) });
    }

    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object;

      if (session.mode === "payment") {
        if (session.payment_status !== "paid") return res.json({ received: true, awaitingPayment: true });
        let payment = db.getPaymentByStripeSessionId(session.id);
        if (!payment && session.metadata?.localPaymentId) {
          payment = db.getPaymentById(session.metadata.localPaymentId);
          if (payment) db.setPaymentCheckoutSession(payment.id, session.id, payment.checkout_url);
        }
        if (!payment) {
          logger.error(`[stripe webhook] no local payment record for completed session ${session.id}`);
          return res.status(500).json({ error: "Payment record not found." });
        }
        payment = db.confirmCheckoutPayment(session);
        const result = await orders.processPayment(payment.id);
        if (result.errors.length) return res.status(503).json({ error: "Order recorded; integration retry scheduled." });
      }
    }

    res.json({ received: true });
  } catch (error) {
    logger.error("Webhook handling error:", error);
    res.status(500).json({ error: "Webhook handler failed." });
  }
});

app.post("/api/printful/webhook", express.json(), async (req, res) => {
  const webhookSecret = String(process.env.PRINTFUL_WEBHOOK_SECRET || "").trim();
  if (!webhookSecret || req.query.token !== webhookSecret) return res.status(401).json({ error: "Invalid webhook token." });

  const event = req.body || {};
  if (event.type !== "package_shipped" && event.type !== "shipment_sent") return res.json({ received: true, handled: false });

  const shipment = event.data?.shipment || {};
  const order = event.data?.order || {};
  const printfulOrderId = order.id || order.external_id;
  if (!printfulOrderId) return res.json({ received: true, handled: false });

  const payment = db.getPaymentByPrintfulOrderId(printfulOrderId);
  if (!payment) {
    logger.warn(`[printful webhook] no payment found for order ${printfulOrderId}`);
    return res.json({ received: true, handled: false });
  }

  const trackingNumber = String(shipment.tracking_number || "");
  const trackingUrl = String(shipment.tracking_url || "");
  db.setPaymentTracking(payment.id, {
    number: trackingNumber,
    url: trackingUrl,
    carrier: String(shipment.carrier || ""),
    service: String(shipment.service || shipment.shipping_service_name || "")
  });

  const result = await orders.processPayment(payment.id);
  if (result.errors.length) return res.status(503).json({ error: "Shipment recorded; integration retry scheduled." });

  logger.log(`[printful webhook] tracking recorded for order ${printfulOrderId}`);
  return res.json({ received: true, handled: true });
});

app.use(express.json());
app.use("/api/auctions", (req, res) => res.status(410).json({ error: "Website auctions are no longer available." }));
app.use("/api/admin", (req, res) => res.status(404).json({ error: "Admin tools are disabled." }));
app.use("/api/bidders", (req, res) => res.status(404).json({ error: "Bidding is no longer available." }));
app.use("/api/originals/:id/bids", (req, res) => res.status(404).json({ error: "Bidding is no longer available." }));
app.use(express.static(path.join(__dirname, "public"), {
  dotfiles: "deny",
  setHeaders(res, filename) {
    if (/\.(?:webp|jpg|png)$/i.test(filename)) res.setHeader("Cache-Control", "public, max-age=86400");
    if (/-[a-f0-9]{12}(?:-\d+)?\.webp$/i.test(filename)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
}));

app.get("/api/health", (req, res) => res.json({
  ok: true,
  message: "Rayan Rao Art API is running.",
  emailEnabled: email.isEmailEnabled(),
  resendConfigured: Boolean(process.env.RESEND_API_KEY),
  trackingEmailReady: email.isEmailEnabled()
}));

app.get("/api/site-content", (req, res) => res.json({ content: db.getSiteContent() }));

function publicOriginalDetails({ price, startingBid, ...art }) {
  return { ...art, canEstimateShipping: hasOriginalShippingProfile(art.id) && ["active", "payment_pending"].includes(art.status) };
}

app.get("/api/originals", (req, res) => {
  db.releaseStaleCheckoutReservations();
  res.json({ originals: db.getOriginals().map(publicOriginalDetails), inquiryEmail: ORIGINAL_INQUIRY_EMAIL });
});

app.get("/api/originals/:id", (req, res) => {
  db.releaseStaleCheckoutReservations();
  const art = db.getOriginalById(req.params.id);
  if (!art) return res.status(404).json({ error: "Original artwork not found." });
  res.json({ original: publicOriginalDetails(art), inquiryEmail: ORIGINAL_INQUIRY_EMAIL });
});

app.post("/api/originals/:id/shipping-estimate", quoteRateLimit, (req, res) => {
  const art = db.getOriginalById(req.params.id);
  if (!art) return res.status(404).json({ error: "Original artwork not found." });
  if (!["active", "payment_pending"].includes(art.status)) return res.status(409).json({ error: "This original is not available for purchase." });
  try {
    res.json({ estimate: estimateOriginalDestinationShipping(art.id, req.body || {}) });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: publicErrorMessage(error, "Please email for a shipping quote.") });
  }
});

app.post(["/api/originals/:id/shipping-rate", "/api/originals/:id/checkout"], (req, res) => {
  res.status(410).json({
    error: "Original paintings are available by email inquiry only. Please contact us to arrange your purchase and shipping.",
    inquiryEmail: ORIGINAL_INQUIRY_EMAIL
  });
});

app.post("/api/print-club/checkout", checkoutRateLimit, async (req, res) => {
  if (String(process.env.PRINT_CLUB_ENABLED || "false").toLowerCase() !== "true") {
    return res.status(503).json({ error: "Print Club checkout is coming soon." });
  }
  if (!requireStripe(res)) return;
  const priceId = String(process.env.STRIPE_PRINT_CLUB_PRICE_ID || "").trim();
  if (!priceId) {
    return res.status(503).json({
      error: "Print Club checkout is opening soon. Please check back shortly."
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      shipping_address_collection: { allowed_countries: ["US"] },
      billing_address_collection: "auto",
      allow_promotion_codes: true,
      subscription_data: {
        metadata: {
          kind: "monthly_print_club",
          cutoffDay: "20",
          shipsByDay: "5"
        }
      },
      metadata: { kind: "monthly_print_club" },
      success_url: `${BASE_URL}/success.html?membership=print-club&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/print-club.html`
    });

    res.json({ checkoutUrl: session.url });
  } catch (error) {
    logger.error("[print club checkout]", error);
    res.status(502).json({ error: "Could not open Print Club checkout. Please try again." });
  }
});

app.get("/api/prints", (req, res) => {
  db.releaseStaleCheckoutReservations();
  const groups = new Map();
  db.getPrints().forEach((print) => {
    const key = print.artworkKey || print.id;
    if (!groups.has(key)) groups.set(key, { key, title: print.artworkKey || print.title, imageUrl: print.imageUrl, colorOne: print.colorOne, colorTwo: print.colorTwo, description: print.description, products: [] });
    groups.get(key).products.push({ ...print, price: prettyStripeAdjustedPrice(print.price) });
  });
  res.json({ artworks: [...groups.values()] });
});

function printShippingRecipient(body) {
  const country = String(body.country || "US").trim().toUpperCase();
  const taxDigits = String(body.taxNumber || "").trim().replace(/[\s./-]/g, "");
  const taxNumber = /^\d{11}$/.test(taxDigits) ? taxDigits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4")
    : /^\d{14}$/.test(taxDigits) ? taxDigits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : taxDigits;
  return { name: String(body.name || "").trim(), address1: String(body.address1 || "").trim(), address2: String(body.address2 || "").trim(), city: String(body.city || "").trim(), state_code: String(body.state || "").trim().toUpperCase(), country_code: country, zip: String(body.postalCode || "").trim(), email: String(body.email || "").trim().toLowerCase(), phone: String(body.phone || "").trim().replace(/[\s().-]/g, ""), ...(country === "BR" ? { tax_number: taxNumber } : {}) };
}

function shippingPostalCodeRequired(countryCode) {
  return validator.isPostalCodeLocales.includes(countryCode);
}

function validatePrintShippingRecipient(recipient) {
  if (recipient.name.length < 2) return "Please enter the recipient name.";
  if (!validator.isEmail(recipient.email)) return "Please enter a valid email address.";
  if (!recipient.address1 || !recipient.city) return "Please complete the shipping address.";
  if (!/^[A-Z]{2}$/.test(recipient.country_code)) return "Please select a valid shipping country.";
  if (["US", "CA", "AU"].includes(recipient.country_code) && (!recipient.state_code || !recipient.zip)) return "Please enter your state or province and postal code.";
  if (shippingPostalCodeRequired(recipient.country_code) && !recipient.zip) return "Please enter your postal code.";
  if (recipient.country_code !== "US" && !/^\+[1-9]\d{6,14}$/.test(recipient.phone)) return "Please enter a phone number with country code, such as +44 7700 900123, for international delivery.";
  if (recipient.country_code === "BR" && (!/^\d{3}\.\d{3}\.\d{3}-\d{2}$|^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/.test(recipient.tax_number) || !validator.isTaxID(recipient.tax_number.replace(/[./-]/g, ""), "pt-BR"))) return "Please enter a valid recipient CPF or CNPJ tax ID for delivery to Brazil.";
  return null;
}

app.get("/api/shipping/countries", async (_req, res) => {
  try {
    const countries = (await printful.getShippingCountries()).map((country) => ({ ...country, postalCodeRequired: shippingPostalCodeRequired(country.code) }));
    res.set("Cache-Control", "public, max-age=3600").json({ countries });
  } catch (error) { res.status(502).json({ error: publicErrorMessage(error, "Could not load shipping destinations. Please try again.") }); }
});

async function getPrintShippingQuote(print, body) {
  const recipient = printShippingRecipient(body);
  if (print.fulfillmentType === "self" && recipient.country_code !== "US") throw Object.assign(new Error("Self-fulfilled prints currently ship within the US only."), { statusCode: 400 });
  const validationError = validatePrintShippingRecipient(recipient);
  if (validationError) { const error = new Error(validationError); error.statusCode = 400; throw error; }
  if (print.fulfillmentType === "self") {
    const estimate = estimateSelfFulfillmentShipping(print, recipient);
    return { recipient, rate: { id: "SELF_ESTIMATE", name: "Estimated shipping", currency: "USD" }, shippingAmount: estimate.total, fulfillmentTax: 0, fulfillmentCosts: null, selfEstimate: estimate };
  }
  if (recipient.country_code !== "US") {
    const countries = await printful.getShippingCountries();
    const country = countries.find((candidate) => candidate.code === recipient.country_code);
    if (!country) throw Object.assign(new Error("This shipping country is not supported."), { statusCode: 400 });
    if (country.states.length && recipient.state_code && !country.states.some((state) => state.code === recipient.state_code)) throw Object.assign(new Error("Please select a valid state or province for your country."), { statusCode: 400 });
  }
  const rates = await printful.getShippingRatesForPrint({ print, recipient });
  const rate = rates.find((candidate) => candidate.id === "STANDARD") || rates[0];
  if (!rate) throw Object.assign(new Error("This product cannot currently be shipped to your address. Please choose another destination or contact artwithrayan@gmail.com."), { statusCode: 400 });
  if (!Number.isFinite(Number(rate.rate)) || Number(rate.rate) < 0) throw new Error("Printful returned an invalid shipping rate. Please try again.");
  if (String(rate.currency).toUpperCase() !== "USD") throw new Error("Could not quote shipping in USD. Please contact artwithrayan@gmail.com.");
  const estimate = await printful.estimatePrintCosts({ print, recipient, shippingMethod: rate.id, retailPrice: prettyStripeAdjustedPrice(print.price) });
  const costs = estimate?.costs;
  if (!costs || String(costs.currency || rate.currency).toUpperCase() !== "USD") throw new Error("Could not estimate fulfillment costs in USD. Please contact artwithrayan@gmail.com.");
  if ([costs.shipping ?? rate.rate, costs.tax || 0, costs.vat || 0].some((amount) => !Number.isFinite(Number(amount)) || Number(amount) < 0)) throw new Error("Printful returned an invalid cost estimate. Please try again.");
  const fulfillmentTax = Math.round((Number(costs.tax || 0) + Number(costs.vat || 0)) * 100) / 100;
  return {
    recipient,
    rate,
    shippingAmount: Math.round(Number(costs.shipping ?? rate.rate) * 100) / 100,
    fulfillmentTax,
    fulfillmentCosts: {
      currency: costs.currency || rate.currency || "USD",
      subtotal: Number(costs.subtotal || 0),
      discount: Number(costs.discount || 0),
      shipping: Number(costs.shipping || 0),
      digitization: Number(costs.digitization || 0),
      additionalFee: Number(costs.additional_fee || 0),
      fulfillmentFee: Number(costs.fulfillment_fee || 0),
      tax: Number(costs.tax || 0),
      vat: Number(costs.vat || 0),
      total: Number(costs.total || 0)
    }
  };
}

app.post("/api/prints/:id/shipping-rate", quoteRateLimit, async (req, res) => {
  try {
    const print = db.getPrintById(req.params.id);
    if (!print) return res.status(404).json({ error: "Print product not found." });
    const quote = await getPrintShippingQuote(print, req.body);
    const customerPrice = prettyStripeAdjustedPrice(print.price);
    res.json({ shipping: quote.shippingAmount, fulfillmentTax: quote.fulfillmentTax, product: customerPrice, total: customerPrice + quote.shippingAmount + quote.fulfillmentTax, currency: quote.rate.currency, method: quote.rate.id, name: quote.rate.name, delivery: { min: quote.rate.minDeliveryDays, max: quote.rate.maxDeliveryDays }, estimate: quote.selfEstimate || null });
  } catch (error) { res.status(error.statusCode || 502).json({ error: publicErrorMessage(error, "Could not calculate shipping. Please try again or contact us.") }); }
});

app.post("/api/prints/:id/checkout", checkoutRateLimit, async (req, res) => {
  if (!requireStripe(res)) return;
  const print = db.getPrintById(req.params.id);
  if (!print) return res.status(404).json({ error: "Print product not found." });
  if (print.fulfillmentType === "self" && print.stockQuantity !== null && print.stockQuantity <= 0) return res.status(409).json({ error: "This product is sold out." });

  let quote;
  try { quote = await getPrintShippingQuote(print, req.body); }
  catch (error) { return res.status(error.statusCode || 502).json({ error: publicErrorMessage(error, "Could not calculate shipping. Please try again or contact us.") }); }
  const { recipient, rate, shippingAmount, fulfillmentTax } = quote;
  const customerPrice = prettyStripeAdjustedPrice(print.price);
  const customerEmail = recipient.email;
  if (req.body.expectedTotal != null && Math.round(Number(req.body.expectedTotal) * 100) !== Math.round((customerPrice + shippingAmount + fulfillmentTax) * 100)) return res.status(409).json({ error: "The total changed. Please calculate shipping again." });
  const shippingCents = Math.round(shippingAmount * 100);
  const shouldReserveStock = print.fulfillmentType === "self" && print.stockQuantity !== null;
  if (shouldReserveStock && !db.reservePrintStock(print.id)) {
    return res.status(409).json({ error: "This product is currently unavailable or already being purchased." });
  }
  let payment = null;
  const sessionConfig = {
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [{ price_data: { currency: "usd", unit_amount: Math.round(customerPrice * 100), product_data: { name: print.title, description: `${print.productType} · ${print.sizes}` } }, quantity: 1 }],
    customer_email: customerEmail,
    payment_intent_data: { receipt_email: customerEmail },
    metadata: { kind: "print", printId: print.id, fulfillmentType: print.fulfillmentType || "printful" },
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE_URL}/prints.html`
  };
  sessionConfig.line_items.push({ price_data: { currency: "usd", unit_amount: shippingCents, product_data: { name: "Shipping", description: rate.name || "Shipping" } }, quantity: 1 });
  if (fulfillmentTax > 0) sessionConfig.line_items.push({ price_data: { currency: "usd", unit_amount: Math.round(fulfillmentTax * 100), product_data: { name: "Printful fulfillment tax", description: "Estimated Printful fulfillment tax" } }, quantity: 1 });
  try {
    payment = db.createPayment({ kind: "print", printId: print.id, stripeSessionId: `pending-${crypto.randomUUID()}`, checkoutUrl: "pending", customerName: recipient.name, customerEmail, subtotalAmount: customerPrice, shippingAmount, totalAmount: customerPrice + shippingAmount + fulfillmentTax, amount: customerPrice + shippingAmount + fulfillmentTax, shippingJson: { recipient, method: rate.id, name: rate.name, rate: shippingAmount, fulfillmentTax, fulfillmentCosts: quote.fulfillmentCosts || null, currency: rate.currency, estimate: quote.selfEstimate || null }, status: "pending" });
    sessionConfig.metadata.localPaymentId = String(payment.id);
    const session = await stripe.checkout.sessions.create(sessionConfig);
    db.setPaymentCheckoutSession(payment.id, session.id, session.url, session.expires_at);
    res.json({ checkoutUrl: session.url });
  } catch (error) {
    if (payment) db.markPaymentFailed(payment.stripe_session_id, redactSecrets(error.message || "Could not create checkout."));
    if (shouldReserveStock) db.releasePrintStockReservation(print.id);
    throw error;
  }
});

app.put("/api/admin/prints/:id/artwork-group", requireAdmin, (req, res) => {
  const print = db.getPrintById(req.params.id);
  if (!print) return res.status(404).json({ error: "Print product not found." });
  const artworkKey = String(req.body.artworkKey || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!artworkKey) return res.status(400).json({ error: "Enter an artwork group name." });
  const updated = db.setPrintArtworkKey(print.id, artworkKey);
  res.json({ message: "Artwork group updated.", print: updated });
});

app.get("/api/admin/prints", requireAdmin, (req, res) => res.json({ prints: db.getAllPrintsForAdmin() }));
app.post("/api/admin/printful/sync-products", requireAdmin, async (req, res) => {
  try {
    const syncData = await printful.fetchPrintfulProductsForWebsite();
    const results = db.upsertPrintfulPrints(syncData.importedProducts);
    res.json({ message: "Printful product sync complete.", printfulProductCount: syncData.printfulProductCount, importedVariantCount: syncData.importedProducts.length, createdCount: results.filter((item) => item.action === "created").length, updatedCount: results.filter((item) => item.action === "updated").length, results, skipped: syncData.skipped });
  } catch (error) {
    logger.error("Printful sync failed:", error);
    res.status(500).json({ error: publicErrorMessage(error, "Printful sync failed.") });
  }
});

app.get(["/", "/index.html", "/originals.html", "/prints.html", "/success.html", "/cancel.html", "/privacy.html", "/shipping-policy.html", "/refunds-returns.html", "/terms.html"], (req, res) => {
  const file = req.path === "/" ? "index.html" : req.path.replace("/", "");
  res.sendFile(path.join(__dirname, "public", file));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  logger.error(`[request failed] ${req.method} ${req.path}: ${error.message}`);
  const status = error.type === "entity.parse.failed" ? 400 : 500;
  res.status(status).json({ error: status === 400 ? "Invalid request data." : "Could not complete this request. Please try again." });
});

let printfulSyncRunning = false;
async function syncPrintfulOnStartup(force = false) {
  if (!process.env.PRINTFUL_API_KEY || printfulSyncRunning) return;
  if (!force && String(process.env.PRINTFUL_SYNC_ON_STARTUP || "false").toLowerCase() !== "true") return;
  printfulSyncRunning = true;
  try {
    const syncData = await printful.fetchPrintfulProductsForWebsite();
    const results = db.upsertPrintfulPrints(syncData.importedProducts);
    if (syncData.complete) db.archiveMissingPrintfulPrints(syncData.importedProducts.map((item) => item.printfulSyncVariantId));
    logger.log(`[printful startup sync] imported ${syncData.importedProducts.length} variants from ${syncData.printfulProductCount} products; created ${results.filter((item) => item.action === "created").length}, updated ${results.filter((item) => item.action === "updated").length}`);
    if (syncData.skipped.length) logger.warn(`[printful startup sync] skipped ${syncData.skipped.length} products or variants.`);
  } catch (error) {
    logger.error("[printful startup sync] failed:", error.message || error);
  } finally { printfulSyncRunning = false; }
}

async function configurePrintfulWebhookOnStartup() {
  if (String(process.env.PRINTFUL_WEBHOOK_ON_STARTUP || "false").toLowerCase() !== "true") return;
  const webhookUrl = String(process.env.PRINTFUL_WEBHOOK_URL || "").trim();
  if (!webhookUrl) {
    logger.error("[printful webhook setup] PRINTFUL_WEBHOOK_URL is not configured.");
    return;
  }
  if (/your-site\.onrender\.com/i.test(webhookUrl)) {
    logger.error("[printful webhook setup] Refusing to configure the placeholder your-site.onrender.com URL.");
    return;
  }
  try {
    const result = await printful.configureWebhooks({ url: webhookUrl, types: ["package_shipped"] });
    const configuredUrl = result?.result?.url || webhookUrl;
    let safeConfiguredUrl = "[invalid webhook URL]";
    try {
      const parsed = new URL(configuredUrl);
      safeConfiguredUrl = `${parsed.origin}${parsed.pathname}`;
    } catch { /* Keep a non-sensitive fallback for malformed configuration. */ }
    logger.log(`[printful webhook setup] configured ${safeConfiguredUrl}`);
    logger.warn("[printful webhook setup] Set PRINTFUL_WEBHOOK_ON_STARTUP=false after this one-time setup.");
  } catch (error) {
    logger.error("[printful webhook setup] failed:", error.message || error);
  }
}

function startServer() {
  const server = app.listen(PORT, async () => {
  logger.log(`Rayan Rao Art site running at http://localhost:${PORT}`);
  const releasedReservations = db.releaseStaleCheckoutReservations();
  if (releasedReservations) logger.log(`[checkout cleanup] released ${releasedReservations} stale reservation(s)`);
  await syncPrintfulOnStartup();
  await configurePrintfulWebhookOnStartup();
  if (!email.isEmailEnabled()) logger.warn("[tracking] Verify a Resend domain and set RESEND_API_KEY and FROM_EMAIL before customer shipment emails can send.");
  await orders.tick().catch((error) => logger.error("[orders] retry worker:", error.message));
  });
  const retryTimer = setInterval(() => orders.tick().catch((error) => logger.error("[orders] retry worker:", error.message)), 60000);
  retryTimer.unref();
  const syncInterval = Number(process.env.PRINTFUL_SYNC_INTERVAL_MS ?? 900000);
  const syncTimer = Number.isFinite(syncInterval) && syncInterval >= 60000
    ? setInterval(() => syncPrintfulOnStartup(true), syncInterval) : null;
  syncTimer?.unref();
  server.on("close", () => { clearInterval(retryTimer); if (syncTimer) clearInterval(syncTimer); });
  return server;
}

if (require.main === module) startServer();
module.exports = { app, startServer, orders };
