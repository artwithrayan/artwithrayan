const { test } = require("node:test");
const assert = require("node:assert/strict");
const { estimateOriginalDestinationShipping, hasOriginalShippingProfile } = require("../src/shipping");

test("invalid states and unsupported originals cannot produce estimates", () => {
  for (const destination of [{}, { country: "FR" }, { country: "US", state: "XX" }, { country: "US" }]) {
    assert.throws(() => estimateOriginalDestinationShipping("the-light", destination));
  }
  for (const id of ["flower", "sold", "__proto__", "constructor"]) {
    assert.equal(hasOriginalShippingProfile(id), false);
    assert.throws(() => estimateOriginalDestinationShipping(id, { country: "US", state: "NC" }));
  }
});

for (const [id, fee] of [["sun-beam", 45], ["the-light", 50]]) test(`${id} has a fixed domestic fee and no international shipping`, () => {
  for (const state of ["NC", "CA", "AK", "HI"]) {
    const estimate = estimateOriginalDestinationShipping(id, { country: "US", state, total: 1 });
    assert.equal(estimate.total, fee);
    assert.equal(estimate.flatRate, true);
  }
  for (const country of ["OTHER", "AE", "CA"]) {
    assert.throws(() => estimateOriginalDestinationShipping(id, { country }), /No international shipping/);
  }
  assert.throws(() => estimateOriginalDestinationShipping(id, { country: "US", state: "XX" }));
});
