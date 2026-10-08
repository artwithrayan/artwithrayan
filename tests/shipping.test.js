const { test } = require("node:test");
const assert = require("node:assert/strict");
const { estimateOriginalDestinationShipping, hasOriginalShippingProfile } = require("../src/shipping");

test("original estimates use four-pound profiles, packing and a generous rounded buffer", () => {
  for (const id of ["the-light", "sun-beam"]) {
    let previous = 0;
    for (const state of ["NC", "VA", "NY", "TX", "CA"]) {
      const estimate = estimateOriginalDestinationShipping(id, { country: "US", state });
      assert.equal(estimate.weightLb, 4);
      assert.equal(estimate.originState, "NC");
      assert.equal(estimate.total % 5, 0);
      assert.ok(estimate.total >= previous);
      const { carrierAllowance, packingAllowance, buffer } = estimate.breakdown;
      assert.equal(estimate.total, carrierAllowance + packingAllowance + buffer);
      assert.ok(buffer >= (carrierAllowance + packingAllowance) * 0.25);
      assert.match(estimate.note, /Not a live carrier quote/);
      previous = estimate.total;
    }
  }
});

test("remote and international destinations require an individual quote, not a guessed fee", () => {
  for (const destination of [{ country: "US", state: "AK" }, { country: "US", state: "HI" }, { country: "OTHER" }]) {
    const estimate = estimateOriginalDestinationShipping("sun-beam", destination);
    assert.equal(estimate.requiresManualQuote, true);
    assert.equal(Object.hasOwn(estimate, "total"), false);
  }
});

test("invalid states and unsupported originals cannot produce estimates", () => {
  for (const destination of [{}, { country: "FR" }, { country: "US", state: "XX" }, { country: "US" }]) {
    assert.throws(() => estimateOriginalDestinationShipping("the-light", destination));
  }
  for (const id of ["flower", "sold", "__proto__", "constructor"]) {
    assert.equal(hasOriginalShippingProfile(id), false);
    assert.throws(() => estimateOriginalDestinationShipping(id, { country: "US", state: "NC" }));
  }
});
