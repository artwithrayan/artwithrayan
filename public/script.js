const API = "";

function money(value) {
  const amount = Number(value || 0);
  return `$${amount.toLocaleString(undefined, { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 })}`;
}
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }

function imageAttributes(url) {
  const asset = window.ART_IMAGE_ASSETS?.[url];
  if (!asset) return `src="${escapeHtml(url)}"`;
  const sources = asset.sources;
  return `src="${escapeHtml(sources.at(-1).url)}" srcset="${sources.map((source) => `${escapeHtml(source.url)} ${source.width}w`).join(", ")}" sizes="(max-width: 600px) 100vw, (max-width: 1000px) 50vw, 45vw" width="${asset.width}" height="${asset.height}"`;
}

function responsiveImage(url, title, attributes = "") {
  return `<img ${imageAttributes(url)} alt="${escapeHtml(title)}" ${attributes}>`;
}

const US_STATE_OPTIONS = `<option value="">State</option><option value="AL">Alabama</option><option value="AK">Alaska</option><option value="AZ">Arizona</option><option value="AR">Arkansas</option><option value="CA">California</option><option value="CO">Colorado</option><option value="CT">Connecticut</option><option value="DE">Delaware</option><option value="FL">Florida</option><option value="GA">Georgia</option><option value="HI">Hawaii</option><option value="ID">Idaho</option><option value="IL">Illinois</option><option value="IN">Indiana</option><option value="IA">Iowa</option><option value="KS">Kansas</option><option value="KY">Kentucky</option><option value="LA">Louisiana</option><option value="ME">Maine</option><option value="MD">Maryland</option><option value="MA">Massachusetts</option><option value="MI">Michigan</option><option value="MN">Minnesota</option><option value="MS">Mississippi</option><option value="MO">Missouri</option><option value="MT">Montana</option><option value="NE">Nebraska</option><option value="NV">Nevada</option><option value="NH">New Hampshire</option><option value="NJ">New Jersey</option><option value="NM">New Mexico</option><option value="NY">New York</option><option value="NC">North Carolina</option><option value="ND">North Dakota</option><option value="OH">Ohio</option><option value="OK">Oklahoma</option><option value="OR">Oregon</option><option value="PA">Pennsylvania</option><option value="RI">Rhode Island</option><option value="SC">South Carolina</option><option value="SD">South Dakota</option><option value="TN">Tennessee</option><option value="TX">Texas</option><option value="UT">Utah</option><option value="VT">Vermont</option><option value="VA">Virginia</option><option value="WA">Washington</option><option value="WV">West Virginia</option><option value="WI">Wisconsin</option><option value="WY">Wyoming</option>`;

function shippingAddressFields() {
  return `<input name="name" type="text" placeholder="Full name" autocomplete="shipping name" required /><input name="email" type="email" placeholder="Email for receipt" autocomplete="email" required /><input name="phone" type="tel" placeholder="Phone with country code (optional in US)" aria-label="Delivery phone with country code" autocomplete="shipping tel" /><label class="shipping-country-label">Country<select name="country" autocomplete="shipping country" required><option value="US">United States</option></select></label><input name="address1" type="text" placeholder="Address" autocomplete="shipping address-line1" required /><input name="address2" type="text" placeholder="Apartment, suite, etc. (optional)" autocomplete="shipping address-line2" /><div class="form-grid compact-grid"><input name="city" type="text" placeholder="City" autocomplete="shipping address-level2" required /><span data-shipping-region><select name="state" aria-label="State or province" autocomplete="shipping address-level1" required>${US_STATE_OPTIONS}</select></span><input name="postalCode" type="text" placeholder="ZIP code" aria-label="Postal code" autocomplete="shipping postal-code" required /></div><p class="international-shipping-note" data-international-notice hidden>Prices and checkout are in USD. Customs duties, import taxes, or carrier handling fees may be payable separately on delivery.</p>`;
}

