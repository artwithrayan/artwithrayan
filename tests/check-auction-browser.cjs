const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const { createRequire } = require("node:module");
const port = Number(process.env.AUCTION_TEST_PORT || 3197);
process.env.TEST_BASE_URL = `http://127.0.0.1:${port}`;
const f = require("./fixture.cjs");
const email = require("../src/email");
const browserRequire = process.env.BROWSER_MODULES ? createRequire(path.join(process.env.BROWSER_MODULES, "package.json")) : require;
const { chromium } = browserRequire("playwright");
let code;
email.isEmailEnabled = () => true;
email.sendEmail = async (mail) => { code = mail.html.match(/<strong>(\d+)<\/strong>/)?.[1] || code; return { sent: true }; };
f.auctions.configure([{ id: "light-demo", originalId: "the-light", startingPrice: 300, startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: new Date(Date.now() + 86400000).toISOString() }]);
async function main() {
  const output = process.env.BROWSER_AUDIT_OUTPUT || path.join(f.tempDir, "auction-screenshots");
  await fs.mkdir(output, { recursive: true });
  const server = f.app.listen(port, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  try {
    for (const width of [1440, 390, 320]) {
      const context = await browser.newContext({ viewport: { width, height: 950 } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (/violates.*content security|refused to (?:load|execute|connect)/i.test(message.text())) errors.push(message.text()); });
      await page.route("**/*", async (route) => {
        if (route.request().url().startsWith("https://example.invalid/cs_test_")) {
          const id = new URL(route.request().url()).pathname.slice(1);
          f.sessions.get(id).status = "complete";
          return route.fulfill({ status: 302, headers: { location: `${base}/auction.html?id=light-demo&returned=1` }, body: "" });
        }
        if (!route.request().url().startsWith(base)) return route.abort();
        return route.continue();
      });
      await page.goto(`${base}/originals.html`);
      await page.locator('[data-original-id="the-light"] a[href^="auction.html"]').click();
      await page.locator('#loginForm [name="email"]').fill(`browser-${width}@example.com`);
      await page.locator("#loginForm button").click();
      await page.locator("#codeForm").waitFor({ state: "visible" });
      await page.locator('#codeForm [name="code"]').fill(code);
      await page.locator("#codeForm button").click();
      await page.locator("#bidForm").waitFor({ state: "visible" });
      const maximum = width === 1440 ? "500" : width === 390 ? "550" : "600";
      for (const [name, value] of Object.entries({ maximum, name: "Test Bidder", address1: "123 Main Street", city: "Raleigh", postalCode: "27601" })) await page.locator(`#bidForm [name="${name}"]`).fill(value);
      await page.locator('#bidForm [name="state"]').selectOption("NC");
      await page.locator("#bidForm button").click();
      await page.locator("#bidReview").waitFor({ state: "visible" });
      assert.equal(await page.locator("#agreeCharge").isChecked(), false);
      assert.equal(await page.locator("#authorizeBid").isDisabled(), true);
      assert.match(await page.locator("[data-consent]").innerText(), /ONLY if I win/);
      assert.match(await page.locator("[data-total]").innerText(), /\$45/);
      await page.screenshot({ path: path.join(output, `auction-review-${width}.png`), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.locator('#bidForm [name="postalCode"]').fill("27602");
      assert.equal(await page.locator("#bidReview").isVisible(), false);
      await page.locator('#bidForm [name="postalCode"]').fill("27601");
      await page.locator("#bidForm button").click();
      await page.locator("#bidReview").waitFor({ state: "visible" });
      await page.locator("#agreeCharge").check();
      await page.locator("#authorizeBid").click();
      await page.waitForURL("**/auction.html?id=light-demo&returned=1");
      await page.waitForFunction(() => document.querySelector('[data-mine]')?.textContent.includes("You are leading."));
      assert.equal(await page.locator('#bidForm [name="state"]').isDisabled(), true);
      assert.equal(await page.locator('#bidForm [name="address1"]').inputValue(), "123 Main Street");
      await page.screenshot({ path: path.join(output, `auction-accepted-${width}.png`), fullPage: true });
      await page.locator("#auctionLogout").click();
      await page.locator("#loginForm").waitFor({ state: "visible" });
      assert.equal(await page.locator("[data-mine]").innerText(), "");
      assert.deepEqual(errors, []);
      await context.close();
    }
    await require("./auction-recovery-browser.cjs")(browser, base, output);
    assert.equal(f.sql.prepare("SELECT count(*) n FROM payments").get().n, 0);
    console.log(`Auction browser checks passed at 1440, 390 and 320px. Screenshots: ${output}`);
  } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); f.sql.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
