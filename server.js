require("dotenv").config();

const path = require("path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const morgan = require("morgan");
const validator = require("validator");
const Stripe = require("stripe");

const db = require("./src/db");
const email = require("./src/email");
const printful = require("./src/printful");
const sheets = require("./src/google-sheets");
const { estimateOriginalShipping, estimateSelfFulfillmentShipping } = require("./src/shipping");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const AUTO_CHARGE_AUCTIONS = false;

function slugifyId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || `art-${Date.now()}`;
}

function cleanNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function validateOriginalPayload(body, { allowMissingId = false } = {}) {
  const statusOptions = new Set(["draft", "active", "sold", "cancelled", "ended_no_bids", "auto_charge_failed", "payment_pending"]);
  const title = String(body.title || "").trim();
  const id = allowMissingId ? String(body.id || slugifyId(title)).trim() : String(body.id || "").trim();
  const medium = String(body.medium || "").trim();
  const size = String(body.size || "").trim();
  const year = String(body.year || new Date().getFullYear()).trim();
  const description = String(body.description || "").trim();
  const price = cleanNumber(body.price ?? body.startingBid);
  const startingBid = price;
  const bidIncrement = cleanNumber(body.bidIncrement, 10);
  const endsAt = String(body.endsAt || "2099-12-31T23:59:59.000Z").trim();
  const imageUrl = String(body.imageUrl || "").trim();
  const revealImageUrl = String(body.revealImageUrl || "").trim();
  const colorOne = String(body.colorOne || "#f4f4f4").trim();
  const colorTwo = String(body.colorTwo || "#d8d8d8").trim();
  const widthIn = cleanNumber(body.widthIn);
  const heightIn = cleanNumber(body.heightIn);
  const depthIn = cleanNumber(body.depthIn, 2);
  const weightLb = cleanNumber(body.weightLb);
  const status = statusOptions.has(String(body.status || "draft")) ? String(body.status || "draft") : "draft";

  if (!id || !/^[a-z0-9-]{2,80}$/.test(id)) throw new Error("Artwork ID must be lowercase letters, numbers, and hyphens only.");
  if (title.length < 2) throw new Error("Title is required.");
  if (medium.length < 2) throw new Error("Medium is required.");
  if (size.length < 2) throw new Error("Size is required, for example 18 × 24 in.");
  if (description.length < 5) throw new Error("Description is required.");
  if (!Number.isFinite(price) || price < 1) throw new Error("Price must be at least $1.");
  if (imageUrl && !validator.isURL(imageUrl, { require_protocol: true })) throw new Error("Image URL must begin with https:// or http://.");
  if (revealImageUrl && !validator.isURL(revealImageUrl, { require_protocol: true }) && !revealImageUrl.startsWith("/")) throw new Error("Reveal image URL must begin with https://, http://, or /.");
  if (widthIn !== null && widthIn <= 0) throw new Error("Width must be positive.");
  if (heightIn !== null && heightIn <= 0) throw new Error("Height must be positive.");
  if (depthIn !== null && depthIn <= 0) throw new Error("Depth must be positive.");
  if (weightLb !== null && weightLb <= 0) throw new Error("Weight must be positive.");

  return {
    id,
    title,
    medium,
    size,
    year,
    description,
    price,
    startingBid,
    bidIncrement,
    endsAt,
    imageUrl,
    revealImageUrl,
    colorOne,
    colorTwo,
    widthIn,
    heightIn,
    depthIn,
    weightLb,
    status,
    autoChargeEnabled: body.autoChargeEnabled !== false && body.autoChargeEnabled !== "false"
  };
}


app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("dev"));

function requireStripe(res) {
  if (!stripe) {
    res.status(500).json({ error: "Stripe is not configured. Add STRIPE_SECRET_KEY to your .env file." });
    return false;
  }
  return true;
}

function requireAdmin(req, res) {
  return res.status(404).json({ error: "Admin tools are disabled." });
}