let shippingCountriesRequest;
function loadShippingCountries() {
  if (!shippingCountriesRequest) shippingCountriesRequest = fetchJson(`${API}/api/shipping/countries`).catch((error) => { shippingCountriesRequest = null; throw error; });
  return shippingCountriesRequest;
}

function attachShippingDestination(form) {
  const countrySelect = form.elements.country;
  let countries = [];
  const updateRegion = (preserve = false) => {
    const country = countries.find((item) => item.code === countrySelect.value);
    const requiredRegion = ["US", "CA", "AU"].includes(countrySelect.value);
    const previous = preserve ? form.elements.state.value : "";
    const region = form.querySelector("[data-shipping-region]");
    if (country?.states.length || countrySelect.value === "US") {
      const options = country?.states.length
        ? `<option value="">State / province${requiredRegion ? "" : " (optional)"}</option>${country.states.map((state) => `<option value="${escapeHtml(state.code)}">${escapeHtml(state.name)}</option>`).join("")}`
        : US_STATE_OPTIONS;
      region.innerHTML = `<select name="state" aria-label="State or province" autocomplete="shipping address-level1" ${requiredRegion ? "required" : ""}>${options}</select>`;
    } else {
      region.innerHTML = `<input name="state" type="text" placeholder="Region (optional)" aria-label="State or region" autocomplete="shipping address-level1" />`;
    }
    form.elements.state.value = previous;
    form.elements.postalCode.required = country?.postalCodeRequired ?? requiredRegion;
    form.elements.postalCode.placeholder = countrySelect.value === "US" ? "ZIP code" : form.elements.postalCode.required ? "Postal code" : "Postal code (if applicable)";
    form.elements.phone.required = countrySelect.value !== "US";
    form.elements.phone.placeholder = countrySelect.value === "US" ? "Phone with country code (optional)" : "Phone with country code, e.g. +44 7700 900123";
    form.querySelector("[data-international-notice]").hidden = countrySelect.value === "US";
    const taxField = form.querySelector('[name="taxNumber"]');
    taxField.hidden = countrySelect.value !== "BR";
    taxField.disabled = countrySelect.value !== "BR";
    taxField.required = countrySelect.value === "BR";
  };
  const updateCountries = () => {
    const previous = countrySelect.value;
    const available = form.dataset.fulfillmentType === "self" ? countries.filter((country) => country.code === "US") : countries;
    if (available.length) countrySelect.innerHTML = available.map((country) => `<option value="${escapeHtml(country.code)}">${escapeHtml(country.name)}</option>`).join("");
    countrySelect.value = available.some((country) => country.code === previous) ? previous : "US";
    updateRegion(previous === countrySelect.value);
    if (previous !== countrySelect.value) form.dispatchEvent(new Event("change"));
  };
  countrySelect.addEventListener("change", () => updateRegion());
  form.addEventListener("quoteinvalidated", updateCountries);
  const taxField = document.createElement("input");
  taxField.name = "taxNumber";
  taxField.type = "text";
  taxField.placeholder = "Recipient CPF or CNPJ (Brazil)";
  taxField.setAttribute("aria-label", "Recipient CPF or CNPJ tax ID for Brazil");
  taxField.hidden = true;
  taxField.disabled = true;
  form.querySelector("[data-international-notice]").before(taxField);
  loadShippingCountries().then((data) => {
    if (!form.isConnected) return;
    countries = data.countries;
    updateCountries();
  }).catch(() => {
    // Keep domestic checkout usable if country metadata is temporarily unavailable.
    if (form.isConnected) countrySelect.options[0].textContent = "United States (international destinations temporarily unavailable)";
  });
}

function timeRemaining(endsAt) {
  const diff = new Date(endsAt) - new Date();
  if (diff <= 0) return "Auction ended";
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
  const minutes = Math.floor((diff / (1000 * 60)) % 60);
  return `${days}d ${hours}h ${minutes}m left`;
}

