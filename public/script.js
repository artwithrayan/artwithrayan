const API = "";

function money(value) { return `$${Number(value).toLocaleString()}`; }

const US_STATE_OPTIONS = `<option value="">State</option><option value="AL">Alabama</option><option value="AK">Alaska</option><option value="AZ">Arizona</option><option value="AR">Arkansas</option><option value="CA">California</option><option value="CO">Colorado</option><option value="CT">Connecticut</option><option value="DE">Delaware</option><option value="FL">Florida</option><option value="GA">Georgia</option><option value="HI">Hawaii</option><option value="ID">Idaho</option><option value="IL">Illinois</option><option value="IN">Indiana</option><option value="IA">Iowa</option><option value="KS">Kansas</option><option value="KY">Kentucky</option><option value="LA">Louisiana</option><option value="ME">Maine</option><option value="MD">Maryland</option><option value="MA">Massachusetts</option><option value="MI">Michigan</option><option value="MN">Minnesota</option><option value="MS">Mississippi</option><option value="MO">Missouri</option><option value="MT">Montana</option><option value="NE">Nebraska</option><option value="NV">Nevada</option><option value="NH">New Hampshire</option><option value="NJ">New Jersey</option><option value="NM">New Mexico</option><option value="NY">New York</option><option value="NC">North Carolina</option><option value="ND">North Dakota</option><option value="OH">Ohio</option><option value="OK">Oklahoma</option><option value="OR">Oregon</option><option value="PA">Pennsylvania</option><option value="RI">Rhode Island</option><option value="SC">South Carolina</option><option value="SD">South Dakota</option><option value="TN">Tennessee</option><option value="TX">Texas</option><option value="UT">Utah</option><option value="VT">Vermont</option><option value="VA">Virginia</option><option value="WA">Washington</option><option value="WV">West Virginia</option><option value="WI">Wisconsin</option><option value="WY">Wyoming</option>`;

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

function ensurePrintDialog() {
  let dialog = document.getElementById("printPurchaseDialog");
  if (dialog) return dialog;
  dialog = document.createElement("dialog");
  dialog.id = "printPurchaseDialog";
  dialog.className = "print-dialog";
  dialog.innerHTML = `<button type="button" class="dialog-close" aria-label="Close purchase window">Close</button><div id="printDialogContent"></div>`;
  document.body.appendChild(dialog);
  dialog.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (dialog._activeForm && dialog._activeCard) {
      dialog._activeCard.appendChild(dialog._activeForm);
      dialog._activeForm = null;
      dialog._activeCard = null;
    }
  });
  return dialog;
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

function renderPrintGallery(artworks, grid) {
  if (!artworks.length) { grid.innerHTML = "<p>No artworks are currently available.</p>"; return; }
  grid.innerHTML = artworks.map((artwork) => `
    <article class="product-card gallery-card">
      ${artworkImage(artwork)}
      <div class="product-info"><div class="product-title-row"><h3>${artwork.title}</h3><span class="product-count">${artwork.products.length} product${artwork.products.length === 1 ? "" : "s"}</span></div></div>
      <button type="button" class="view-products" data-artwork-key="${artwork.key}">View products</button>
    </article>`).join("");
  attachArtworkPurchaseHandlers(artworks);
}

function productImageUrls(product) {
  return product.imageUrls?.length ? product.imageUrls : (product.imageUrl ? [product.imageUrl] : []);
}

function productPreviewMarkup(product) {
  const images = productImageUrls(product);
  if (!images.length) return `<div class="product-preview empty-preview">Product mockup unavailable</div>`;
  return `<div class="product-preview"><img class="selected-product-image" src="${images[0]}" alt="${product.title}"><div class="product-thumbnails">${images.map((url, index) => `<button type="button" class="product-thumbnail ${index === 0 ? "active" : ""}" data-image="${url}" aria-label="View product image ${index + 1}"><img src="${url}" alt=""></button>`).join("")}</div></div>`;
}