async function processSingleAuctionAutoCharge(art, { force = false, selectedBid = null } = {}) {
  if (!stripe) throw new Error("Stripe is not configured.");

  const now = new Date();
  const auctionEnd = new Date(art.endsAt);

  if (!force && now < auctionEnd) {
    return { skipped: true, reason: "Auction has not ended yet.", originalId: art.id };
  }

  if (!force && art.status !== "active") {
    return { skipped: true, reason: `Auction status is ${art.status}.`, originalId: art.id };
  }

  const winningBid = selectedBid || db.getWinningBid(art.id);
  if (!winningBid) {
    return { skipped: true, reason: "No winning bid.", originalId: art.id };
  }

  const bidder = winningBid.bidder_id ? db.getBidderById(winningBid.bidder_id) : db.getBidderByEmail(winningBid.bidder_email);

  if (!bidder) {
    db.markOriginalAutoChargeFailed(art.id);
    return { failed: true, reason: "Winning bidder was not found.", originalId: art.id };
  }

  if (bidder.blocked) {
    db.markOriginalAutoChargeFailed(art.id);
    return { failed: true, reason: "Winning bidder is blocked.", originalId: art.id };
  }

  if (!bidder.email || !validator.isEmail(bidder.email)) {
    db.markOriginalAutoChargeFailed(art.id);
    return { failed: true, reason: "Winning bidder does not have a valid email.", originalId: art.id };
  }

  if (!bidder.stripeCustomerId || !bidder.stripePaymentMethodId || !bidder.autoChargeAuthorized) {
    db.markOriginalAutoChargeFailed(art.id);
    return { failed: true, reason: "Winning bidder is missing saved Stripe payment authorization.", originalId: art.id };
  }

  const existingPaid = db.getPaidPaymentForOriginal(art.id);
  if (existingPaid) {
    return { skipped: true, reason: "Original is already paid.", originalId: art.id };
  }

  const shippingEstimate = estimateOriginalShipping(art);
  const subtotalAmount = Math.round(winningBid.amount);
  const shippingAmount = Math.round(shippingEstimate.total);
  const totalAmount = subtotalAmount + shippingAmount;

  const attempt = db.createAutoChargeAttempt({
    originalId: art.id,
    bidId: winningBid.id,
    bidderId: bidder.id,
    subtotalAmount,
    shippingAmount,
    totalAmount
  });

  if (!attempt && !force) {
    return { skipped: true, reason: "This winning bid was already processed or attempted.", originalId: art.id };
  }

  db.markOriginalAutoChargeProcessing(art.id);

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalAmount * 100,
      currency: "usd",
      customer: bidder.stripeCustomerId,
      payment_method: bidder.stripePaymentMethodId,
      off_session: true,
      confirm: true,
      description: `Auction win: ${art.title}`,
      receipt_email: bidder.email,
      shipping: {
        name: bidder.shippingName || bidder.name,
        address: {
          line1: bidder.shippingLine1 || undefined,
          line2: bidder.shippingLine2 || undefined,
          city: bidder.shippingCity || undefined,
          state: bidder.shippingState || undefined,
          postal_code: bidder.shippingPostalCode || undefined,
          country: bidder.shippingCountry || "US"
        }
      },
      metadata: {
        kind: "original_auction_auto_charge",
        originalId: art.id,
        bidId: String(winningBid.id),
        bidderId: String(bidder.id || ""),
        subtotalAmount: String(subtotalAmount),
        shippingAmount: String(shippingAmount),
        totalAmount: String(totalAmount),
        shippingPackageType: shippingEstimate.packageType
      }
    });

    const paid = paymentIntent.status === "succeeded";
    const paymentStatus = paid ? "paid" : paymentIntent.status;

    const payment = db.createPayment({
      kind: "original",
      originalId: art.id,
      bidId: winningBid.id,
      bidderId: bidder.id,
      stripeSessionId: paymentIntent.id,
      stripePaymentIntentId: paymentIntent.id,
      checkoutUrl: `https://dashboard.stripe.com/test/payments/${paymentIntent.id}`,
      customerName: bidder.name,
      customerEmail: bidder.email,
      subtotalAmount,
      shippingAmount,
      totalAmount,
      amount: totalAmount,
      shippingJson: shippingEstimate,
      status: paymentStatus
    });

    db.updateAutoChargeAttempt({
      attemptId: attempt?.id,
      status: paymentStatus,
      stripePaymentIntentId: paymentIntent.id
    });

    if (paid) {
      db.markOriginalSold(art.id);

      await email.sendAuctionAutoChargeReceiptEmail({
        to: bidder.email,
        bidderName: bidder.name,
        original: art,
        subtotalAmount,
        shippingEstimate,
        totalAmount,
        paymentIntentId: paymentIntent.id
      });

      await email.sendArtistNotificationEmail({
        subject: `Auction automatically charged: ${art.title}`,
        body: `
          <p><strong>${art.title}</strong> was automatically charged after auction close.</p>
          <p>Buyer: ${bidder.name} (${bidder.email})</p>
          <p>Winning bid: $${subtotalAmount}</p>
          <p>Shipping/packaging: $${shippingAmount}</p>
          <p>Total charged: $${totalAmount}</p>
          <p>PaymentIntent: ${paymentIntent.id}</p>
        `
      });
    } else {
      db.markOriginalPaymentPending(art.id);
    }

    return { charged: paid, status: paymentStatus, originalId: art.id, paymentIntentId: paymentIntent.id, payment };
  } catch (error) {
    const reason = error.message || "Automatic charge failed.";
    db.markOriginalAutoChargeFailed(art.id);
    if (attempt?.id) {
      db.updateAutoChargeAttempt({
        attemptId: attempt.id,
        status: "failed",
        stripePaymentIntentId: error.payment_intent?.id || null,
        failureReason: reason
      });
    }

    db.createPayment({
      kind: "original",
      originalId: art.id,
      bidId: winningBid.id,
      bidderId: bidder.id,
      stripeSessionId: error.payment_intent?.id || `failed-auto-charge-${art.id}-${winningBid.id}-${Date.now()}`,
      stripePaymentIntentId: error.payment_intent?.id || null,
      checkoutUrl: "",
      customerName: bidder.name,
      customerEmail: bidder.email,
      subtotalAmount,
      shippingAmount,
      totalAmount,
      amount: totalAmount,
      shippingJson: shippingEstimate,
      status: error.code === "authentication_required" ? "requires_action" : "failed",
      failureReason: reason
    });

    await email.sendAuctionAutoChargeFailedEmail({
      to: bidder.email,
      bidderName: bidder.name,
      original: art,
      reason
    });

    await email.sendArtistNotificationEmail({
      subject: `Auction charge failed: ${art.title}`,
      body: `
        <p><strong>${art.title}</strong> automatic charge failed.</p>
        <p>Bidder: ${bidder.name} (${bidder.email})</p>
        <p>Reason: ${reason}</p>
      `
    });

    return { failed: true, reason, originalId: art.id };
  }
}

async function processEndedAuctions({ forceOriginalId = null, force = false } = {}) {
  if (!AUTO_CHARGE_AUCTIONS && !force) {
    return { skipped: true, reason: "AUTO_CHARGE_AUCTIONS=false" };
  }

  if (!stripe) {
    return { skipped: true, reason: "Stripe is not configured." };
  }

  const originals = forceOriginalId
    ? [db.getOriginalById(forceOriginalId)].filter(Boolean)
    : db.getEndedActiveOriginalsForAutoCharge();

  const results = [];
  for (const art of originals) {
    results.push(await processSingleAuctionAutoCharge(art, { force }));
  }

  return { processedCount: results.length, results };
}