function artworkImage(item, className = "", imageAttributes = "") {
  if (item.imageUrl) return `<div class="art-image ${className}" style="--c1:${item.colorOne}; --c2:${item.colorTwo}">${responsiveImage(item.imageUrl, item.title, `loading="lazy" decoding="async" ${imageAttributes}`)}</div>`;
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
    const inquiryEmail = data.inquiryEmail || "artwithrayan@gmail.com";
    if (!originals.length) { grid.innerHTML = "<p>No original paintings are currently available.</p>"; return; }

    grid.innerHTML = originals.map((art) => {
      const isAvailable = ["active", "payment_pending"].includes(art.status);
      const inquirySubject = `Purchase inquiry: ${art.title}`;
      const inquiryBody = `Hi Rayan,\n\nI'm interested in purchasing "${art.title}" (${art.size}, ${art.medium}).\n\nCould you confirm availability, pricing, and shipping?\n\nThank you,\n`;
      const inquiryUrl = `mailto:${inquiryEmail}?subject=${encodeURIComponent(inquirySubject)}&body=${encodeURIComponent(inquiryBody)}`;

      return `
        <article class="product-card original-card" data-original-id="${escapeHtml(art.id)}">
          ${artworkImage(art, `original-art-image${art.id === "sun-beam" ? " rotating-art-image" : ""}`, art.revealImageUrl ? `data-standard-image="${escapeHtml(art.imageUrl)}" data-reveal-image="${escapeHtml(art.revealImageUrl)}"` : "")}
          <div class="product-info">
            <div class="product-title-row"><h3>${escapeHtml(art.title)}</h3>${art.status === "sold" ? '<span class="original-status">Sold</span>' : ""}</div>
            <p class="product-meta">${escapeHtml(art.medium)} · ${escapeHtml(art.size)} · ${escapeHtml(art.year)}</p>
            <p>${escapeHtml(art.description)}</p>
          </div>
          ${art.revealImageUrl ? `<button type="button" class="shine-button" data-id="${escapeHtml(art.id)}" aria-pressed="false">Shine a light</button>` : ""}
          ${art.id === "sun-beam" ? '<button type="button" class="rotation-button" aria-label="Pause Sun Beam rotation" aria-pressed="true">Pause rotation</button>' : ""}
          ${isAvailable ? `<a class="button original-inquiry" href="${escapeHtml(inquiryUrl)}" aria-label="${escapeHtml(`Email if interested in purchasing ${art.title}`)}">Email if interested in purchasing</a><a class="original-contact-email" href="${escapeHtml(inquiryUrl)}">${escapeHtml(inquiryEmail)}</a>` : ""}
        </article>`;
    }).join("");
    attachRevealHandlers();
    attachRotationHandlers();
  } catch (error) {
    grid.innerHTML = `<p class="notice error">Could not load originals. Make sure the backend is running.</p>`;
  }
}

function attachRotationHandlers() {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  document.querySelectorAll(".rotation-button").forEach((button) => {
    const image = button.closest(".original-card").querySelector(".rotating-art-image");
    let rotating = !reducedMotion.matches;
    const update = () => {
      image.classList.toggle("is-rotating", rotating);
      button.setAttribute("aria-pressed", String(rotating));
      button.setAttribute("aria-label", `${rotating ? "Pause" : "Start"} Sun Beam rotation`);
      button.textContent = rotating ? "Pause rotation" : "Rotate painting";
    };
    button.addEventListener("click", () => { rotating = !rotating; update(); });
    reducedMotion.addEventListener("change", () => { rotating = !reducedMotion.matches; update(); });
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(([entry]) => image.classList.toggle("rotation-in-view", entry.isIntersecting)).observe(image);
    } else image.classList.add("rotation-in-view");
    document.addEventListener("visibilitychange", () => image.classList.toggle("rotation-page-hidden", document.hidden));
    update();
  });
}

