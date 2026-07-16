const API = "";

function money(value) { return `$${Number(value).toLocaleString()}`; }

function timeRemaining(endsAt) {
  const diff = new Date(endsAt) - new Date();
  if (diff <= 0) return "Auction ended";
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
  const minutes = Math.floor((diff / (1000 * 60)) % 60);
  return `${days}d ${hours}h ${minutes}m left`;
}

function artworkImage(item) {
  if (item.imageUrl) return `<div class="art-image" style="--c1:${item.colorOne}; --c2:${item.colorTwo}"><img src="${item.imageUrl}" alt="${item.title}"></div>`;
  return `<div class="art-image" style="--c1:${item.colorOne}; --c2:${item.colorTwo}"></div>`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function shippingBreakdownHtml(shipping) {
  const breakdown = shipping.breakdown || {};
  const rows = Object.entries(breakdown).map(([label, value]) => `
    <div class="shipping-row"><span>${label.replace(/([A-Z])/g, " $1")}</span><strong>${money(value)}</strong></div>
  `).join("");

  return `
    <details class="shipping-details">
      <summary>How shipping/packaging is estimated</summary>
      <div class="shipping-box compact">
        ${rows}
        <p class="notice">${shipping.note || "Estimate includes packaging materials, packing labor, and a carrier-cost buffer."}</p>
      </div>
    </details>
  `;
}

function updateBidTotal(form) {
  const id = form.dataset.id;
  const amountInput = form.querySelector("input[name='amount']");
  const totalEl = document.getElementById(`bid-total-${id}`);
  const shipping = Number(form.dataset.shipping || 0);
  const bid = Number(amountInput.value || amountInput.min || 0);
  const total = Math.round(bid + shipping);
  totalEl.textContent = `${money(bid)} bid + ${money(shipping)} shipping/packaging = ${money(total)} estimated total if you win`;
}

async function renderOriginals() {
  const grid = document.getElementById("originalsGrid");
  if (!grid) return;

  try {
    const data = await fetchJson(`${API}/api/originals`);
    const originals = data.originals;
    if (!originals.length) { grid.innerHTML = "<p>No original paintings are currently available.</p>"; return; }

    grid.innerHTML = originals.map((art) => {
      const minimumNextBid = art.currentBid + art.bidIncrement;
      const isActive = art.status === "active";
      const shipping = art.shippingEstimate || { total: 0, packageType: "shipping estimate unavailable", breakdown: {} };
      const estimatedCurrentTotal = Number(art.currentBid) + Number(shipping.total || 0);
      const estimatedNextTotal = Number(minimumNextBid) + Number(shipping.total || 0);

      return `
        <article class="product-card" data-original-id="${art.id}">
          ${artworkImage(art)}
          <div class="product-info">
            <div class="product-title-row"><h3>${art.title}</h3><span class="current-bid" id="current-${art.id}">${money(art.currentBid)}</span></div>
            <p class="product-meta">${art.medium} · ${art.size} · ${art.year}</p>
            <p>${art.description}</p>
            <p class="countdown" data-ends="${art.endsAt}">${art.status === "sold" ? "Sold" : timeRemaining(art.endsAt)}</p>
            <section class="shipping-box">
              <div class="shipping-row"><span>Current bid</span><strong id="visible-bid-${art.id}">${money(art.currentBid)}</strong></div>
              <div class="shipping-row"><span>Estimated shipping/packaging</span><strong>${money(shipping.total)}</strong></div>
              <div class="shipping-row total"><span>Estimated total if current bid wins</span><strong id="visible-total-${art.id}">${money(estimatedCurrentTotal)}</strong></div>
              <p class="notice">Package basis: ${shipping.packageType}. This shipping/packaging estimate is charged to the winner in addition to the winning bid.</p>
            </section>
            ${shippingBreakdownHtml(shipping)}
            <p class="product-meta">Status: ${art.status.replace("_", " ")}</p>
          </div>
          ${isActive ? `
            <form class="bid-form" data-id="${art.id}" data-shipping="${shipping.total}">
              <input name="bidderEmail" type="email" placeholder="Registered email address" required />
              <input name="amount" type="number" min="${minimumNextBid}" placeholder="Bid ${money(minimumNextBid)} or higher" required />
              <p class="bid-total-preview" id="bid-total-${art.id}">${money(minimumNextBid)} bid + ${money(shipping.total)} shipping/packaging = ${money(estimatedNextTotal)} estimated total if you win</p>
              <button type="submit">Place binding bid</button>
            </form>
            <p class="notice">You must <a href="register.html">register to bid</a>. If you are highest when bidding closes, your saved Stripe payment method is automatically charged for the winning bid plus the displayed estimated shipping/packaging.</p>
          ` : ""}
          <p class="notice" id="notice-${art.id}"></p>
        </article>`;
    }).join("");
    attachBidHandlers();
  } catch (error) {
    grid.innerHTML = `<p class="notice error">Could not load originals. Make sure the backend is running.</p>`;
  }
}

function attachBidHandlers() {
  document.querySelectorAll(".bid-form").forEach((form) => {
    const amountInput = form.querySelector("input[name='amount']");
    amountInput.addEventListener("input", () => updateBidTotal(form));
    updateBidTotal(form);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const id = form.dataset.id;
      const notice = document.getElementById(`notice-${id}`);
      const button = form.querySelector("button");
      const formData = new FormData(form);
      const shipping = Number(form.dataset.shipping || 0);
      const bidAmount = Number(formData.get("amount"));
      const total = Math.round(bidAmount + shipping);

      if (!window.confirm(`Place binding bid of ${money(bidAmount)}? If you win, your saved payment method will be charged approximately ${money(total)} including estimated shipping/packaging.`)) {
        return;
      }

      notice.className = "notice";
      notice.textContent = "Submitting bid...";
      button.disabled = true;
      try {
        const data = await fetchJson(`${API}/api/originals/${id}/bids`, { method: "POST", body: JSON.stringify({ bidderEmail: formData.get("bidderEmail"), amount: bidAmount }) });
        document.getElementById(`current-${id}`).textContent = money(data.currentBid);
        document.getElementById(`visible-bid-${id}`).textContent = money(data.currentBid);
        document.getElementById(`visible-total-${id}`).textContent = money(data.currentBid + shipping);
        amountInput.min = data.minimumNextBid;
        amountInput.placeholder = `Bid ${money(data.minimumNextBid)} or higher`;
        amountInput.value = "";
        updateBidTotal(form);
        notice.className = "notice success";
        notice.textContent = `Bid placed. If you win, your saved payment method will be charged for your winning bid plus ${money(shipping)} estimated shipping/packaging.`;
      } catch (error) {
        notice.className = "notice error";
        notice.textContent = error.message;
      } finally { button.disabled = false; }
    });
  });
}