// Stripe webhooks must receive the raw body.
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!requireStripe(res)) return;

  let event;

  try {
    const signature = req.headers["stripe-signature"];
    if (process.env.STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (error) {
    return res.status(400).send(`Webhook error: ${error.message}`);
  }

  try {
    console.log(`[stripe webhook] received ${event.type}${event.data?.object?.id ? ` (${event.data.object.id})` : ""}`);
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      if (session.mode === "setup") {
        const setupIntent = await stripe.setupIntents.retrieve(session.setup_intent);
        const bidder = db.markBidderSetupComplete({
          stripeSessionId: session.id,
          stripeSetupIntentId: session.setup_intent,
          stripeCustomerId: session.customer,
          stripePaymentMethodId: setupIntent.payment_method
        });

        if (bidder) {
          await stripe.customers.update(bidder.stripeCustomerId, {
            invoice_settings: { default_payment_method: bidder.stripePaymentMethodId },
            address: {
              line1: bidder.shippingLine1 || undefined,
              line2: bidder.shippingLine2 || undefined,
              city: bidder.shippingCity || undefined,
              state: bidder.shippingState || undefined,
              postal_code: bidder.shippingPostalCode || undefined,
              country: bidder.shippingCountry || "US"
            },
            shipping: {
              name: bidder.shippingName || bidder.name,
              address: {
                line1: bidder.shippingLine1 || undefined,
                line2: bidder.shippingLine2 || undefined,
                city: bidder.shippingCity || undefined,
                state: bidder.shippingState || undefined,
                postal_code: bidder.shippingPostalCode || undefined,
                country: bidder.shippingCountry || "US"
              }
            }
          });

          await email.sendBidderApprovedEmail({ to: bidder.email, bidderName: bidder.name });
          await email.sendArtistNotificationEmail({
            subject: `New approved bidder: ${bidder.name}`,
            body: `
              <p><strong>${bidder.name}</strong> registered to bid and authorized automatic winner charging.</p>
              <p>Email: ${bidder.email}</p>
              <p>Phone: ${bidder.phone || "Not provided"}</p>
              <p>Ship to: ${bidder.shippingLine1 || ""}, ${bidder.shippingCity || ""}, ${bidder.shippingState || ""} ${bidder.shippingPostalCode || ""}</p>
            `
          });
        }
      }

      if (session.mode === "payment") {
        const payment = db.getPaymentByStripeSessionId(session.id);
        const paidPrint = payment?.kind === "print" ? db.getPrintById(payment.print_id) : null;
        const shouldProcessPrintful = payment?.kind === "print" && paidPrint?.fulfillmentType !== "self" && !payment.printful_order_id;
        if (payment && (payment.status !== "paid" || shouldProcessPrintful)) {
          const wasAlreadyPaid = payment.status === "paid";
          if (!wasAlreadyPaid) db.markPaymentPaid(session.id);
          if (payment.kind === "original") {
            const original = db.getOriginalById(payment.original_id);
            db.markOriginalSold(payment.original_id);
            await email.sendBuyerReceiptEmail({
              to: payment.customer_email,
              subject: `Payment received for ${original.title}`,
              heading: "Payment received",
              body: `Thank you for your payment for ${original.title}. Rayan will follow up with shipping details.`
            });
          }

          if (payment.kind === "print") {
            const print = db.getPrintById(payment.print_id);
            console.log(`[print order] paid session=${session.id} print=${print?.title || payment.print_id}`);
            if (!wasAlreadyPaid) {
              await email.sendBuyerReceiptEmail({
                to: session.customer_details?.email || payment.customer_email,
                subject: `Order received for ${print.title}`,
                heading: "Order received",
                body: `Thank you for ordering ${print.title}. Your order has been received.`
              });
              if (print?.fulfillmentType === "self") {
                const stockReserved = db.decrementPrintStock(print.id);
                let shippingDetails = {};
                try { shippingDetails = JSON.parse(payment.shipping_json || "{}").recipient || {}; } catch { shippingDetails = {}; }
                const shippingAddress = [shippingDetails.address1, shippingDetails.address2, shippingDetails.city, shippingDetails.state_code, shippingDetails.zip].filter(Boolean).join(", ");
                await email.sendArtistNotificationEmail({
                  subject: `Self-fulfillment order: ${print.title}`,
                  body: `<p><strong>Fulfillment:</strong> Self-fulfilled by Rayan</p><p><strong>Product:</strong> ${print.title}</p><p><strong>Customer:</strong> ${payment.customer_name} (${payment.customer_email})</p><p><strong>Amount paid:</strong> $${payment.total_amount}</p><p><strong>Stock reserved:</strong> ${stockReserved ? "Yes" : "No, stock was already depleted. Review this order immediately."}</p><p><strong>Shipping address:</strong> ${shippingAddress || "See Stripe payment details."}</p>`
                });
              } else {
                await email.sendArtistNotificationEmail({
                  subject: `Printful order: ${print.title}`,
                  body: `<p><strong>Fulfillment:</strong> Printful</p><p><strong>Product:</strong> ${print.title}</p><p><strong>Customer:</strong> ${payment.customer_name} (${payment.customer_email})</p><p><strong>Amount paid:</strong> $${payment.total_amount}</p>`
                });
              }
            }

            if (print?.fulfillmentType !== "self") {
              const printfulResult = await printful.createDraftOrderFromStripeSession({ payment, print, stripeSession: session });
              if (printfulResult?.printfulOrderId) db.setPaymentPrintfulOrderId(payment.id, String(printfulResult.printfulOrderId));
              console.log(`[print order] Printful result: ${printfulResult?.printfulOrderId ? `draft ${printfulResult.printfulOrderId}` : printfulResult?.reason || "no draft id returned"}`);
            }
          }

          if (sheets.isConfigured()) {
            const latestPayment = db.getPaymentByStripeSessionId(session.id);
            const latestPrint = latestPayment?.kind === "print" ? db.getPrintById(latestPayment.print_id) : null;
            const latestOriginal = latestPayment?.kind === "original" ? db.getOriginalById(latestPayment.original_id) : null;
            if (await sheets.appendPaidOrder({ payment: latestPayment, print: latestPrint, original: latestOriginal })) {
              db.markPaymentGoogleSheetsSynced(latestPayment.id);
              console.log(`[google sheets] recorded order ${latestPayment.id}`);
            }
          }
        }
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error("Webhook handling error:", error);
    res.status(500).json({ error: "Webhook handler failed." });
  }
});

app.use(express.json());
app.use("/api/admin", (req, res) => res.status(404).json({ error: "Admin tools are disabled." }));
app.use("/api/bidders", (req, res) => res.status(404).json({ error: "Bidding is no longer available." }));
app.use("/api/originals/:id/bids", (req, res) => res.status(404).json({ error: "Bidding is no longer available." }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => res.json({
  ok: true,
  message: "Rayan Rao Art API is running.",
  emailEnabled: email.isEmailEnabled(),
  resendConfigured: Boolean(process.env.RESEND_API_KEY),
  fromEmail: process.env.FROM_EMAIL || "Rayan Rao Art <onboarding@resend.dev>"
}));

app.get("/api/site-content", (req, res) => res.json({ content: db.getSiteContent() }));

app.get("/api/originals", (req, res) => {
  const originals = db.getOriginals().map((art) => ({ ...art, currentBid: db.getCurrentBid(art.id) }));
  res.json({ originals });
});

app.get("/api/originals/:id", (req, res) => {
  const art = db.getOriginalById(req.params.id);
  if (!art) return res.status(404).json({ error: "Original artwork not found." });
  res.json({ original: art });
});

app.post("/api/originals/:id/shipping-rate", (req, res) => {
  const art = db.getOriginalById(req.params.id);
  if (!art) return res.status(404).json({ error: "Original artwork not found." });
  const recipient = printShippingRecipient(req.body);
  const validationError = validatePrintShippingRecipient(recipient);
  if (validationError) return res.status(400).json({ error: validationError });
  const estimate = estimateOriginalShipping({ ...art, destinationState: recipient.state_code });
  res.json({ shipping: estimate.total, product: art.price, total: art.price + estimate.total, currency: "USD", name: "Estimated shipping", estimate });
});

app.post("/api/originals/:id/checkout", async (req, res) => {
  if (!requireStripe(res)) return;
  const art = db.getOriginalById(req.params.id);
  if (!art) return res.status(404).json({ error: "Original artwork not found." });
  if (art.status === "sold" || db.getPaidPaymentForOriginal(art.id)) return res.status(409).json({ error: "This original artwork has already been sold." });

  const recipient = printShippingRecipient(req.body);
  const validationError = validatePrintShippingRecipient(recipient);
  if (validationError) return res.status(400).json({ error: validationError });
  const estimate = estimateOriginalShipping({ ...art, destinationState: recipient.state_code });
  const totalAmount = Math.round(Number(art.price) + Number(estimate.total));
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: recipient.email,
    line_items: [
      { price_data: { currency: "usd", unit_amount: Math.round(art.price * 100), product_data: { name: art.title, description: `${art.medium} · ${art.size}` } }, quantity: 1 },
      { price_data: { currency: "usd", unit_amount: Math.round(estimate.total * 100), product_data: { name: "Shipping", description: "Estimated shipping and packaging" } }, quantity: 1 }
    ],
    shipping_address_collection: { allowed_countries: ["US"] },
    metadata: { kind: "original", originalId: art.id },
    success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE_URL}/originals.html`
  });
  db.createPayment({ kind: "original", originalId: art.id, stripeSessionId: session.id, checkoutUrl: session.url, customerName: recipient.name, customerEmail: recipient.email, subtotalAmount: art.price, shippingAmount: estimate.total, totalAmount, amount: totalAmount, shippingJson: { recipient, estimate }, status: "pending" });
  res.json({ checkoutUrl: session.url });
});

app.post("/api/bidders/register", async (req, res) => {
  if (!requireStripe(res)) return;

  const name = String(req.body.name || "").trim();
  const emailAddress = String(req.body.email || "").trim().toLowerCase();
  const phone = String(req.body.phone || "").trim();
  const location = String(req.body.location || "").trim();
  const acceptedTerms = Boolean(req.body.acceptedTerms);
  const autoChargeAuthorized = Boolean(req.body.autoChargeAuthorized);
  const shippingLine1 = String(req.body.shippingLine1 || "").trim();
  const shippingLine2 = String(req.body.shippingLine2 || "").trim();
  const shippingCity = String(req.body.shippingCity || "").trim();
  const shippingState = String(req.body.shippingState || "").trim();
  const shippingPostalCode = String(req.body.shippingPostalCode || "").trim();
  const shippingCountry = String(req.body.shippingCountry || "US").trim().toUpperCase();

  if (name.length < 2) return res.status(400).json({ error: "Please enter your name." });
  if (!validator.isEmail(emailAddress)) return res.status(400).json({ error: "A valid email is required to bid and receive receipts." });
  if (!acceptedTerms) return res.status(400).json({ error: "You must agree to the auction terms before registering to bid." });
  if (!autoChargeAuthorized) return res.status(400).json({ error: "You must authorize automatic charging if you win before registering to bid." });
  if (!shippingLine1 || !shippingCity || !shippingState || !shippingPostalCode) {
    return res.status(400).json({ error: "Shipping address is required because winners are charged shipping and packaging." });
  }
  if (shippingCountry !== "US") return res.status(400).json({ error: "This checkout currently supports US shipping only." });

  let existingBidder = db.getBidderByEmail(emailAddress);
  let customerId = existingBidder?.stripeCustomerId || "";

  if (!customerId) {
    const customer = await stripe.customers.create({
      name,
      email: emailAddress,
      phone: phone || undefined,
      address: { line1: shippingLine1, line2: shippingLine2 || undefined, city: shippingCity, state: shippingState, postal_code: shippingPostalCode, country: shippingCountry },
      shipping: { name, address: { line1: shippingLine1, line2: shippingLine2 || undefined, city: shippingCity, state: shippingState, postal_code: shippingPostalCode, country: shippingCountry } },
      metadata: { source: "rayan_rao_art_auto_charge_auction" }
    });
    customerId = customer.id;
  }

  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: customerId,
    payment_method_types: ["card"],
    success_url: `${BASE_URL}/register-success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE_URL}/register.html`,
    metadata: { kind: "bidder_registration_auto_charge", email: emailAddress }
  });

  const bidder = db.createOrUpdateBidder({
    name,
    email: emailAddress,
    phone,
    location,
    shippingName: name,
    shippingLine1,
    shippingLine2,
    shippingCity,
    shippingState,
    shippingPostalCode,
    shippingCountry,
    stripeCustomerId: customerId,
    stripeSetupSessionId: session.id,
    termsAccepted: true,
    autoChargeAuthorized: true
  });

  res.status(201).json({ checkoutUrl: session.url, bidder });
});

app.get("/api/bidders/status", (req, res) => {
  const emailAddress = String(req.query.email || "").trim().toLowerCase();
  if (!validator.isEmail(emailAddress)) return res.status(400).json({ error: "Please provide a valid email address." });
  const bidder = db.getBidderByEmail(emailAddress);
  if (!bidder) return res.status(404).json({ error: "No bidder registration found for this email." });
  res.json({ bidder });
});

app.post("/api/originals/:id/bids", (req, res) => {
  const art = db.getOriginalById(req.params.id);
  if (!art) return res.status(404).json({ error: "Original artwork not found." });
  if (art.status !== "active") return res.status(400).json({ error: "This auction is not currently active." });

  const now = new Date();
  const auctionEnd = new Date(art.endsAt);
  if (Number.isNaN(auctionEnd.getTime())) return res.status(500).json({ error: "Auction end date is invalid." });
  if (now >= auctionEnd) return res.status(400).json({ error: "This auction has already ended." });

  const bidderEmail = String(req.body.bidderEmail || "").trim().toLowerCase();
  const amount = Number(req.body.amount);

  if (!validator.isEmail(bidderEmail)) return res.status(400).json({ error: "A valid registered email is required to place a bid." });

  const bidder = db.getBidderByEmail(bidderEmail);
  if (!bidder) return res.status(403).json({ error: "You must register to bid before placing a bid." });
  if (bidder.blocked) return res.status(403).json({ error: "This bidder account is blocked from bidding." });
  if (!bidder.termsAccepted || !bidder.autoChargeAuthorized) return res.status(403).json({ error: "You must accept the auction terms and authorize automatic winner charging before bidding." });
  if (!bidder.paymentMethodSaved || !bidder.stripePaymentMethodId || !bidder.approvedToBid) {
    return res.status(403).json({ error: "Your bidder registration is not complete yet. Please finish Stripe payment-method verification first." });
  }
  if (!Number.isFinite(amount)) return res.status(400).json({ error: "Please enter a valid bid amount." });

  const currentBid = db.getCurrentBid(art.id);
  const minimumNextBid = currentBid + art.bidIncrement;
  if (amount < minimumNextBid) {
    return res.status(400).json({ error: `Bid must be at least $${minimumNextBid}.`, currentBid, minimumNextBid });
  }

  const bid = db.createBid({ originalId: art.id, bidderId: bidder.id, bidderName: bidder.name, bidderEmail: bidder.email, amount });
  res.status(201).json({ message: "Bid placed successfully. If you are the highest bidder when the auction ends, your saved payment method will be charged automatically for the bid plus estimated shipping/packaging.", bid, currentBid: amount, minimumNextBid: amount + art.bidIncrement, shippingEstimate: art.shippingEstimate });
});

app.get("/api/originals/:id/bids", (req, res) => {
  const art = db.getOriginalById(req.params.id);
  if (!art) return res.status(404).json({ error: "Original artwork not found." });
  const bids = db.getBidsForOriginal(art.id).map((bid) => ({ id: bid.id, amount: bid.amount, createdAt: bid.created_at }));
  res.json({ bids });
});

app.get("/api/prints", (req, res) => {
  const groups = new Map();
  db.getPrints().forEach((print) => {
    const key = print.artworkKey || print.id;
    if (!groups.has(key)) groups.set(key, { key, title: print.artworkKey || print.title, imageUrl: print.imageUrl, colorOne: print.colorOne, colorTwo: print.colorTwo, description: print.description, products: [] });
    groups.get(key).products.push(print);
  });
  res.json({ artworks: [...groups.values()] });
});

function printShippingRecipient(body) {
  return { name: String(body.name || "").trim(), address1: String(body.address1 || "").trim(), address2: String(body.address2 || "").trim(), city: String(body.city || "").trim(), state_code: String(body.state || "").trim().toUpperCase(), country_code: String(body.country || "US").trim().toUpperCase(), zip: String(body.postalCode || "").trim(), email: String(body.email || "").trim().toLowerCase() };
}

function validatePrintShippingRecipient(recipient) {
  if (recipient.name.length < 2) return "Please enter the recipient name.";
  if (!validator.isEmail(recipient.email)) return "Please enter a valid email address.";
  if (!recipient.address1 || !recipient.city || !recipient.state_code || !recipient.zip) return "Please complete the shipping address.";
  if (recipient.country_code !== "US") return "This checkout currently supports US shipping only.";
  return null;
}

async function getPrintShippingQuote(print, body) {
  const recipient = printShippingRecipient(body);
  const validationError = validatePrintShippingRecipient(recipient);
  if (validationError) { const error = new Error(validationError); error.statusCode = 400; throw error; }
  if (print.fulfillmentType === "self") {
    const estimate = estimateSelfFulfillmentShipping(print, recipient);
    return { recipient, rate: { id: "SELF_ESTIMATE", name: "Estimated shipping", currency: "USD" }, shippingAmount: estimate.total, fulfillmentTax: 0, fulfillmentCosts: null, selfEstimate: estimate };
  }
  const rates = await printful.getShippingRatesForPrint({ print, recipient });
  const rate = rates.find((candidate) => candidate.id === "STANDARD") || rates[0];
  if (!rate || !Number.isFinite(Number(rate.rate))) throw new Error("Printful did not return a shipping rate for this address.");
  const estimate = await printful.estimatePrintCosts({ print, recipient, shippingMethod: rate.id });
  const costs = estimate?.costs || {};
  const fulfillmentTax = Math.round((Number(costs.tax || 0) + Number(costs.vat || 0)) * 100) / 100;
  return {
    recipient,
    rate,
    shippingAmount: Math.round(Number(rate.rate) * 100) / 100,
    fulfillmentTax,
    fulfillmentCosts: {
      currency: costs.currency || rate.currency || "USD",
      subtotal: Number(costs.subtotal || 0),
      discount: Number(costs.discount || 0),
      shipping: Number(costs.shipping || 0),
      digitization: Number(costs.digitization || 0),
      additionalFee: Number(costs.additional_fee || 0),
      fulfillmentFee: Number(costs.fulfillment_fee || 0),
      tax: Number(costs.tax || 0),
      vat: Number(costs.vat || 0),
      total: Number(costs.total || 0)
    }
  };
}

app.post("/api/prints/:id/shipping-rate", async (req, res) => {
  try {
    const print = db.getPrintById(req.params.id);
    if (!print) return res.status(404).json({ error: "Print product not found." });
    const quote = await getPrintShippingQuote(print, req.body);
    res.json({ shipping: quote.shippingAmount, fulfillmentTax: quote.fulfillmentTax, product: print.price, total: Math.round((print.price + quote.shippingAmount + quote.fulfillmentTax) * 100) / 100, currency: quote.rate.currency, method: quote.rate.id, name: quote.rate.name, delivery: { min: quote.rate.minDeliveryDays, max: quote.rate.maxDeliveryDays }, estimate: quote.selfEstimate || null });
  } catch (error) { res.status(error.statusCode || 502).json({ error: error.message || "Could not calculate shipping." }); }
});

app.post("/api/prints/:id/checkout", async (req, res) => {
  if (!requireStripe(res)) return;
  const print = db.getPrintById(req.params.id);
  if (!print) return res.status(404).json({ error: "Print product not found." });
  if (print.fulfillmentType === "self" && print.stockQuantity !== null && print.stockQuantity <= 0) return res.status(409).json({ error: "This product is sold out." });

  let quote;
  try { quote = await getPrintShippingQuote(print, req.body); }
  catch (error) { return res.status(error.statusCode || 502).json({ error: error.message || "Could not calculate shipping." }); }
  const { recipient, rate, shippingAmount, fulfillmentTax } = quote;
  const customerEmail = recipient.email;
  const shippingCents = Math.round(shippingAmount * 100);
  const sessionConfig = {
    mode: "payment",
    line_items: [{ price_data: { currency: "usd", unit_amount: Math.round(print.price * 100), product_data: { name: print.title, description: `${print.productType} · ${print.sizes}` } }, quantity: 1 }],
    shipping_address_collection: { allowed_countries: ["US"] },
    customer_email: customerEmail,
    metadata: { kind: "print", printId: print.id, fulfillmentType: print.fulfillmentType || "printful" },
    success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE_URL}/prints.html`
  };
  sessionConfig.line_items.push({ price_data: { currency: "usd", unit_amount: shippingCents, product_data: { name: "Shipping", description: rate.name || "Shipping" } }, quantity: 1 });
  if (fulfillmentTax > 0) sessionConfig.line_items.push({ price_data: { currency: "usd", unit_amount: Math.round(fulfillmentTax * 100), product_data: { name: "Printful fulfillment tax", description: "Estimated Printful fulfillment tax" } }, quantity: 1 });
  const session = await stripe.checkout.sessions.create(sessionConfig);
  db.createPayment({ kind: "print", printId: print.id, stripeSessionId: session.id, checkoutUrl: session.url, customerName: recipient.name, customerEmail, subtotalAmount: print.price, shippingAmount, totalAmount: print.price + shippingAmount + fulfillmentTax, amount: print.price + shippingAmount + fulfillmentTax, shippingJson: { recipient, method: rate.id, name: rate.name, rate: shippingAmount, fulfillmentTax, fulfillmentCosts: quote.fulfillmentCosts || null, currency: rate.currency, estimate: quote.selfEstimate || null }, status: "pending" });
  res.json({ checkoutUrl: session.url });
});

