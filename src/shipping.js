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

module.exports = {
  parseSizeInches,
  estimateOriginalShipping
};