function attachRevealHandlers() {
  document.querySelectorAll(".shine-button").forEach((button) => {
    button.addEventListener("click", () => {
      const card = button.closest(".product-card");
      const image = card?.querySelector(".original-art-image img");
      if (!image) return;
      const revealed = image.dataset.revealed === "true";
      const url = revealed ? image.dataset.standardImage : image.dataset.revealImage;
      const template = document.createElement("template");
      template.innerHTML = responsiveImage(url, image.alt);
      ["src", "srcset", "sizes", "width", "height"].forEach((attribute) => {
        const value = template.content.firstElementChild.getAttribute(attribute);
        if (value === null) image.removeAttribute(attribute);
        else image.setAttribute(attribute, value);
      });
      image.dataset.revealed = String(!revealed);
      button.setAttribute("aria-pressed", String(!revealed));
      button.textContent = revealed ? "Shine a light" : "Return to normal light";
      card?.querySelector(".original-art-image")?.classList.toggle("is-revealed", !revealed);
    });
  });
}

function artworkPrintNote(artwork) {
  return artwork.key === "the-light"
    ? '<p class="print-product-note">The print of this painting does not interact with light like the original painting.</p>'
    : "";
}

function renderPrintGallery(artworks, grid) {
  if (!artworks.length) { grid.innerHTML = "<p>No artworks are currently available.</p>"; return; }
  grid.innerHTML = artworks.map((artwork) => {
    const productCount = new Set(artwork.products.map((product) => product.productType)).size;
    return `
    <article class="product-card gallery-card">
      ${artworkImage(artwork)}
      <div class="product-info"><div class="product-title-row"><h3>${escapeHtml(artwork.title)}</h3><span class="product-count">${productCount} product${productCount === 1 ? "" : "s"}</span></div>${artworkPrintNote(artwork)}</div>
      <button type="button" class="view-products" data-artwork-key="${escapeHtml(artwork.key)}">View products</button>
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
  return `<div class="product-preview"><img class="selected-product-image" src="${escapeHtml(images[0])}" alt="${escapeHtml(product.title)}"><div class="product-thumbnails">${images.map((url, index) => `<button type="button" class="product-thumbnail ${index === 0 ? "active" : ""}" data-image="${escapeHtml(url)}" aria-label="View product image ${index + 1}"><img src="${escapeHtml(url)}" alt=""></button>`).join("")}</div></div>`;
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
      const sizeButtons = (products, selectedId) => products.map((product) => { const available = product.stockQuantity === null ? null : Math.max(Number(product.stockQuantity) - Number(product.stockReserved || 0), 0); const stock = available === null ? "" : available > 0 ? ` · ${available} available` : " · Sold out"; return `<button type="button" class="variant-button ${product.id === selectedId ? "active" : ""}" data-product-id="${escapeHtml(product.id)}" ${available === 0 ? "disabled" : ""}>${escapeHtml(product.sizes || product.title)} · ${money(product.price)}${stock}</button>`; }).join("");
      const optionSummary = (product) => (product.printfulOptions || []).map((option) => `<span class="product-option">${escapeHtml(option.id.replaceAll("_", " "))}: ${escapeHtml(option.value)}</span>`).join("");
      const content = dialog.querySelector("#printDialogContent");
      content.innerHTML = `<div class="dialog-heading"><p class="section-label">${artwork.products.length} options available</p><h2 id="printDialogTitle">${escapeHtml(artwork.title)}</h2><p>${escapeHtml(artwork.description || "Made-to-order products fulfilled through Printful.")}</p>${artworkPrintNote(artwork)}<label class="product-choice-label" for="productChoice">Choose a product type</label><select id="productChoice" class="product-choice">${typeOptions}</select><label class="product-choice-label">Choose a size</label><div class="variant-buttons" data-variant-buttons>${sizeButtons(typeProducts(firstType), firstProduct.id)}</div><div class="product-options" data-product-options>${optionSummary(firstProduct)}</div><p class="dialog-price selected-product-price">${money(firstProduct.price)} before shipping</p></div><form class="checkout-form" data-id="${firstProduct.id}" data-fulfillment-type="${escapeHtml(firstProduct.fulfillmentType || "printful")}">${shippingAddressFields()}<button type="button" class="quote-shipping">Calculate shipping</button><button type="submit" disabled>Continue to Stripe</button></form><p class="notice" id="notice-${firstProduct.id}">Enter your mailing address to see live Printful shipping.</p>`;
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
        form.dataset.fulfillmentType = product.fulfillmentType || "printful";
        form.dispatchEvent(new Event("quoteinvalidated"));
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
        <form class="checkout-form" data-id="${item.id}" data-fulfillment-type="${escapeHtml(item.fulfillmentType || "printful")}">
          ${shippingAddressFields()}
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

function attachPrintCheckoutHandlers(root = document) {
  root.querySelectorAll(".checkout-form").forEach((form) => {
    if (!form.dataset.checkoutBound) attachShippingDestination(form);
    attachCheckoutHandler(form, "prints", form.parentElement.querySelector(".notice"));
  });
}

function attachCheckoutHandler(form, kind, notice) {
  if (form.dataset.checkoutBound) return;
  form.dataset.checkoutBound = "true";
  const quoteButton = form.querySelector(".quote-shipping");
  const checkoutButton = form.querySelector("button[type=submit]");
  let revision = 0;
  let quotedRevision = -1;
  let quotedTotal = null;
  let submitting = false;
  const invalidate = () => {
    revision++;
    quotedRevision = -1;
    quotedTotal = null;
    checkoutButton.disabled = true;
    notice.className = "notice";
    notice.textContent = "Calculate shipping for your current selection and address.";
  };
  ["input", "change", "quoteinvalidated"].forEach((event) => form.addEventListener(event, invalidate));
  quoteButton.addEventListener("click", async () => {
    if (!form.reportValidity() || submitting) return;
    const current = revision;
    const id = form.dataset.id;
    quotedRevision = -1;
    checkoutButton.disabled = true;
    quoteButton.disabled = true;
    notice.className = "notice";
    notice.textContent = "Calculating shipping...";
    try {
      const data = await fetchJson(`${API}/api/${kind}/${id}/shipping-rate`, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      if (current !== revision) return;
      quotedRevision = revision;
      quotedTotal = data.total;
      checkoutButton.disabled = false;
      const tax = Number(data.fulfillmentTax) > 0 ? ` Fulfillment tax: ${money(data.fulfillmentTax)}.` : "";
      const delivery = data.delivery?.min && data.delivery?.max ? ` Estimated delivery: ${data.delivery.min}-${data.delivery.max} business days.` : "";
      notice.textContent = `Shipping: ${money(data.shipping)}.${tax} Estimated total: ${money(data.total)}.${delivery}`;
    } catch (error) {
      if (current !== revision) return;
      notice.className = "notice error";
      notice.textContent = error.message;
    } finally { quoteButton.disabled = false; }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting || quotedRevision !== revision || quotedTotal === null || !form.reportValidity()) return;
    submitting = true;
    checkoutButton.disabled = true;
    quoteButton.disabled = true;
    notice.className = "notice";
    notice.textContent = "Creating secure checkout...";
    try {
      const body = { ...Object.fromEntries(new FormData(form).entries()), expectedTotal: quotedTotal };
      const data = await fetchJson(`${API}/api/${kind}/${form.dataset.id}/checkout`, { method: "POST", body: JSON.stringify(body) });
      window.location.href = data.checkoutUrl;
    } catch (error) {
      invalidate();
      notice.className = "notice error";
      notice.textContent = `${error.message} Please calculate shipping again.`;
    } finally { submitting = false; quoteButton.disabled = false; }
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
    if (aboutImage && content.aboutImage) { aboutImage.innerHTML = responsiveImage(content.aboutImage, "Rayan Rao", 'fetchpriority="high" decoding="async"'); aboutImage.classList.add("has-image"); }
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
