const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const { createRequire } = require("node:module");
const f = require("./fixture.cjs");
const browserRequire = process.env.BROWSER_MODULES ? createRequire(path.join(process.env.BROWSER_MODULES, "package.json")) : require;
const { chromium } = browserRequire("playwright");

async function main() {
  const output = process.env.BROWSER_AUDIT_OUTPUT || path.join(f.tempDir, "screenshots");
  await fs.mkdir(output, { recursive: true });
  const server = f.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const results = [];
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    for (const width of [1440, 390, 320]) {
      const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 1000 : 844 }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
      for (const url of ["/", "/originals.html", "/prints.html", "/print-club.html", "/terms.html", "/privacy.html", "/shipping-policy.html", "/refunds-returns.html"]) {
        assert.equal((await page.goto(base + url)).status(), 200);
        await page.waitForLoadState("networkidle");
        for (const img of await page.locator("img").all()) {
          await img.scrollIntoViewIfNeeded();
          await img.evaluate((element) => element.decode());
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `Overflow: ${url} at ${width}`);
        assert.equal(await page.locator("img").evaluateAll((images) => images.some((image) => !image.complete || image.naturalWidth === 0)), false);
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: path.join(output, `${url === "/" ? "home" : path.parse(url).name}-${width}.png`), fullPage: true });
        results.push({ width, page: url, passed: true });
      }

      await page.goto(base + "/originals.html");
      await page.locator(".shine-button").first().click();
      const revealedSrc = await page.locator(".original-art-image img").first().getAttribute("src");
      assert.match(revealedSrc, /the-light-reveal.*\.webp$/);
      await page.locator(".shine-button").first().click();
      assert.match(await page.locator(".original-art-image img").first().getAttribute("src"), /the-light-[a-f0-9]+-\d+\.webp$/);
      const originalCatalog = await (await fetch(base + "/api/originals")).json();
      assert.equal(await page.locator(".purchase-original, .original-checkout-form, .shipping-box").count(), 0);
      assert.equal(await page.locator("dialog").count(), 0);
      for (const art of originalCatalog.originals) {
        const card = page.locator(`[data-original-id="${art.id}"]`);
        assert.equal(await card.locator(".price").count(), 0);
        assert.doesNotMatch(await card.innerText(), /\$\s*\d/);
        assert.match(await card.locator(".product-meta").innerText(), new RegExp(art.size.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        const inquiry = card.locator(".original-inquiry");
        if (art.status === "sold") {
          assert.equal(await inquiry.count(), 0);
          assert.equal(await card.locator(".original-status").innerText(), "Sold");
          continue;
        }
        assert.equal(await card.locator(".original-status").count(), 0);
        assert.equal(await inquiry.textContent(), "Email if interested in purchasing");
        const url = new URL(await inquiry.getAttribute("href"));
        assert.equal(url.protocol, "mailto:");
        assert.equal(url.pathname, "artwithrayan@gmail.com");
        assert.equal(url.searchParams.get("subject"), `Purchase inquiry: ${art.title}`);
        assert.ok(url.searchParams.get("body").includes(art.title));
        assert.ok(url.searchParams.get("body").includes(art.size));
        assert.doesNotMatch(url.searchParams.get("body"), /\$\s*\d/);
        assert.ok(url.searchParams.get("body").includes("pricing"));
        assert.equal(await card.locator(".original-contact-email").innerText(), "artwithrayan@gmail.com");
      }

      await page.goto(base + "/prints.html");
      await page.locator(".view-products").first().click();
      const dialog = page.locator("#printPurchaseDialog");
      await fillAddress(dialog);
      await dialog.locator(".quote-shipping").click();
      await page.waitForFunction(() => !document.querySelector("dialog button[type=submit]").disabled);
      const firstQuote = await dialog.locator(".notice").innerText();
      await dialog.locator(".variant-button").last().click();
      assert.equal(await dialog.locator("button[type=submit]").isDisabled(), true);
      assert.notEqual(await dialog.locator(".notice").innerText(), firstQuote);
      await dialog.locator(".quote-shipping").click();
      await page.waitForFunction(() => !document.querySelector("dialog button[type=submit]").disabled);
      assert.notEqual(await dialog.locator(".notice").innerText(), firstQuote);
      await dialog.locator('[name="postalCode"]').fill("27602");
      assert.equal(await dialog.locator("button[type=submit]").isDisabled(), true);

      let releaseQuote;
      await page.route("**/api/prints/*/shipping-rate", async (route) => {
        await new Promise((resolve) => { releaseQuote = resolve; });
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ shipping: 4.99, total: 27.75, fulfillmentTax: 0.76 }) });
      });
      const started = page.waitForRequest((request) => request.url().endsWith("/shipping-rate"));
      await dialog.locator(".quote-shipping").click();
      await started;
      await dialog.locator('[name="postalCode"]').fill("27603");
      releaseQuote();
      await page.waitForFunction(() => !document.querySelector("dialog .quote-shipping").disabled);
      assert.equal(await dialog.locator("button[type=submit]").isDisabled(), true, "A stale response must not enable checkout");
      await page.unroute("**/api/prints/*/shipping-rate");
      await dialog.locator(".quote-shipping").click();
      await page.waitForFunction(() => !document.querySelector("dialog button[type=submit]").disabled);
      await page.screenshot({ path: path.join(output, `print-dialog-${width}.png`), fullPage: true });
      await dialog.locator('[name="country"]').selectOption("CA");
      assert.equal(await dialog.locator("button[type=submit]").isDisabled(), true);
      assert.equal(await dialog.locator('[name="phone"]').getAttribute("required"), "");
      assert.equal(await dialog.locator('[data-international-notice]').isVisible(), true);
      await dialog.locator('[name="state"]').selectOption("ON");
      await dialog.locator('[name="city"]').fill("Toronto");
      await dialog.locator('[name="postalCode"]').fill("M5V 2T6");
      await dialog.locator('[name="phone"]').fill("+1 416 555 0123");
      await dialog.locator(".quote-shipping").click();
      await page.waitForFunction(() => !document.querySelector("dialog button[type=submit]").disabled);
      await dialog.locator('[name="country"]').selectOption("GB");
      assert.equal(await dialog.locator("button[type=submit]").isDisabled(), true);
      assert.equal(await dialog.locator('[name="state"]').evaluate((element) => element.tagName), "INPUT");
      assert.equal(await dialog.locator('[name="state"]').getAttribute("required"), null);
      assert.equal(await dialog.locator('[name="postalCode"]').getAttribute("required"), "");
      await dialog.locator('[name="city"]').fill("London");
      await dialog.locator('[name="postalCode"]').fill("SW1A 1AA");
      await dialog.locator('[name="phone"]').fill("+44 7700 900123");
      await dialog.locator(".quote-shipping").click();
      await page.waitForFunction(() => !document.querySelector("dialog button[type=submit]").disabled);
      assert.equal(await dialog.evaluate((element) => element.scrollWidth > element.clientWidth + 1), false);
      await page.screenshot({ path: path.join(output, `international-dialog-${width}.png`), fullPage: true });
      await dialog.locator("form").evaluate((form) => { form.dataset.fulfillmentType = "self"; form.dispatchEvent(new Event("quoteinvalidated")); });
      assert.equal(await dialog.locator('[name="country"]').inputValue(), "US");
      assert.equal(await dialog.locator('[name="country"] option').count(), 1);
      assert.equal(await dialog.locator("button[type=submit]").isDisabled(), true);
      await dialog.locator("form").evaluate((form) => { form.dataset.fulfillmentType = "printful"; form.dispatchEvent(new Event("quoteinvalidated")); });
      await dialog.locator('[name="country"]').selectOption("HK");
      assert.equal(await dialog.locator('[name="postalCode"]').getAttribute("required"), null);
      await dialog.locator('[name="country"]').selectOption("BR");
      assert.equal(await dialog.locator('[name="taxNumber"]').isVisible(), true);
      assert.equal(await dialog.locator('[name="taxNumber"]').getAttribute("required"), "");
      await dialog.locator('[name="state"]').selectOption("SP");
      await dialog.locator('[name="city"]').fill("Sao Paulo");
      await dialog.locator('[name="postalCode"]').fill("01310-100");
      await dialog.locator('[name="phone"]').fill("+55 11 95555 0123");
      await dialog.locator('[name="taxNumber"]').fill("529.982.247-25");
      await dialog.locator(".quote-shipping").click();
      await page.waitForFunction(() => !document.querySelector("dialog button[type=submit]").disabled);
      await dialog.locator('[name="country"]').selectOption("US");
      assert.equal(await dialog.locator('[name="taxNumber"]').isVisible(), false);
      assert.equal(await dialog.locator('[name="taxNumber"]').isDisabled(), true);
      assert.equal(await dialog.locator('[data-international-notice]').isVisible(), false);
      assert.equal(await dialog.locator('[name="phone"]').getAttribute("required"), null);
      assert.deepEqual(errors, []);
      results.push({ width, checkoutInvalidation: true, staleResponseIgnored: true, reveal: true, originalEmailInquiries: true, internationalAddresses: true });
      await context.close();
    }
    const manifest = require("node:vm").runInNewContext(await fs.readFile(path.resolve(__dirname, "../public/image-assets.js"), "utf8") + ";window.ART_IMAGE_ASSETS", { window: {} });
    const asset = manifest["/images/aboutme.png"].sources.at(-1).url;
    const assetResponse = await fetch(base + asset);
    assert.match(assetResponse.headers.get("cache-control"), /immutable/);
    await fs.writeFile(path.join(output, "browser-results.json"), JSON.stringify(results, null, 2));
    console.log(`Browser checks passed: ${results.length} checks. Screenshots: ${output}`);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    f.sql.close();
  }
}

async function fillAddress(root) {
  await root.locator('[name="country"] option[value="GB"]').waitFor({ state: "attached" });
  await root.locator('[name="country"]').selectOption("US");
  for (const [name, value] of Object.entries({ name: "Test Buyer", email: "test@example.com", address1: "1 E Edenton St", city: "Raleigh", postalCode: "27601" })) await root.locator(`[name="${name}"]`).fill(value);
  await root.locator('[name="state"]').selectOption("NC");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