function attachArtworkPurchaseHandlers(artworks) {
  document.querySelectorAll(".view-products").forEach((button) => {
    button.addEventListener("click", () => {
      const artwork = artworks.find((item) => item.key === button.dataset.artworkKey);
      if (!artwork) return;
      const dialog = ensurePrintDialog();
      const firstProduct = artwork.products[0];
      const options = artwork.products.map((product) => `<option value="${product.id}">${product.productType} - ${money(product.price)}</option>`).join("");
      const content = dialog.querySelector("#printDialogContent");
      content.innerHTML = `<div class="dialog-heading"><p class="section-label">${artwork.products.length} products available</p><h2 id="printDialogTitle">${artwork.title}</h2><p>${artwork.description || "Made-to-order products fulfilled through Printful."}</p><label class="product-choice-label" for="productChoice">Choose a product</label><select id="productChoice" class="product-choice">${options}</select><p class="dialog-price selected-product-price">${money(firstProduct.price)} before shipping</p></div><form class="checkout-form" data-id="${firstProduct.id}"><input name="name" type="text" placeholder="Full name" required /><input name="email" type="email" placeholder="Email for receipt" required /><input name="address1" type="text" placeholder="Address" required /><input name="address2" type="text" placeholder="Apartment, suite, etc. (optional)" /><div class="form-grid compact-grid"><input name="city" type="text" placeholder="City" required /><select name="state" required>${US_STATE_OPTIONS}</select><input name="postalCode" type="text" placeholder="ZIP code" required /></div><input name="country" type="text" value="US" placeholder="Country" required /><button type="button" class="quote-shipping">Calculate shipping</button><button type="submit" disabled>Continue to Stripe</button></form><p class="notice" id="notice-${firstProduct.id}">Enter your mailing address to see live Printful shipping.</p>`;
      const form = content.querySelector(".checkout-form");
      const heading = content.querySelector(".dialog-heading");
      const notice = content.querySelector(".notice");
      const info = document.createElement("div");
      info.className = "product-purchase-info";
      info.append(heading, form, notice);
      const layout = document.createElement("div");
      layout.className = "product-view-layout";
      layout.innerHTML = productPreviewMarkup(firstProduct);
      layout.append(info);
      content.replaceChildren(layout);
      const setProductImage = (product) => {
        const preview = layout.querySelector(".product-preview");
        preview.outerHTML = productPreviewMarkup(product);
        layout.querySelectorAll(".product-thumbnail").forEach((thumbnail) => thumbnail.addEventListener("click", () => {
          layout.querySelector(".selected-product-image").src = thumbnail.dataset.image;
          layout.querySelectorAll(".product-thumbnail").forEach((item) => item.classList.toggle("active", item === thumbnail));
        }));
      };
      setProductImage(firstProduct);
      content.querySelector(".product-choice").addEventListener("change", (event) => {
        const product = artwork.products.find((item) => String(item.id) === event.target.value);
        if (!product) return;
        form.dataset.id = product.id;
        content.querySelector(".selected-product-price").textContent = `${money(product.price)} before shipping`;
        setProductImage(product);
      });
      attachPrintCheckoutHandlers(content);
      dialog.showModal();
    });
  });
}