app.get("/api/admin/originals", requireAdmin, (req, res) => {
  const originals = db.getAllOriginalsForAdmin().map((art) => ({ ...art, currentBid: db.getCurrentBid(art.id), winningBid: db.getWinningBid(art.id), secondHighestBid: db.getSecondHighestBid(art.id), payment: db.getLatestPaymentForOriginal(art.id) }));
  res.json({ originals, chargeAttempts: db.getAutoChargeAttempts() });
});


app.post("/api/admin/originals", requireAdmin, (req, res) => {
  try {
    const payload = validateOriginalPayload(req.body, { allowMissingId: true });
    if (db.getOriginalById(payload.id)) {
      return res.status(400).json({ error: "An artwork with this ID already exists. Change the ID or title." });
    }
    const original = db.createOriginalArtwork(payload);
    res.status(201).json({ message: "Original artwork created.", original });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not create artwork." });
  }
});

app.put("/api/admin/originals/:id", requireAdmin, (req, res) => {
  try {
    const existing = db.getOriginalById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Original artwork not found." });
    const payload = validateOriginalPayload({ ...req.body, id: req.params.id });
    const original = db.updateOriginalArtwork(req.params.id, payload);
    res.json({ message: "Original artwork updated.", original });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not update artwork." });
  }
});

