(() => {
  const id = new URLSearchParams(location.search).get("id");
  const root = document.getElementById("auctionContent");
  let data, challenge, quote, polling = false, revision = 0, noticeSource, renderedEmail, accountRevision = 0;
  const url = `/api/auctions/${encodeURIComponent(id || "")}`;
  const post = (path, body) => fetchJson(path, { method: "POST", body: JSON.stringify(body) });
  const format = (cents) => money(cents / 100);
  function status(text, error = false, source = "action") {
    noticeSource = source;
    const node = root.querySelector("#auctionNotice");
    if (node) { node.textContent = text; node.className = error ? "notice error" : "notice"; }
  }
  function update() {
    const a = data.auction;
    if (renderedEmail !== data.email) {
      renderedEmail = data.email;
      accountRevision++; revision++; quote = null; challenge = null;
      root.querySelector("#bidForm").reset();
      root.querySelector("#loginForm").reset();
      root.querySelector("#codeForm").reset();
      root.querySelector("#codeForm").hidden = true;
      root.querySelector("#bidReview").hidden = true;
      root.querySelector("[data-total]").textContent = "";
      root.querySelector("[data-consent]").textContent = "";
      root.querySelector("#agreeCharge").checked = false;
      root.querySelector("#authorizeBid").disabled = true;
      status("");
    }
    root.querySelector("[data-price]").textContent = `${a.bidCount ? "Current bid" : "Starting bid"}: ${format(a.currentCents)}`;
    root.querySelector("[data-close]").textContent = `${a.status === "scheduled" ? "Opens" : "Closes"} ${new Date(a.status === "scheduled" ? a.startsAt : a.endsAt).toLocaleString()}`;
    root.querySelector("[data-count]").textContent = `${a.bidCount} accepted bid${a.bidCount === 1 ? "" : "s"}`;
    root.querySelector("[data-state]").textContent = a.status === "open" ? "Bidding open" : a.status.replaceAll("_", " ");
    const mine = root.querySelector("[data-mine]");
    mine.textContent = a.mine ? `Your maximum: ${format(a.mine.maxCents)} + ${format(a.mine.shippingCents)} shipping. ${a.mine.leading ? "You are leading." : "You have been outbid. You have not been charged."}` : "";
    if (a.mine && !["open", "scheduled"].includes(a.status)) {
      if (a.status === "cancelled") mine.textContent = "This auction was cancelled. You will not be charged for it.";
      else if (a.status === "closing") mine.textContent = "Bidding has ended. The final result is being confirmed.";
      else if (a.status === "review") mine.textContent = "This auction is under review. We will contact you about the outcome.";
      else if (a.status === "no_bids") mine.textContent = "This auction ended without an accepted winning bid.";
      else if (!a.mine.leading) mine.textContent = "This auction has ended. You did not win and will not be charged.";
      else if (a.status === "paid") mine.textContent = `You won. Payment confirmed: ${format(a.currentCents + a.mine.shippingCents)} including shipping.`;
      else if (a.status === "charging") mine.textContent = "You won. Payment is being processed; confirmation will appear here.";
      else if (a.status === "payment_required") mine.textContent = "You won, but automatic payment did not complete. Complete your payment using the secure link below.";
      else if (a.status === "unpaid") mine.textContent = "The payment deadline has passed without a completed payment. Please contact us.";
      else mine.textContent = "Bidding has ended. Check the auction status for the outcome.";
    }
    root.querySelector("#bidForm").hidden = !data.email || a.status !== "open" || !a.biddingEnabled;
    root.querySelector("#loginForm").hidden = Boolean(data.email) || a.status === "scheduled";
    root.querySelector("[data-signed-in]").textContent = data.email ? `Signed in as ${data.email}` : "";
    root.querySelector("#auctionLogout").hidden = !data.email;
    const pay = root.querySelector("[data-pay]");
    pay.hidden = !a.checkoutUrl;
    if (!a.checkoutUrl) { pay.removeAttribute("href"); pay.textContent = ""; }
    if (a.checkoutUrl) { pay.href = a.checkoutUrl; pay.textContent = `Complete winning payment: ${format(a.currentCents + a.mine.shippingCents)}`; }
    root.querySelector("[data-deadline]").textContent = a.checkoutUrl ? `Payment due ${new Date(a.paymentDeadline).toLocaleString()}` : "";
    const min = a.mine?.leading ? a.mine.maxCents + 100 : a.minimumCents;
    root.querySelector('[name="maximum"]').min = (min / 100).toFixed(2);
    const form = root.querySelector("#bidForm");
    const recipient = data.email && a.mine?.recipient;
    for (const [field, key] of Object.entries({ name: "name", address1: "address1", address2: "address2", city: "city", state: "state_code", postalCode: "zip" })) {
      if (recipient) form.elements[field].value = recipient[key] || "";
      if (field === "state") form.elements[field].disabled = Boolean(recipient);
      else form.elements[field].readOnly = Boolean(recipient);
    }
    root.querySelector("[data-minimum]").textContent = `Minimum maximum bid: ${format(min)}`;
    const bidNotice = root.querySelector("#auctionBidNotice");
    bidNotice.textContent = "";
    bidNotice.className = "notice";
    if (a.status === "open") {
      if (a.latestBid?.status === "rejected") { bidNotice.textContent = a.latestBid.reason; bidNotice.className = "notice error"; }
      else if (a.latestBid?.status === "authorizing") bidNotice.textContent = "Card verification is pending. Your bid is not accepted until confirmation appears here.";
      else if (a.latestBid?.status === "accepted") bidNotice.textContent = "Your bid was accepted. You will only be charged if you win.";
    }
    if (!data.email || a.status !== "open") { quote = null; root.querySelector("#bidReview").hidden = true; }
  }
  async function refresh(reconcile = false) {
    if (polling) return;
    polling = true;
    try {
      let verificationError;
      // A delayed Stripe lookup must not prevent public bid/status updates.
      if (reconcile && data?.email) {
        try { await post(`${url}/refresh`, {}); } catch (error) { verificationError = error; }
      }
      data = await fetchJson(url);
      if (root.querySelector("#bidForm")) update(); else render();
      if (verificationError && data.auction.status === "open" && data.auction.latestBid?.status === "authorizing") {
        status("Card verification is temporarily unavailable. We will retry automatically; your bid is not yet confirmed.", true, "refresh");
      } else if (noticeSource === "refresh") status("");
    } catch (error) {
      if (root.querySelector("#auctionNotice")) status("Updates are temporarily unavailable. We will retry automatically. Refresh before bidding.", true, "refresh");
      else root.textContent = "Auction could not be loaded. We will retry automatically.";
      throw error;
    } finally { polling = false; }
  }
  function render() {
    const original = data.original;
    root.innerHTML = `<div class="auction-layout"><div class="auction-art">${responsiveImage(original.imageUrl, original.title, 'decoding="async"')}<p>${escapeHtml(original.medium)} · ${escapeHtml(original.size)}</p></div>
      <section class="auction-controls"><h1>${escapeHtml(original.title)}</h1><p data-state></p><strong class="auction-price" data-price></strong><p data-count></p><p data-close></p><p data-mine class="auction-personal" aria-live="polite"></p>
      <p data-signed-in class="notice"></p><button type="button" id="auctionLogout" hidden>Sign out</button><a class="button" data-pay hidden></a><p data-deadline></p>
      <form id="loginForm" class="auction-form"><label>Email<input name="email" type="email" autocomplete="email" maxlength="254" required></label><button type="submit">Verify email to bid</button></form>
      <form id="codeForm" class="auction-form" hidden><label>Email verification code<input name="code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" maxlength="6" required></label><button type="submit">Confirm code</button></form>
      <form id="bidForm" class="auction-form" hidden><label>Maximum bid (USD)<input name="maximum" type="number" step="0.01" max="100000" required></label><p data-minimum class="notice"></p>
      <label>Full shipping name<input name="name" autocomplete="shipping name" maxlength="150" required></label>
      <label>Street address<input name="address1" autocomplete="shipping address-line1" maxlength="150" required></label>
      <label>Apartment, suite, etc. (optional)<input name="address2" autocomplete="shipping address-line2" maxlength="150"></label>
      <div class="auction-address"><label>City<input name="city" autocomplete="shipping address-level2" maxlength="150" required></label><label>State<select name="state" autocomplete="shipping address-level1" required>${US_STATE_OPTIONS}<option value="DC">District of Columbia</option></select></label><label>ZIP code<input name="postalCode" autocomplete="shipping postal-code" inputmode="numeric" pattern="[0-9]{5}(-[0-9]{4})?" required></label></div>
      <p class="notice">Contiguous United States only. Shipping and protective packing are calculated before you authorize a bid.</p><button type="submit">Review bid and shipping</button></form>
      <section id="bidReview" class="auction-review" hidden><h2>Review authorization</h2><dl data-total></dl><p data-consent></p>
      <label class="auction-check"><input id="agreeCharge" type="checkbox">I am at least 18, am authorized to use this card, and explicitly agree to the charge authorization above and the <a href="auction-rules.html" target="_blank" rel="noopener">auction rules</a>.</label>
      <button type="button" id="authorizeBid" disabled>Agree and continue securely</button><p class="notice">Only the winner pays. Stripe securely saves your card; we never store its full number or security code.</p></section>
      <p id="auctionBidNotice" role="status" aria-live="polite"></p><p id="auctionNotice" role="status" aria-live="polite"></p>
      <details class="auction-rule-summary"><summary>Bidding and payment rules</summary><p>Your maximum stays private. We bid automatically up to that amount. The winner pays the final winning bid plus their accepted shipping charge, never above their authorized total. Losing bidders are not charged.</p><p>A competing bid in the last two minutes extends bidding by two minutes. Equal maximums favor the earlier accepted bid. No hidden reserve or buyer premium.</p><a href="auction-rules.html">Full auction rules</a></details>
      </section></div>`;
    const login = root.querySelector("#loginForm"), code = root.querySelector("#codeForm"), form = root.querySelector("#bidForm"), review = root.querySelector("#bidReview");
    form.querySelectorAll('option[value="AK"], option[value="HI"]').forEach((option) => option.remove());
    root.querySelector("#auctionLogout").addEventListener("click", async () => {
      try { await post("/api/auctions/logout", {}); location.reload(); } catch (error) { status(error.message, true); }
    });
    async function busy(button, action) {
      button.disabled = true; status("");
      try { await action(); } catch (error) { status(error.message, true); }
      finally { button.disabled = button.id === "authorizeBid" && (!quote || !data.email || !root.querySelector("#agreeCharge").checked); }
    }
    login.addEventListener("submit", (event) => {
      event.preventDefault(); busy(login.querySelector("button"), async () => { const account = accountRevision; const response = await post("/api/auctions/login", { email: login.elements.email.value }); if (account !== accountRevision) return; challenge = response.challenge; code.hidden = false; status("Check your email for a six-digit code."); code.elements.code.focus(); });
    });
    code.addEventListener("submit", (event) => {
      event.preventDefault(); busy(code.querySelector("button"), async () => { await post("/api/auctions/verify", { challenge, code: code.elements.code.value }); code.hidden = true; await refresh(true); status("Email verified."); });
    });
    form.addEventListener("input", () => { revision++; quote = null; review.hidden = true; root.querySelector("#agreeCharge").checked = false; });
    form.addEventListener("submit", (event) => {
      event.preventDefault(); busy(form.querySelector("button"), async () => {
        const current = ++revision;
        const result = await post(`${url}/quote`, { ...Object.fromEntries(new FormData(form)), state: form.elements.state.value, country: "US" });
        if (revision !== current) return;
        quote = result;
        root.querySelector("[data-total]").innerHTML = `<dt>Maximum bid</dt><dd>${format(quote.maximumCents)}</dd><dt>Fixed shipping and packing</dt><dd>${format(quote.shippingCents)}</dd><dt>Maximum total if you win</dt><dd>${format(quote.maximumTotalCents)}</dd>`;
        root.querySelector("[data-consent]").textContent = quote.consentText;
        root.querySelector("#agreeCharge").checked = false; root.querySelector("#authorizeBid").disabled = true;
        review.hidden = false; review.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    });
    root.querySelector("#agreeCharge").addEventListener("change", (event) => { root.querySelector("#authorizeBid").disabled = !event.target.checked; });
    root.querySelector("#authorizeBid").addEventListener("click", (event) => busy(event.target, async () => {
      if (!quote || !root.querySelector("#agreeCharge").checked) throw new Error("Review and authorize your total first.");
      const account = accountRevision;
      const result = await post(`${url}/authorize`, { quoteId: quote.quoteId, agreed: true });
      if (account !== accountRevision) return;
      if (result.checkoutUrl) { location.assign(result.checkoutUrl); return; }
      quote = null; review.hidden = true; await refresh();
      status(result.status === "accepted" ? "Your bid was accepted. You will only be charged if you win." : result.reason, result.status !== "accepted");
    }));
    update();
  }
  (async () => {
    try { await refresh(); if (new URLSearchParams(location.search).has("returned")) await refresh(true); }
    catch { /* refresh preserves the page and exposes the retry status. */ }
  })();
  const poll = () => { if (!document.hidden) refresh(data?.auction.latestBid?.status === "authorizing").catch(() => {}); };
  setInterval(poll, 30000);
  document.addEventListener("visibilitychange", poll);
  window.addEventListener("online", poll);
})();
