const PRINTFUL_BASE_URL = "https://api.printful.com";
let countriesCache = null;
let countriesRequest = null;

async function getShippingCountries() {
  if (countriesCache && countriesCache.expires > Date.now()) return countriesCache.countries;
  if (countriesRequest) return countriesRequest;
  countriesRequest = (async () => {
    // Country/address metadata is public and does not require store credentials.
    const response = await fetch(`${PRINTFUL_BASE_URL}/countries`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error("Could not load shipping countries. Please try again.");
    const data = await response.json();
    if (!Array.isArray(data.result) || !data.result.length) throw new Error("Printful returned an invalid country list.");
    const countries = data.result.filter((country) => /^[A-Z]{2}$/.test(country.code) && country.name).map((country) => ({
      code: country.code, name: country.name,
      states: Array.isArray(country.states) ? country.states.map(({ code, name }) => ({ code, name })) : []
    }));
    if (!countries.some((country) => country.code === "US")) throw new Error("Printful returned an incomplete country list.");
    countriesCache = { countries, expires: Date.now() + 60 * 60 * 1000 };
    return countries;
  })();
  try { return await countriesRequest; }
  finally { countriesRequest = null; }
}

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
      body,
      signal: AbortSignal.timeout(20000)
    });
  }

  let response = await attempt("bearer");
  if (response.status === 401) response = await attempt("basic");

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!response.ok) {
    const detail = data?.error?.message || data?.message || response.statusText;
    throw Object.assign(new Error(`Printful API error ${response.status}: ${detail}`), { statusCode: response.status });
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
  const mockupFile = files.find((file) => file.type === "preview" && (file.preview_url || file.thumbnail_url || file.url)) || {};
  return firstDefined(mockupFile.preview_url, mockupFile.thumbnail_url, variant.preview_url, variant.thumbnail_url, product.thumbnail_url, product.preview_url, "");
}

function pickImageUrls(product, variant) {
  const files = toArray(variant.files);
  const mockupFiles = files.filter((file) => file.type === "preview");
  const fullSize = [variant.preview_url, ...mockupFiles.map((file) => file.preview_url), product.preview_url].filter(Boolean);
  if (fullSize.length) return [...new Set(fullSize)];
  const fallback = [variant.thumbnail_url, ...mockupFiles.map((file) => file.thumbnail_url), product.thumbnail_url].filter(Boolean);
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
    sizes: variant.size || pickSize(productName, variantName),
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
    printfulOptions: Array.isArray(variant.options) ? variant.options : [],
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
  const item = print.printfulVariantId
    ? { variant_id: Number(print.printfulVariantId), quantity: 1 }
    : print.printfulSyncVariantId
      ? { external_variant_id: String(print.printfulSyncVariantId), quantity: 1 }
      : null;
  if (!item) return null;
  const options = Array.isArray(print.printfulOptions) ? print.printfulOptions.filter((option) => option?.id && option.value !== undefined) : [];
  if (options.length) item.options = options;
  return item;
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

async function estimatePrintCosts({ print, recipient, shippingMethod = "STANDARD", retailPrice }) {
  const item = shippingRateItem(print);
  if (!item) throw new Error("This print is missing its Printful variant information.");
  const retailCosts = recipient.country_code !== "US" && Number.isFinite(Number(retailPrice)) && Number(retailPrice) > 0
    ? { currency: "USD", subtotal: Number(retailPrice).toFixed(2) } : undefined;
  if (retailCosts) item.retail_price = retailCosts.subtotal;
  const data = await printfulFetch("/orders/estimate-costs", {
    method: "POST",
    body: JSON.stringify({ shipping: shippingMethod, recipient, items: [item], retail_costs: retailCosts })
  });
  return data?.result || data?.data || data;
}

async function fetchPrintfulProductsForWebsite() {
  const productSummaries = await getStoreProducts();
  const importedProducts = [];
  const skipped = [];
  let complete = true;

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
      complete = false;
      skipped.push({ reason: error.message, product: summary.name || summary.title || String(productId) });
    }
  }

  return { importedProducts, skipped, complete, printfulProductCount: productSummaries.length };
}

async function configureWebhooks({ url, types = ["package_shipped"] }) {
  return printfulFetch("/webhooks", {
    method: "POST",
    body: JSON.stringify({ url, types })
  });
}

