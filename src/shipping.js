function parseSizeInches(sizeText) {
  const cleaned = String(sizeText || "")
    .toLowerCase()
    .replace(/×/g, "x")
    .replace(/by/g, "x");

  const matches = cleaned.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)(?:\s*x\s*(\d+(?:\.\d+)?))?/);

  if (!matches) {
    return { widthIn: 18, heightIn: 24, depthIn: 2 };
  }

  return {
    widthIn: Number(matches[1]),
    heightIn: Number(matches[2]),
    depthIn: matches[3] ? Number(matches[3]) : 2
  };
}

function roundDollars(value) {
  return Math.max(0, Math.round(Number(value || 0)));
}

function estimateOriginalShipping(original) {
  const parsed = parseSizeInches(original.size);
  const widthIn = Number(original.widthIn || original.width_in || parsed.widthIn || 18);
  const heightIn = Number(original.heightIn || original.height_in || parsed.heightIn || 24);
  const depthIn = Number(original.depthIn || original.depth_in || parsed.depthIn || 2);
  const weightLb = Number(original.weightLb || original.weight_lb || 4);

  const longestSide = Math.max(widthIn, heightIn, depthIn);
  const secondSide = [widthIn, heightIn, depthIn].sort((a, b) => b - a)[1];
  const area = widthIn * heightIn;

  let packageType = "rigid mailer / small art box";
  let materials = 8;
  let packingLabor = 6;
  let carrierEstimate = 14;
  let oversizedSurcharge = 0;

  if (longestSide <= 20 && secondSide <= 16 && weightLb <= 3) {
    packageType = "rigid mailer";
    materials = 6;
    packingLabor = 5;
    carrierEstimate = 10;
  } else if (longestSide <= 30 && secondSide <= 24 && weightLb <= 8) {
    packageType = "small art box";
    materials = 10;
    packingLabor = 8;
    carrierEstimate = 18;
  } else if (longestSide <= 40 && secondSide <= 30 && weightLb <= 15) {
    packageType = "large art box";
    materials = 16;
    packingLabor = 12;
    carrierEstimate = 30;
  } else {
    packageType = "oversized art box / reinforced packaging";
    materials = 30;
    packingLabor = 20;
    carrierEstimate = 55;
    oversizedSurcharge = 20;
  }

  const areaProtection = Math.ceil(area / 300) * 2;
  const weightSurcharge = Math.max(0, Math.ceil(weightLb - 5) * 2);
  const dimensionalSurcharge = longestSide > 36 ? 12 : 0;

  const subtotal = materials + packingLabor + carrierEstimate + areaProtection + weightSurcharge + dimensionalSurcharge + oversizedSurcharge;
  const contingency = Math.ceil(subtotal * 0.08);
  const total = roundDollars(subtotal + contingency);

  return {
    total,
    currency: "usd",
    packageType,
    dimensions: {
      widthIn,
      heightIn,
      depthIn,
      weightLb
    },
    breakdown: {
      materials: roundDollars(materials + areaProtection),
      packingLabor: roundDollars(packingLabor),
      carrierEstimate: roundDollars(carrierEstimate),
      weightSurcharge: roundDollars(weightSurcharge),
      dimensionalSurcharge: roundDollars(dimensionalSurcharge + oversizedSurcharge),
      contingency: roundDollars(contingency)
    },
    note: "Estimated domestic US shipping/packaging charge based on artwork size, estimated weight, protective materials, packaging labor, and a carrier-cost buffer. This is not a live carrier quote."
  };
}

function estimateSelfFulfillmentShipping(product, recipient = {}) {
  const base = estimateOriginalShipping({
    size: `${product.widthIn || 12} x ${product.heightIn || 8} x ${product.depthIn || 1}`,
    widthIn: product.widthIn,
    heightIn: product.heightIn,
    depthIn: product.depthIn,
    weightLb: product.weightLb || 1
  });
  const state = String(recipient.state_code || "").toUpperCase();
  const zoneSurcharge = ["AK", "HI"].includes(state) ? 18 : ["WA", "OR", "CA", "NV", "AZ"].includes(state) ? 4 : 0;
  const total = base.total + zoneSurcharge;

  return {
    ...base,
    total,
    packageType: `${base.packageType} · self-fulfilled`,
    breakdown: { ...base.breakdown, addressZoneSurcharge: zoneSurcharge },
    note: "Estimated domestic US shipping and packing charge based on the product profile, destination state, packing materials, labor, carrier estimate, and a small buffer. This is not a live carrier quote."
  };
}

const ORIGINAL_SHIPPING_PROFILES = {
  "the-light": { weightLb: 4, packingAllowance: 14 },
  "sun-beam": { weightLb: 4, packingAllowance: 16 }
};
const ORIGINAL_DESTINATION_BANDS = [
  { states: ["NC"], carrierAllowance: 20 },
  { states: ["SC", "VA", "WV", "TN", "GA", "KY"], carrierAllowance: 24 },
  { states: ["AL", "FL", "MS", "MD", "DC", "DE", "PA", "NJ", "NY", "OH"], carrierAllowance: 28 },
  { states: ["AR", "LA", "MO", "IL", "IN", "MI", "WI", "CT", "RI", "MA", "VT", "NH", "ME", "IA", "MN", "KS", "OK", "TX", "NE", "SD", "ND"], carrierAllowance: 32 },
  { states: ["CO", "NM", "WY", "MT", "ID", "UT", "AZ", "NV", "CA", "OR", "WA"], carrierAllowance: 38 }
];

function hasOriginalShippingProfile(id) {
  return Object.hasOwn(ORIGINAL_SHIPPING_PROFILES, id);
}

function estimateOriginalDestinationShipping(id, destination = {}) {
  if (!hasOriginalShippingProfile(id)) throw Object.assign(new Error("Shipping for this artwork is quoted by email."), { statusCode: 400 });
  const country = String(destination.country || "").trim().toUpperCase();
  const state = String(destination.state || "").trim().toUpperCase();
  if (!["US", "OTHER"].includes(country)) throw Object.assign(new Error("Choose a shipping destination."), { statusCode: 400 });
  if (country === "OTHER" || ["AK", "HI"].includes(state)) return {
    requiresManualQuote: true,
    note: "Please email for a shipping quote to Alaska, Hawaii, US territories, military addresses, or international destinations."
  };
  const band = ORIGINAL_DESTINATION_BANDS.find((entry) => entry.states.includes(state));
  if (!band) throw Object.assign(new Error("Choose a valid destination state."), { statusCode: 400 });
  const profile = ORIGINAL_SHIPPING_PROFILES[id];
  // Store allowances, not carrier tariffs: 25% headroom, rounded up to $5.
  const subtotal = band.carrierAllowance + profile.packingAllowance;
  const total = Math.ceil(subtotal * 1.25 / 5) * 5;
  return {
    requiresManualQuote: false, total, currency: "USD", originState: "NC",
    destinationState: state, weightLb: profile.weightLb,
    breakdown: { carrierAllowance: band.carrierAllowance, packingAllowance: profile.packingAllowance, buffer: total - subtotal },
    note: "Estimated shipping and protective packing from North Carolina, assuming a 4 lb package. Not a live carrier quote. Final cost, including any insurance, is confirmed by email after checking the packed dimensions and destination."
  };
}

module.exports = {
  parseSizeInches,
  estimateOriginalShipping,
  estimateSelfFulfillmentShipping,
  hasOriginalShippingProfile,
  estimateOriginalDestinationShipping
};