app.delete("/api/admin/originals/:id", requireAdmin, (req, res) => {
  const existing = db.getOriginalById(req.params.id);
  if (!existing) return res.status(404).json({ error: "Original artwork not found." });
  const hasBids = db.getBidsForOriginal(req.params.id).length > 0;
  if (hasBids && existing.status !== "draft") {
    return res.status(400).json({ error: "This artwork has bids. Cancel or archive it after reviewing the auction instead of deleting it." });
  }
  db.archiveOriginalArtwork(req.params.id);
  res.json({ message: "Artwork archived." });
});

app.post("/api/admin/shipping/estimate", requireAdmin, (req, res) => {
  try {
    const payload = validateOriginalPayload(req.body, { allowMissingId: true });
    res.json({ shippingEstimate: estimateOriginalShipping(payload) });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not estimate shipping." });
  }
});

app.put("/api/admin/prints/:id/artwork-group", requireAdmin, (req, res) => {
  const print = db.getPrintById(req.params.id);
  if (!print) return res.status(404).json({ error: "Print product not found." });
  const artworkKey = String(req.body.artworkKey || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!artworkKey) return res.status(400).json({ error: "Enter an artwork group name." });
  const updated = db.setPrintArtworkKey(print.id, artworkKey);
  res.json({ message: "Artwork group updated.", print: updated });
});