async function createDraftOrderFromStripeSession({ payment, print, stripeSession }) {
  const autoCreate = String(process.env.PRINTFUL_AUTO_CREATE_DRAFT_ORDER || "false").toLowerCase() === "true";
  if (!autoCreate) { console.log("[printful skipped] PRINTFUL_AUTO_CREATE_DRAFT_ORDER is false."); return { skipped: true, reason: "Auto creation disabled." }; }
  if (!getPrintfulToken()) { console.log("[printful skipped] PRINTFUL_API_KEY is not configured."); return { skipped: true, reason: "Missing Printful API key." }; }

  let storedRecipient = null;
  try { storedRecipient = payment.shipping_json ? JSON.parse(payment.shipping_json).recipient : null; } catch { storedRecipient = null; }
  const address = stripeSession.customer_details?.address;
  const name = storedRecipient?.name || stripeSession.customer_details?.name;
  if ((!address && !storedRecipient) || !name) { console.log("[printful skipped] Missing shipping address/customer name."); return { skipped: true, reason: "Missing customer shipping details." }; }

  const recipient = {
    name,
    address1: storedRecipient?.address1 || address?.line1,
    address2: storedRecipient ? storedRecipient.address2 || "" : address?.line2 || "",
    city: storedRecipient?.city || address?.city,
    state_code: storedRecipient ? storedRecipient.state_code || "" : address?.state || "",
    country_code: storedRecipient?.country_code || address?.country,
    zip: storedRecipient ? storedRecipient.zip || "" : address?.postal_code || "",
    phone: storedRecipient?.phone || stripeSession.customer_details?.phone || "",
    email: storedRecipient?.email || payment.customer_email || stripeSession.customer_details?.email || "",
    ...(storedRecipient?.country_code === "BR" && storedRecipient.tax_number ? { tax_number: storedRecipient.tax_number } : {})
  };

  let shippingJson = {};
  try { shippingJson = payment.shipping_json ? JSON.parse(payment.shipping_json) : {}; } catch { shippingJson = {}; }
  const retailCosts = recipient.country_code !== "US" && Number.isFinite(Number(payment.subtotal_amount)) && Number(payment.subtotal_amount) > 0
    ? { currency: "USD", subtotal: Number(payment.subtotal_amount).toFixed(2) } : undefined;
  const externalId = `rayan-payment-${payment.id}`;
  const findExisting = async () => {
    try {
      const data = await printfulFetch(`/orders/@${encodeURIComponent(externalId)}`);
      return { printfulOrderId: data?.result?.id || data?.id || data?.data?.id, data };
    } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
    }
  };
  const existing = await findExisting();
  if (existing?.printfulOrderId) return existing;
  const createOrder = async (payload) => {
    try {
      const data = await printfulFetch("/orders?confirm=false", { method: "POST", body: JSON.stringify(payload) });
      return { printfulOrderId: data?.result?.id || data?.id || data?.data?.id, data };
    } catch (error) {
      // Recover after a duplicate ID or a lost POST response without ordering twice.
      const recovered = await findExisting();
      if (recovered?.printfulOrderId) return recovered;
      throw error;
    }
  };

  if (print.printfulSyncVariantId) {
    const item = { sync_variant_id: Number(print.printfulSyncVariantId), quantity: 1 };
    if (retailCosts) item.retail_price = retailCosts.subtotal;
    if (Array.isArray(print.printfulOptions) && print.printfulOptions.length) item.options = print.printfulOptions;
    const payload = { external_id: externalId, shipping: shippingJson.method || undefined, recipient, items: [item], retail_costs: retailCosts };
    return createOrder(payload);
  }

  if (print.printfulVariantId && print.printFileUrl) {
    const payload = { external_id: externalId, shipping: shippingJson.method || undefined, recipient, items: [{ variant_id: Number(print.printfulVariantId), quantity: 1, files: [{ url: print.printFileUrl }], ...(retailCosts ? { retail_price: retailCosts.subtotal } : {}) }], retail_costs: retailCosts };
    return createOrder(payload);
  }

  console.log("[printful skipped] Product has no Printful sync variant or manual variant/file data.", print.id);
  return { skipped: true, reason: "Missing Printful sync variant data." };
}

module.exports = { printfulFetch, getShippingCountries, getStoreProducts, getStoreProductDetails, fetchPrintfulProductsForWebsite, configureWebhooks, getShippingRatesForPrint, estimatePrintCosts, createDraftOrderFromStripeSession };
