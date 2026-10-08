const assert = require("node:assert/strict");
const path = require("node:path");

module.exports = async function checkAuctionRecovery(browser, base, output) {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 950 } });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.clock.install();
      const response = {
        email: "test@example.com",
        original: { title: "The Light", medium: "Acrylic", size: "9 x 12 inches", imageUrl: "/images/the-light.jpg" },
        auction: { id: "recovery-test", status: "open", currentCents: 30000, minimumCents: 31000,
          bidCount: 1, startsAt: Date.now() - 1000, endsAt: Date.now() + 86400000,
          biddingEnabled: true, latestBid: { status: "authorizing" } }
      };
      let failRead = false, failVerification = true, reads = 0, holdQuote = false, releaseQuote;
      await page.route("**/*", (route) => {
        const request = route.request();
        if (!request.url().startsWith(base)) return route.abort();
        if (!request.url().includes("/api/auctions/recovery-test")) return route.continue();
        if (request.url().endsWith("/quote")) {
          const reply = () => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
            quoteId: "account-review", maximumCents: 55000, shippingCents: 4500, maximumTotalCents: 59500,
            consentText: "Test bid authorization for the current account."
          }) });
          if (holdQuote) return new Promise((resolve) => { releaseQuote = () => reply().then(resolve); });
          return reply();
        }
        const failed = request.method() === "POST" ? failVerification : failRead;
        if (request.method() === "GET") reads++;
        return route.fulfill({ status: failed ? 503 : 200, contentType: "application/json",
          body: JSON.stringify(failed ? { error: "Temporary test outage" } : request.method() === "POST" ? { refreshed: true } : response) });
      });

      await page.goto(`${base}/auction.html?id=recovery-test&returned=1`);
      await page.waitForFunction(() => document.querySelector("#auctionNotice")?.textContent.includes("retry automatically"));
      assert.equal(await page.locator("#bidForm").isVisible(), true, "Stripe failure must preserve the auction UI");
      assert.match(await page.locator("#auctionBidNotice").innerText(), /pending/);
      await page.locator('[name="maximum"]').fill("550");
      response.auction.currentCents = 32000;
      let previousReads = reads;
      await page.clock.runFor(30000);
      await page.waitForFunction(() => document.querySelector("[data-price]")?.textContent.includes("320"));
      assert.ok(reads > previousReads, "A failed verification request must not block current bid updates");
      assert.equal(await page.locator('[name="maximum"]').inputValue(), "550", "Polling must preserve edits");

      failVerification = false;
      response.auction.latestBid = { status: "accepted" };
      response.auction.mine = { maxCents: 50000, shippingCents: 4500, leading: true };
      await page.clock.runFor(30000);
      await page.waitForFunction(() => document.querySelector("#auctionBidNotice")?.textContent.startsWith("Your bid was accepted."));
      assert.doesNotMatch(await page.locator("#auctionBidNotice").innerText(), /pending/);
      assert.equal(await page.locator("#auctionNotice").innerText(), "", "Recovered updates clear temporary errors");

      const originalMine = { ...response.auction.mine, recipient: { name: "First Bidder", address1: "1 First Street", address2: "Unit A", city: "Raleigh", state_code: "NC", zip: "27601" } };
      response.auction.mine = originalMine;
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await page.waitForFunction(() => document.querySelector('[name="address1"]').value === "1 First Street");
      await page.locator('[name="maximum"]').fill("550");
      await page.locator("#bidForm button").click();
      await page.locator("#bidReview").waitFor({ state: "visible" });
      await page.locator("#agreeCharge").check();

      response.email = null; response.auction.mine = null; response.auction.latestBid = null;
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await page.locator("#loginForm").waitFor({ state: "visible" });
      assert.equal(await page.locator("#bidReview").isVisible(), false, "Expired sign-in must discard the previous review");
      assert.equal(await page.locator("#agreeCharge").isChecked(), false);
      assert.equal(await page.locator("#authorizeBid").isDisabled(), true);
      assert.equal(await page.locator("[data-consent]").innerText(), "");
      for (const name of ["maximum", "name", "address1", "address2", "city", "postalCode", "state"]) {
        assert.equal(await page.locator(`#bidForm [name="${name}"]`).inputValue(), "", `Must clear ${name} on sign-in expiry`);
      }

      response.email = "second@example.com";
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await page.locator("#bidForm").waitFor({ state: "visible" });
      assert.equal(await page.locator('[name="state"]').isDisabled(), false);
      assert.equal(await page.locator('[name="address1"]').evaluate((e) => e.readOnly), false);
      for (const [name, value] of Object.entries({ maximum: "550", name: "Second Bidder", address1: "2 Second Street", city: "Raleigh", postalCode: "27602" })) await page.locator(`#bidForm [name="${name}"]`).fill(value);
      await page.locator('[name="state"]').selectOption("NC");
      holdQuote = true;
      await page.locator("#bidForm button").click();
      await assert.doesNotReject(async () => { for (let i = 0; !releaseQuote && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10)); assert.ok(releaseQuote); });
      response.email = "test@example.com"; response.auction.mine = originalMine; response.auction.latestBid = { status: "accepted" };
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await page.waitForFunction(() => document.querySelector('[name="address1"]').value === "1 First Street");
      await releaseQuote(); holdQuote = false;
      await page.locator("#bidForm button").waitFor({ state: "visible" });
      await page.waitForFunction(() => !document.querySelector("#bidForm button").disabled);
      assert.equal(await page.locator("#bidReview").isVisible(), false, "A late quote from a different account must not reopen consent");
      assert.equal(await page.locator('[name="state"]').isDisabled(), true);
      assert.equal(await page.locator('[name="address1"]').evaluate((e) => e.readOnly), true);

      response.auction.latestBid = { status: "rejected", reason: "Card setup expired. Review your bid and try again while bidding is open." };
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await page.waitForFunction(() => document.querySelector("#auctionBidNotice").textContent.includes("Card setup expired"));
      assert.equal(await page.locator("#bidForm").isVisible(), true);
      assert.doesNotMatch(await page.locator("#auctionBidNotice").innerText(), /pending/);
      response.auction.latestBid = { status: "accepted" };

      for (const [state, expected] of [
        ["cancelled", "This auction was cancelled"], ["closing", "Bidding has ended"],
        ["charging", "Payment is being processed"], ["payment_required", "automatic payment did not complete"],
        ["unpaid", "payment deadline has passed"], ["review", "under review"], ["paid", "Payment confirmed"]
      ]) {
        response.auction.status = state;
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await page.waitForFunction((text) => document.querySelector("[data-mine]")?.textContent.includes(text), expected);
        assert.doesNotMatch(await page.locator("[data-mine]").innerText(), /You are leading/);
        assert.equal(await page.locator("#bidForm").isVisible(), false);
        assert.equal(await page.locator("#auctionBidNotice").innerText(), "");
      }
      response.auction.mine.leading = false;
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await page.waitForFunction(() => document.querySelector("[data-mine]")?.textContent.includes("did not win"));
      await page.screenshot({ path: path.join(output, `auction-ended-${width}.png`), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);

      failRead = true;
      await page.reload();
      await page.waitForFunction(() => document.querySelector("#auctionContent")?.textContent.includes("could not be loaded"));
      failRead = false;
      response.auction.status = "cancelled";
      response.email = null;
      response.auction.mine = null;
      await page.clock.runFor(30000);
      await page.locator("#loginForm").waitFor({ state: "visible" });
      assert.equal(await page.locator("[data-state]").innerText(), "cancelled", "Initial load failures must recover automatically");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  console.log("Auction outage recovery, account isolation, expired setup notices, and ended-state checks passed at all three viewports.");
};