async function renderPrints() {
  const grid = document.getElementById("printsGrid");
  if (!grid) return;
  try {
    const data = await fetchJson(`${API}/api/prints`);
    const prints = data.prints;
    if (!prints.length) { grid.innerHTML = "<p>No prints are currently available.</p>"; return; }
    grid.innerHTML = prints.map((item) => `
      <article class="product-card">
        ${artworkImage(item)}
        <div class="product-info"><div class="product-title-row"><h3>${item.title}</h3><span class="price">${money(item.price)}</span></div><p class="product-meta">${item.productType} · ${item.sizes}</p><p>${item.description}</p></div>
        <form class="checkout-form" data-id="${item.id}"><input name="customerEmail" type="email" placeholder="Email for receipt (optional)" /><button type="submit">Checkout</button></form>
        <p class="notice" id="notice-${item.id}">Secure payment is handled by Stripe. Printful fulfillment can be manual or API-based.</p>
      </article>`).join("");
    attachPrintCheckoutHandlers();
  } catch (error) { grid.innerHTML = `<p class="notice error">Could not load prints. Make sure the backend is running.</p>`; }
}

function attachPrintCheckoutHandlers() {
  document.querySelectorAll(".checkout-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const id = form.dataset.id;
      const notice = document.getElementById(`notice-${id}`);
      const button = form.querySelector("button");
      const formData = new FormData(form);
      notice.className = "notice";
      notice.textContent = "Creating secure checkout...";
      button.disabled = true;
      try {
        const data = await fetchJson(`${API}/api/prints/${id}/checkout`, { method: "POST", body: JSON.stringify({ customerEmail: formData.get("customerEmail") }) });
        window.location.href = data.checkoutUrl;
      } catch (error) {
        notice.className = "notice error";
        notice.textContent = error.message;
        button.disabled = false;
      }
    });
  });
}

function updateCountdowns() {
  document.querySelectorAll(".countdown[data-ends]").forEach((el) => { if (el.textContent.toLowerCase() !== "sold") el.textContent = timeRemaining(el.dataset.ends); });
}

const year = document.getElementById("year");
if (year) year.textContent = new Date().getFullYear();
renderOriginals();
renderPrints();
setInterval(updateCountdowns, 60000);
