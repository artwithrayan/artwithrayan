const API = "";

function money(value) { return `$${Number(value).toLocaleString()}`; }
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }

const US_STATE_OPTIONS = `<option value="">State</option><option value="AL">Alabama</option><option value="AK">Alaska</option><option value="AZ">Arizona</option><option value="AR">Arkansas</option><option value="CA">California</option><option value="CO">Colorado</option><option value="CT">Connecticut</option><option value="DE">Delaware</option><option value="FL">Florida</option><option value="GA">Georgia</option><option value="HI">Hawaii</option><option value="ID">Idaho</option><option value="IL">Illinois</option><option value="IN">Indiana</option><option value="IA">Iowa</option><option value="KS">Kansas</option><option value="KY">Kentucky</option><option value="LA">Louisiana</option><option value="ME">Maine</option><option value="MD">Maryland</option><option value="MA">Massachusetts</option><option value="MI">Michigan</option><option value="MN">Minnesota</option><option value="MS">Mississippi</option><option value="MO">Missouri</option><option value="MT">Montana</option><option value="NE">Nebraska</option><option value="NV">Nevada</option><option value="NH">New Hampshire</option><option value="NJ">New Jersey</option><option value="NM">New Mexico</option><option value="NY">New York</option><option value="NC">North Carolina</option><option value="ND">North Dakota</option><option value="OH">Ohio</option><option value="OK">Oklahoma</option><option value="OR">Oregon</option><option value="PA">Pennsylvania</option><option value="RI">Rhode Island</option><option value="SC">South Carolina</option><option value="SD">South Dakota</option><option value="TN">Tennessee</option><option value="TX">Texas</option><option value="UT">Utah</option><option value="VT">Vermont</option><option value="VA">Virginia</option><option value="WA">Washington</option><option value="WV">West Virginia</option><option value="WI">Wisconsin</option><option value="WY">Wyoming</option>`;

function timeRemaining(endsAt) {
  const diff = new Date(endsAt) - new Date();
  if (diff <= 0) return "Auction ended";
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
  const minutes = Math.floor((diff / (1000 * 60)) % 60);
  return `${days}d ${hours}h ${minutes}m left`;
}

