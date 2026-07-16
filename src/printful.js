const PRINTFUL_BASE_URL = "https://api.printful.com";

function getPrintfulToken() {
  return process.env.PRINTFUL_API_KEY || "";
}

function authHeaders(mode = "bearer") {
  const token = getPrintfulToken();

  if (mode === "basic") {
    const encoded = Buffer.from(`${token}:`).toString("base64");
    return { Authorization: `Basic ${encoded}` };
  }

  return { Authorization: `Bearer ${token}` };
}

async function printfulFetch(path, options = {}) {
  const token = getPrintfulToken();

  if (!token) {
    throw new Error("PRINTFUL_API_KEY is not configured in .env.");
  }

  const url = path.startsWith("http") ? path : `${PRINTFUL_BASE_URL}${path}`;
  const method = options.method || "GET";
  const body = options.body;

  async function attempt(mode) {
    return fetch(url, {
      method,
      headers: {
        ...authHeaders(mode),
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      body
    });
  }

  let response = await attempt("bearer");
  if (response.status === 401) response = await attempt("basic");

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!response.ok) {
    const detail = data?.error?.message || data?.message || response.statusText;
    throw new Error(`Printful API error ${response.status}: ${detail}`);
  }

  return data;
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function normalizePrice(value) {
  const parsed = Number.parseFloat(String(value || "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) return 35;
  return Math.round(parsed);
}

function pickImageUrl(product, variant) {
  const files = toArray(variant.files);
  const firstFile = files.find((file) => file.preview_url || file.thumbnail_url || file.url) || {};
  return firstDefined(variant.thumbnail_url, variant.preview_url, firstFile.preview_url, firstFile.thumbnail_url, product.thumbnail_url, product.preview_url, "");
}

function pickImageUrls(product, variant) {
  const files = toArray(variant.files);
  const fullSize = [variant.preview_url, ...files.flatMap((file) => [file.preview_url, file.url]), product.preview_url].filter(Boolean);
  if (fullSize.length) return [...new Set(fullSize)];
  const fallback = [variant.thumbnail_url, ...files.map((file) => file.thumbnail_url), product.thumbnail_url].filter(Boolean);
  return [...new Set(fallback)];
}

function pickSize(productName, variantName) {
  const text = `${productName || ""} ${variantName || ""}`;
  const match = text.match(/\b\d{1,2}\s*[x×]\s*\d{1,2}\b/i);
  return match ? match[0].replace(/\s+/g, "") : "See Printful product";
}

function artworkKeyFromProductName(productName) {
  const match = String(productName || "").match(/[\"“]([^\"”]+)[\"”]/);
  if (!match) return "";
  return match[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeSyncedVariant(product, variant) {
  const productName = product.name || product.title || "Printful Product";
  const variantName = variant.name || variant.title || "";
  const syncVariantId = firstDefined(variant.id, variant.sync_variant_id);
  const catalogVariantId = firstDefined(variant.variant_id, variant.catalog_variant_id);
  const syncProductId = firstDefined(product.id, product.sync_product_id, variant.product_id);
  const retailPrice = firstDefined(variant.retail_price, variant.price, product.retail_price);
  const currency = firstDefined(variant.currency, product.currency, "USD");

  const combinedTitle = variantName && !variantName.toLowerCase().includes(productName.toLowerCase())
    ? `${productName} — ${variantName}`
    : productName;

  return {
    id: `printful-${syncVariantId || syncProductId}`,
    title: combinedTitle,
    productType: productName,
    sizes: pickSize(productName, variantName),
    price: normalizePrice(retailPrice),
    description: "Made-to-order product fulfilled through Printful.",
    checkoutUrl: "",
    imageUrl: pickImageUrl(product, variant),
    imageUrls: pickImageUrls(product, variant),
    colorOne: "#f4f4f4",
    colorTwo: "#d8d8d8",
    printfulVariantId: catalogVariantId ? String(catalogVariantId) : "",
    printfulSyncVariantId: syncVariantId ? String(syncVariantId) : "",
    printfulProductId: syncProductId ? String(syncProductId) : "",
    printfulCurrency: currency,
    printFileUrl: "",
    artworkKey: artworkKeyFromProductName(productName)
  };
}

async function getStoreProducts() {
  const data = await printfulFetch("/store/products");
  return toArray(data?.result || data?.data || data);
}

async function getStoreProductDetails(productId) {
  const data = await printfulFetch(`/store/products/${productId}`);
  return data?.result || data?.data || data;
}

function shippingRateItem(print) {
  if (print.printfulVariantId) return { variant_id: Number(print.printfulVariantId), quantity: 1 };
  if (print.printfulSyncVariantId) return { external_variant_id: String(print.printfulSyncVariantId), quantity: 1 };
  return null;
}

async function getShippingRatesForPrint({ print, recipient, currency = "USD" }) {
  const item = shippingRateItem(print);
  if (!item) throw new Error("This print is missing its Printful variant information.");
  const data = await printfulFetch("/shipping/rates", {
    method: "POST",
    body: JSON.stringify({ recipient, items: [item], currency, locale: "en_US" })
  });
  return toArray(data?.result || data?.data || data);
}

async function estimatePrintCosts({ print, recipient, shippingMethod = "STANDARD" }) {
  const item = shippingRateItem(print);
  if (!item) throw new Error("This print is missing its Printful variant information.");
  const data = await printfulFetch("/orders/estimate-costs", {
    method: "POST",
    body: JSON.stringify({ shipping: shippingMethod, recipient, items: [item] })
  });
  return data?.result || data?.data || data;
}

async function fetchPrintfulProductsForWebsite() {
  const productSummaries = await getStoreProducts();
  const importedProducts = [];
  const skipped = [];

  for (const summary of productSummaries) {
    const productId = firstDefined(summary.id, summary.sync_product_id);
    if (!productId) {
      skipped.push({ reason: "Missing product id", product: summary.name || summary.title || "Unknown" });
      continue;
    }

    try {
      const details = await getStoreProductDetails(productId);
      const product = details.sync_product || details.product || summary;
      const variants = toArray(details.sync_variants || details.variants || summary.sync_variants || summary.variants);

      if (!variants.length) {
        skipped.push({ reason: "No variants found", product: product.name || summary.name || productId });
        continue;
      }

      for (const variant of variants) {
        const synced = firstDefined(variant.synced, variant.is_synced, true);
        if (synced === false) {
          skipped.push({ reason: "Variant is not synced", product: product.name || productId, variant: variant.name || variant.id });
          continue;
        }

        const normalized = normalizeSyncedVariant(product, variant);
        if (!normalized.printfulSyncVariantId) {
          skipped.push({ reason: "Variant missing sync variant id", product: product.name || productId, variant: variant.name || variant.id });
          continue;
        }

        importedProducts.push(normalized);
      }
    } catch (error) {
      skipped.push({ reason: error.message, product: summary.name || summary.title || String(productId) });
    }
  }

  return { importedProducts, skipped, printfulProductCount: productSummaries.length };
}

async function createDraftOrderFromStripeSession({ payment, print, stripeSession }) {
  const autoCreate = String(process.env.PRINTFUL_AUTO_CREATE_DRAFT_ORDER || "false").toLowerCase() === "true";
  if (!autoCreate) { console.log("[printful skipped] PRINTFUL_AUTO_CREATE_DRAFT_ORDER is false."); return { skipped: true, reason: "Auto creation disabled." }; }
  if (!getPrintfulToken()) { console.log("[printful skipped] PRINTFUL_API_KEY is not configured."); return { skipped: true, reason: "Missing Printful API key." }; }

  const address = stripeSession.customer_details?.address;
  const name = stripeSession.customer_details?.name;
  if (!address || !name) { console.log("[printful skipped] Missing Stripe shipping address/customer name."); return { skipped: true, reason: "Missing customer shipping details." }; }

  const recipient = {
    name,
    address1: address.line1,
    address2: address.line2 || "",
    city: address.city,
    state_code: address.state || "",
    country_code: address.country,
    zip: address.postal_code
  };

  let shippingJson = {};
  try { shippingJson = payment.shipping_json ? JSON.parse(payment.shipping_json) : {}; } catch { shippingJson = {}; }

  if (print.printfulSyncVariantId) {
    const payload = { shipping: shippingJson.method || undefined, recipient, items: [{ sync_variant_id: Number(print.printfulSyncVariantId), quantity: 1 }] };
    const data = await printfulFetch("/orders?confirm=false", { method: "POST", body: JSON.stringify(payload) });
    return { printfulOrderId: data?.result?.id || data?.id || data?.data?.id, data };
  }

  if (print.printfulVariantId && print.printFileUrl) {
    const payload = { shipping: shippingJson.method || undefined, recipient, items: [{ variant_id: Number(print.printfulVariantId), quantity: 1, files: [{ url: print.printFileUrl }] }] };
    const data = await printfulFetch("/orders?confirm=false", { method: "POST", body: JSON.stringify(payload) });
    return { printfulOrderId: data?.result?.id || data?.id || data?.data?.id, data };
  }

  console.log("[printful skipped] Product has no Printful sync variant or manual variant/file data.", print.id);
  return { skipped: true, reason: "Missing Printful sync variant data." };
}

module.exports = { printfulFetch, getStoreProducts, getStoreProductDetails, fetchPrintfulProductsForWebsite, getShippingRatesForPrint, estimatePrintCosts, createDraftOrderFromStripeSession };