async function renderPrints() {
  const grid = document.getElementById("printsGrid");
  if (!grid) return;
  try {
    const data = await fetchJson(`${API}/api/prints`);
    const prints = data.artworks || [];
    renderPrintGallery(prints, grid);
    return;
    if (!prints.length) { grid.innerHTML = "<p>No prints are currently available.</p>"; return; }
    grid.innerHTML = prints.map((item) => `
      <article class="product-card">
        ${artworkImage(item)}
        <div class="product-info"><div class="product-title-row"><h3>${item.title}</h3><span class="price">${money(item.price)}</span></div><p class="product-meta">${item.productType} · ${item.sizes}</p><p>${item.description}</p></div>
        <button type="button" class="purchase-print" data-id="${item.id}">Purchase print</button>
        <form class="checkout-form" data-id="${item.id}">
          <input name="name" type="text" placeholder="Full name" required />
          <input name="email" type="email" placeholder="Email for receipt" required />
          <input name="address1" type="text" placeholder="Address" required />
          <input name="address2" type="text" placeholder="Apartment, suite, etc. (optional)" />
          <div class="form-grid compact-grid"><input name="city" type="text" placeholder="City" required /><select name="state" required>${US_STATE_OPTIONS}</select><input name="postalCode" type="text" placeholder="ZIP code" required /></div>
          <input name="country" type="text" value="US" placeholder="Country" required />
          <button type="button" class="quote-shipping">Calculate shipping</button>
          <button type="submit" disabled>Checkout</button>
        </form>
        <p class="notice" id="notice-${item.id}">Enter your mailing address to see live Printful shipping.</p>
      </article>`).join("");
    attachPrintCheckoutHandlers();
    attachPrintPurchaseHandlers(prints);
  } catch (error) { grid.innerHTML = `<p class="notice error">Could not load prints. Make sure the backend is running.</p>`; }
}

function attachPrintPurchaseHandlers(prints) {
  document.querySelectorAll(".purchase-print").forEach((button) => {
    button.addEventListener("click", () => {
      const item = prints.find((print) => String(print.id) === String(button.dataset.id));
      const card = button.closest(".product-card");
      const form = card?.querySelector(".checkout-form");
      if (!item || !form) return;
      const dialog = ensurePrintDialog();
      const content = dialog.querySelector("#printDialogContent");
      card.querySelector(".notice")?.remove();
      content.innerHTML = `<div class="dialog-heading"><p class="section-label">Made to order</p><h2 id="printDialogTitle">${item.title}</h2><p class="product-meta">${item.productType} · ${item.sizes}</p><p>${item.description}</p><p class="dialog-price">${money(item.price)} before shipping</p></div>`;
      content.appendChild(form);
      dialog._activeForm = form;
      dialog._activeCard = card;
      content.insertAdjacentHTML("beforeend", `<p class="notice" id="notice-${item.id}">Enter your mailing address to see live Printful shipping.</p>`);
      dialog.showModal();
    });
  });
}

function attachPrintCheckoutHandlers() {
  document.querySelectorAll(".checkout-form").forEach((form) => {
    const quoteButton = form.querySelector(".quote-shipping");
    const checkoutButton = form.querySelector("button[type=submit]");
    quoteButton.addEventListener("click", async () => {
      const id = form.dataset.id;
      const notice = form.parentElement.querySelector(".notice");
      const formData = new FormData(form);
      quoteButton.disabled = true;
      notice.className = "notice";
      notice.textContent = "Calculating Printful shipping...";
      try {
        const data = await fetchJson(`${API}/api/prints/${id}/shipping-rate`, { method: "POST", body: JSON.stringify(Object.fromEntries(formData.entries())) });
        form.dataset.shipping = String(data.shipping);
        checkoutButton.disabled = false;
        const delivery = data.delivery?.min && data.delivery?.max ? ` Estimated delivery: ${data.delivery.min}-${data.delivery.max} business days.` : "";
        notice.textContent = `Shipping: ${money(data.shipping)}. Estimated Printful fulfillment tax: ${money(data.fulfillmentTax)}. Estimated total: ${money(data.total)}.${delivery}`;
      } catch (error) {
        notice.className = "notice error";
        notice.textContent = error.message;
      } finally { quoteButton.disabled = false; }
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const id = form.dataset.id;
      const notice = form.parentElement.querySelector(".notice");
      const button = checkoutButton;
      const formData = new FormData(form);
      notice.className = "notice";
      notice.textContent = "Creating secure checkout...";
      button.disabled = true;
      try {
        const data = await fetchJson(`${API}/api/prints/${id}/checkout`, { method: "POST", body: JSON.stringify(Object.fromEntries(formData.entries())) });
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