function artworkImage(item, className = "", imageAttributes = "") {
  if (item.imageUrl) return `<div class="art-image ${className}" style="--c1:${item.colorOne}; --c2:${item.colorTwo}"><img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.title)}" ${imageAttributes}></div>`;
  return `<div class="art-image ${className}" style="--c1:${item.colorOne}; --c2:${item.colorTwo}"></div>`;
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

async function renderOriginals() {
  const grid = document.getElementById("originalsGrid");
  if (!grid) return;

  try {
    const data = await fetchJson(`${API}/api/originals`);
    const originals = data.originals;
    if (!originals.length) { grid.innerHTML = "<p>No original paintings are currently available.</p>"; return; }

    grid.innerHTML = originals.map((art) => {
      const isAvailable = art.status !== "sold";
      const shipping = art.shippingEstimate || { total: 0, packageType: "shipping estimate unavailable", breakdown: {} };

      return `
        <article class="product-card" data-original-id="${art.id}">
          ${artworkImage(art, "original-art-image", art.revealImageUrl ? `data-standard-image="${escapeHtml(art.imageUrl)}" data-reveal-image="${escapeHtml(art.revealImageUrl)}"` : "")}
          <div class="product-info">
            <div class="product-title-row"><h3>${escapeHtml(art.title)}</h3><span class="price">${art.status === "sold" ? (Number(art.price) > 0 ? `Sold · ${money(art.price)}` : "Sold") : money(art.price)}</span></div>
            <p class="product-meta">${art.medium} · ${art.size} · ${art.year}</p>
            <p>${escapeHtml(art.description)}</p>
            <section class="shipping-box">
              <div class="shipping-row"><span>Price</span><strong>${money(art.price)}</strong></div>
              <div class="shipping-row"><span>Shipping</span><strong>Calculated at checkout</strong></div>
            </section>
          </div>
          ${art.revealImageUrl ? `<button type="button" class="shine-button" data-id="${art.id}" aria-pressed="false">Shine a light</button>` : ""}
          ${isAvailable ? `<button type="button" class="purchase-original" data-id="${art.id}">Purchase original</button>` : `<p class="notice">Sold</p>`}
          <p class="notice" id="notice-${art.id}"></p>
        </article>`;
    }).join("");
    attachRevealHandlers();
    attachOriginalPurchaseHandlers(originals);
  } catch (error) {
    grid.innerHTML = `<p class="notice error">Could not load originals. Make sure the backend is running.</p>`;
  }
}

function attachRevealHandlers() {
  document.querySelectorAll(".shine-button").forEach((button) => {
    button.addEventListener("click", () => {
      const card = button.closest(".product-card");
      const image = card?.querySelector(".original-art-image img");
      if (!image) return;
      const revealed = image.dataset.revealed === "true";
      image.src = revealed ? image.dataset.standardImage : image.dataset.revealImage;
      image.dataset.revealed = String(!revealed);
      button.setAttribute("aria-pressed", String(!revealed));
      button.textContent = revealed ? "Shine a light" : "Return to normal light";
      card?.querySelector(".original-art-image")?.classList.toggle("is-revealed", !revealed);
    });
  });
}

function attachOriginalPurchaseHandlers(originals) {
  document.querySelectorAll(".purchase-original").forEach((button) => {
    button.addEventListener("click", () => {
      const art = originals.find((item) => String(item.id) === String(button.dataset.id));
      if (!art) return;
      const dialog = ensurePrintDialog();
      const content = dialog.querySelector("#printDialogContent");
      content.innerHTML = `<div class="dialog-heading"><p class="section-label">Original artwork</p><h2>${escapeHtml(art.title)}</h2><p>${escapeHtml(art.description)}</p><p class="dialog-price">${money(art.price)} before shipping</p></div><form class="checkout-form original-checkout-form" data-id="${art.id}"><input name="name" type="text" placeholder="Full name" required /><input name="email" type="email" placeholder="Email for receipt" required /><input name="address1" type="text" placeholder="Address" required /><input name="address2" type="text" placeholder="Apartment, suite, etc. (optional)" /><div class="form-grid compact-grid"><input name="city" type="text" placeholder="City" required /><select name="state" required>${US_STATE_OPTIONS}</select><input name="postalCode" type="text" placeholder="ZIP code" required /></div><input name="country" type="text" value="US" placeholder="Country" required /><button type="button" class="quote-shipping">Calculate shipping</button><button type="submit" disabled>Continue to Stripe</button></form><p class="notice">Enter your mailing address to see the shipping estimate.</p>`;
      attachOriginalCheckoutHandlers(content, art);
      dialog.showModal();
    });
  });
}

function attachOriginalCheckoutHandlers(content, art) {
  const form = content.querySelector(".original-checkout-form");
  const quoteButton = form.querySelector(".quote-shipping");
  const checkoutButton = form.querySelector("button[type=submit]");
  const notice = content.querySelector(".notice");
  quoteButton.addEventListener("click", async () => {
    quoteButton.disabled = true;
    notice.className = "notice";
    notice.textContent = "Calculating shipping...";
    try {
      const data = await fetchJson(`${API}/api/originals/${art.id}/shipping-rate`, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      checkoutButton.disabled = false;
      notice.textContent = `Shipping: ${money(data.shipping)}. Estimated total: ${money(data.total)}.`;
    } catch (error) {
      notice.className = "notice error";
      notice.textContent = error.message;
    } finally { quoteButton.disabled = false; }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    checkoutButton.disabled = true;
    notice.className = "notice";
    notice.textContent = "Creating secure checkout...";
    try {
      const data = await fetchJson(`${API}/api/originals/${art.id}/checkout`, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      window.location.href = data.checkoutUrl;
    } catch (error) {
      notice.className = "notice error";
      notice.textContent = error.message;
      checkoutButton.disabled = false;
    }
  });
}

function renderPrintGallery(artworks, grid) {
  if (!artworks.length) { grid.innerHTML = "<p>No artworks are currently available.</p>"; return; }
  grid.innerHTML = artworks.map((artwork) => {
    const productCount = new Set(artwork.products.map((product) => product.productType)).size;
    return `
    <article class="product-card gallery-card">
      ${artworkImage(artwork)}
      <div class="product-info"><div class="product-title-row"><h3>${artwork.title}</h3><span class="product-count">${productCount} product${productCount === 1 ? "" : "s"}</span></div></div>
      <button type="button" class="view-products" data-artwork-key="${artwork.key}">View products</button>
    </article>`;
  }).join("");
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
      const productTypes = [...new Map(artwork.products.map((product) => [product.productType, product])).values()];
      const firstType = firstProduct.productType;
      const typeOptions = productTypes.map((product) => `<option value="${escapeHtml(product.productType)}">${escapeHtml(product.productType)}</option>`).join("");
      const typeProducts = (type) => artwork.products.filter((product) => product.productType === type);
      const sizeButtons = (products, selectedId) => products.map((product) => { const stock = product.stockQuantity === null ? "" : product.stockQuantity > 0 ? ` · ${product.stockQuantity} available` : " · Sold out"; return `<button type="button" class="variant-button ${product.id === selectedId ? "active" : ""}" data-product-id="${product.id}" ${product.stockQuantity === 0 ? "disabled" : ""}>${escapeHtml(product.sizes || product.title)} · ${money(product.price)}${stock}</button>`; }).join("");
      const optionSummary = (product) => (product.printfulOptions || []).map((option) => `<span class="product-option">${escapeHtml(option.id.replaceAll("_", " "))}: ${escapeHtml(option.value)}</span>`).join("");
      const content = dialog.querySelector("#printDialogContent");
      content.innerHTML = `<div class="dialog-heading"><p class="section-label">${artwork.products.length} options available</p><h2 id="printDialogTitle">${escapeHtml(artwork.title)}</h2><p>${escapeHtml(artwork.description || "Made-to-order products fulfilled through Printful.")}</p><label class="product-choice-label" for="productChoice">Choose a product type</label><select id="productChoice" class="product-choice">${typeOptions}</select><label class="product-choice-label">Choose a size</label><div class="variant-buttons" data-variant-buttons>${sizeButtons(typeProducts(firstType), firstProduct.id)}</div><div class="product-options" data-product-options>${optionSummary(firstProduct)}</div><p class="dialog-price selected-product-price">${money(firstProduct.price)} before shipping</p></div><form class="checkout-form" data-id="${firstProduct.id}"><input name="name" type="text" placeholder="Full name" required /><input name="email" type="email" placeholder="Email for receipt" required /><input name="address1" type="text" placeholder="Address" required /><input name="address2" type="text" placeholder="Apartment, suite, etc. (optional)" /><div class="form-grid compact-grid"><input name="city" type="text" placeholder="City" required /><select name="state" required>${US_STATE_OPTIONS}</select><input name="postalCode" type="text" placeholder="ZIP code" required /></div><input name="country" type="text" value="US" placeholder="Country" required /><button type="button" class="quote-shipping">Calculate shipping</button><button type="submit" disabled>Continue to Stripe</button></form><p class="notice" id="notice-${firstProduct.id}">Enter your mailing address to see live Printful shipping.</p>`;
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
      const selectProduct = (product) => {
        if (!product) return;
        form.dataset.id = product.id;
        content.querySelector(".selected-product-price").textContent = `${money(product.price)} before shipping`;
        content.querySelector("[data-product-options]").innerHTML = optionSummary(product);
        content.querySelectorAll(".variant-button").forEach((item) => item.classList.toggle("active", item.dataset.productId === product.id));
        setProductImage(product);
      };
      content.querySelector(".product-choice").addEventListener("change", (event) => {
        const products = typeProducts(event.target.value);
        content.querySelector("[data-variant-buttons]").innerHTML = sizeButtons(products, products[0]?.id);
        content.querySelectorAll(".variant-button").forEach((button) => button.addEventListener("click", () => selectProduct(artwork.products.find((item) => item.id === button.dataset.productId))));
        selectProduct(products[0]);
      });
      content.querySelectorAll(".variant-button").forEach((button) => button.addEventListener("click", () => selectProduct(artwork.products.find((item) => item.id === button.dataset.productId))));
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

async function loadSiteContent() {
  if (!document.querySelector("[data-edit-key]")) return;
  try {
    const { content } = await fetchJson(`${API}/api/site-content`);
    const textKeys = ["announcement", "heroTitle", "heroBlurb", "aboutLabel", "aboutTitle", "aboutBody", "aboutSecondary"];
    textKeys.forEach((key) => { const element = document.querySelector(`[data-edit-key='${key}']`); if (element && content[key]) element.textContent = content[key]; });
    const banner = document.querySelector("[data-edit-key='bannerImages.0']");
    if (banner && content.bannerImages?.[0]) { banner.style.backgroundImage = `url("${content.bannerImages[0]}")`; banner.classList.add("has-image"); }
    const aboutImage = document.querySelector("[data-edit-key='aboutImage']");
    if (aboutImage && content.aboutImage) { aboutImage.innerHTML = `<img src="${content.aboutImage}" alt="Rayan Rao">`; aboutImage.classList.add("has-image"); }
  } catch { /* Keep the built-in homepage copy if the API is unavailable. */ }
}

const year = document.getElementById("year");
if (year) year.textContent = new Date().getFullYear();
loadSiteContent();
renderOriginals();
renderPrints();
setInterval(updateCountdowns, 60000);

// Reduce casual image saving without blocking normal text selection or checkout fields.
document.addEventListener("contextmenu", (event) => {
  if (event.target.closest("img, .art-image, .product-preview, .banner-image, .portrait-placeholder")) event.preventDefault();
});
document.addEventListener("dragstart", (event) => {
  if (event.target.closest("img, .art-image, .product-preview, .banner-image, .portrait-placeholder")) event.preventDefault();
});
document.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  const blockedShortcut = event.ctrlKey || event.metaKey;
  if ((blockedShortcut && ["s", "u"].includes(key)) || event.key === "F12" || (event.ctrlKey && event.shiftKey && ["i", "j", "c"].includes(key))) event.preventDefault();
});