app.post("/api/admin/auctions/process-ended", requireAdmin, async (req, res) => {
  try {
    const result = await processEndedAuctions();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || "Could not process ended auctions." });
  }
});

app.post("/api/admin/originals/:id/auto-charge-winner", requireAdmin, async (req, res) => {
  try {
    const result = await processEndedAuctions({ forceOriginalId: req.params.id, force: true });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || "Could not auto-charge winner." });
  }
});

app.post("/api/admin/originals/:id/end-bidding-now", requireAdmin, async (req, res) => {
  try {
    const art = db.getOriginalById(req.params.id);
    if (!art) return res.status(404).json({ error: "Original artwork not found." });

    if (["sold", "auto_charge_processing"].includes(art.status)) {
      return res.status(400).json({ error: `This auction cannot be ended because its status is ${art.status}.` });
    }

    const winningBid = db.getWinningBid(art.id);
    if (!winningBid) {
      db.markOriginalStatus(art.id, "ended_no_bids");
      return res.json({ ended: true, charged: false, status: "ended_no_bids", message: "Bidding ended. No bids were found, so no one was charged." });
    }

    const result = await processSingleAuctionAutoCharge(art, { force: true, selectedBid: winningBid });
    res.json({ ended: true, message: "Bidding ended and the winning bidder was processed.", result });
  } catch (error) {
    res.status(500).json({ error: error.message || "Could not end bidding now." });
  }
});

app.post("/api/admin/originals/:id/cancel-auction", requireAdmin, (req, res) => {
  const art = db.getOriginalById(req.params.id);
  if (!art) return res.status(404).json({ error: "Original artwork not found." });

  if (["sold", "auto_charge_processing"].includes(art.status)) {
    return res.status(400).json({ error: `This auction cannot be cancelled because its status is ${art.status}.` });
  }

  db.markOriginalStatus(art.id, "cancelled");
  res.json({ cancelled: true, status: "cancelled", message: "Auction cancelled. New bids are now blocked and no one was charged." });
});

app.post("/api/admin/originals/:id/reopen-auction", requireAdmin, (req, res) => {
  const art = db.getOriginalById(req.params.id);
  if (!art) return res.status(404).json({ error: "Original artwork not found." });

  if (["sold", "auto_charge_processing"].includes(art.status)) {
    return res.status(400).json({ error: `This auction cannot be reopened because its status is ${art.status}.` });
  }

  let endsAt = req.body?.endsAt ? String(req.body.endsAt) : "";
  const currentEnd = new Date(art.endsAt);

  if (!endsAt) {
    if (Number.isNaN(currentEnd.getTime()) || currentEnd <= new Date()) {
      endsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    } else {
      endsAt = art.endsAt;
    }
  }

  const parsedEnd = new Date(endsAt);
  if (Number.isNaN(parsedEnd.getTime())) {
    return res.status(400).json({ error: "Invalid auction end date." });
  }

  db.updateOriginalEndsAt(art.id, endsAt);
  db.markOriginalStatus(art.id, "active");
  res.json({ reopened: true, status: "active", endsAt, message: "Auction reopened. Bidding is active again." });
});

app.post("/api/admin/originals/:id/charge-second-highest", requireAdmin, async (req, res) => {
  try {
    const art = db.getOriginalById(req.params.id);
    if (!art) return res.status(404).json({ error: "Original artwork not found." });

    if (art.status === "sold") {
      return res.status(400).json({ error: "This original is already sold." });
    }

    const secondHighestBid = db.getSecondHighestBid(art.id);
    if (!secondHighestBid) {
      return res.status(400).json({ error: "There is no second-highest bidder for this auction." });
    }

    const result = await processSingleAuctionAutoCharge(art, { force: true, selectedBid: secondHighestBid });
    res.json({ message: "Second-highest bidder was processed.", result });
  } catch (error) {
    res.status(500).json({ error: error.message || "Could not process second-highest bidder." });
  }
});

// Manual checkout fallback remains available but automatic charging is the default auction path.
app.post("/api/admin/originals/:id/create-winner-checkout", requireAdmin, async (req, res) => {
  if (!requireStripe(res)) return;
  const art = db.getOriginalById(req.params.id);
  if (!art) return res.status(404).json({ error: "Original artwork not found." });
  const winningBid = db.getWinningBid(art.id);
  if (!winningBid) return res.status(400).json({ error: "There are no bids for this original yet." });
  const existingPaid = db.getPaidPaymentForOriginal(art.id);
  if (existingPaid) return res.status(400).json({ error: "This original has already been paid for." });

  const shippingEstimate = estimateOriginalShipping(art);
  const totalAmount = Math.round(winningBid.amount + shippingEstimate.total);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: winningBid.bidder_email,
    line_items: [{ price_data: { currency: "usd", unit_amount: Math.round(totalAmount * 100), product_data: { name: `Original painting: ${art.title}`, description: `${art.medium} · ${art.size} · Winning bid $${winningBid.amount} + shipping $${shippingEstimate.total}` } }, quantity: 1 }],
    metadata: { kind: "original", originalId: art.id, bidId: String(winningBid.id) },
    success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE_URL}/originals.html`
  });

  const bidder = winningBid.bidder_id ? db.getBidderById(winningBid.bidder_id) : db.getBidderByEmail(winningBid.bidder_email);
  const payment = db.createPayment({ kind: "original", originalId: art.id, bidId: winningBid.id, bidderId: bidder?.id || null, stripeSessionId: session.id, checkoutUrl: session.url, customerName: winningBid.bidder_name, customerEmail: winningBid.bidder_email, subtotalAmount: winningBid.amount, shippingAmount: shippingEstimate.total, totalAmount, amount: totalAmount, shippingJson: shippingEstimate, status: "pending" });
  db.markOriginalPaymentPending(art.id);
  await email.sendWinnerPaymentEmail({ to: winningBid.bidder_email, bidderName: winningBid.bidder_name, original: art, subtotalAmount: winningBid.amount, shippingEstimate, amount: totalAmount, checkoutUrl: session.url });
  res.status(201).json({ message: "Winner checkout link created.", checkoutUrl: session.url, payment });
});

app.get("/api/admin/bidders", requireAdmin, (req, res) => res.json({ bidders: db.getAllBidders() }));
app.post("/api/admin/bidders/:id/approve", requireAdmin, (req, res) => res.json({ bidder: db.setBidderApproval(req.params.id, true) }));
app.post("/api/admin/bidders/:id/block", requireAdmin, (req, res) => res.json({ bidder: db.setBidderBlocked(req.params.id, true) }));
app.post("/api/admin/bidders/:id/unblock", requireAdmin, (req, res) => res.json({ bidder: db.setBidderBlocked(req.params.id, false) }));

app.post("/api/admin/email/test", requireAdmin, async (req, res) => {
  const to = String(req.body.to || process.env.ARTIST_EMAIL || "").trim();
  if (!validator.isEmail(to)) {
    return res.status(400).json({ error: "Enter a valid email address to send the test email." });
  }

  const result = await email.sendEmail({
    to,
    subject: "Rayan Rao Art email test",
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111;">
        <h1 style="font-weight:500;">Email test successful</h1>
        <p>If you received this, Resend is configured correctly for your art site.</p>
        <p>From: ${process.env.FROM_EMAIL || "Rayan Rao Art <onboarding@resend.dev>"}</p>
      </div>
    `
  });

  if (result.failed) {
    return res.status(500).json({ error: result.reason || "Resend failed to send the test email.", result });
  }

  res.json({ message: "Test email attempted.", result });
});


app.get("/api/admin/prints", requireAdmin, (req, res) => res.json({ prints: db.getAllPrintsForAdmin() }));
app.post("/api/admin/printful/sync-products", requireAdmin, async (req, res) => {
  try {
    const syncData = await printful.fetchPrintfulProductsForWebsite();
    const results = db.upsertPrintfulPrints(syncData.importedProducts);
    res.json({ message: "Printful product sync complete.", printfulProductCount: syncData.printfulProductCount, importedVariantCount: syncData.importedProducts.length, createdCount: results.filter((item) => item.action === "created").length, updatedCount: results.filter((item) => item.action === "updated").length, results, skipped: syncData.skipped });
  } catch (error) {
    console.error("Printful sync failed:", error);
    res.status(500).json({ error: error.message || "Printful sync failed." });
  }
});

app.get(["/", "/index.html", "/originals.html", "/prints.html", "/success.html", "/cancel.html", "/privacy.html", "/shipping-policy.html", "/refunds-returns.html", "/terms.html"], (req, res) => {
  const file = req.path === "/" ? "index.html" : req.path.replace("/", "");
  res.sendFile(path.join(__dirname, "public", file));
});

async function syncPrintfulOnStartup() {
  if (String(process.env.PRINTFUL_SYNC_ON_STARTUP || "false").toLowerCase() !== "true") return;
  try {
    const syncData = await printful.fetchPrintfulProductsForWebsite();
    const results = db.upsertPrintfulPrints(syncData.importedProducts);
    console.log(`[printful startup sync] imported ${syncData.importedProducts.length} variants from ${syncData.printfulProductCount} products; created ${results.filter((item) => item.action === "created").length}, updated ${results.filter((item) => item.action === "updated").length}`);
    if (syncData.skipped.length) console.warn(`[printful startup sync] skipped ${syncData.skipped.length} products or variants.`);
  } catch (error) {
    console.error("[printful startup sync] failed:", error.message || error);
  }
}

app.listen(PORT, async () => {
  console.log(`Rayan Rao Art site running at http://localhost:${PORT}`);
  await syncPrintfulOnStartup();
});
