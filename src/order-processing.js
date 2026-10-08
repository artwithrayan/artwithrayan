const { logger, redactSecrets } = require("./security");
const crypto = require("crypto");

function createOrderProcessor({ db, stripe, printful, sheets, email }) {
  const inFlight = new Map();
  let ticking = false;

  function processPayment(paymentId) {
    if (inFlight.has(paymentId)) return inFlight.get(paymentId);
    const work = runPayment(paymentId).finally(() => inFlight.delete(paymentId));
    inFlight.set(paymentId, work);
    return work;
  }

  async function runPayment(paymentId) {
    let payment = db.getPaymentById(paymentId);
    if (!payment || !["paid", "refund_pending", "refunded"].includes(payment.status)) return { errors: [] };
    const errors = [];
    const attempt = async (task, callback) => {
      try { await callback(); }
      catch (error) { errors.push(`${task}: ${redactSecrets(error.message || error)}`); }
    };
    let print = payment.print_id ? db.getPrintById(payment.print_id) : null;

    if (payment.status === "refund_pending") {
      await attempt("Refund", async () => {
        if (!stripe || !payment.stripe_payment_intent_id) throw new Error("Stripe payment intent is missing for the required refund.");
        await stripe.refunds.create({ payment_intent: payment.stripe_payment_intent_id, reason: "requested_by_customer" }, { idempotencyKey: `inventory-refund-${payment.id}` });
        db.markPaymentRefunded(payment.id);
      });
    }

    if (payment.status === "paid" && payment.kind === "print" && print?.fulfillmentType !== "self" && !payment.printful_order_id) {
      await attempt("Printful", async () => {
        if (!stripe) throw new Error("Stripe is not configured.");
        const session = await stripe.checkout.sessions.retrieve(payment.stripe_session_id, { expand: ["payment_intent.latest_charge"] });
        if (session.payment_status !== "paid") throw new Error("Stripe has not confirmed payment.");
        const charge = session.payment_intent?.latest_charge;
        if (charge?.refunded || Number(charge?.amount_refunded || 0) > 0) {
          db.markPaymentRefunded(payment.id);
          return;
        }
        const result = await printful.createDraftOrderFromStripeSession({ payment, print, stripeSession: session });
        if (!result?.printfulOrderId) throw new Error(result?.reason || "Printful did not return an order ID.");
        db.setPaymentPrintfulOrderId(payment.id, String(result.printfulOrderId));
        logger.log(`[orders] Printful draft saved for order ${payment.id}`);
      });
    }

    payment = db.getPaymentById(paymentId);
    if (sheets.isConfigured() && (!payment.google_sheets_synced_at || payment.sheet_update_needed)) {
      await attempt("Google Sheets", async () => {
        const original = payment.original_id ? db.getOriginalById(payment.original_id) : null;
        if (!await sheets.appendPaidOrder({ payment, print, original })) throw new Error("Sheets did not confirm the update.");
        db.markPaymentGoogleSheetsSynced(payment.id);
        logger.log(`[orders] Sheet updated for order ${payment.id}`);
      });
    }

    if (payment.status === "paid" && !payment.tracking_email_sent_at && (payment.tracking_number || payment.tracking_url)) {
      await attempt("Tracking email", async () => {
        const shipmentKey = crypto.createHash("sha256").update(`${payment.id}:${payment.tracking_number}:${payment.tracking_url}`).digest("hex");
        const result = await email.sendShipmentTrackingEmail({
          to: payment.customer_email, customerName: payment.customer_name,
          productName: print?.title || "your Rayan Rao Art order", carrier: payment.tracking_carrier,
          service: payment.tracking_service, trackingNumber: payment.tracking_number,
          trackingUrl: payment.tracking_url, idempotencyKey: `tracking-${shipmentKey}`
        });
        if (!result?.sent) throw new Error(result?.reason || "Email was not accepted.");
        db.markPaymentTrackingEmailSent(payment.id);
      });
    }
    db.setOrderProcessingResult(paymentId, errors);
    if (errors.length) logger.error(`[orders] order ${paymentId} will retry: ${errors.join("; ")}`);
    return { errors };
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      db.releaseStaleCheckoutReservations();
      if (stripe) {
        for (const payment of db.getPendingCheckoutPayments()) {
          try {
            const session = await stripe.checkout.sessions.retrieve(payment.stripe_session_id);
            if (String(session.metadata?.flow || "").startsWith("art_auction_") || String(session.metadata?.kind || "").includes("auction") || session.metadata?.bidId) continue;
            if (session.payment_status === "paid") db.confirmCheckoutPayment(session);
            else if (session.status === "expired") db.cancelCheckoutReservation(session.id);
          } catch (error) { logger.error(`[checkout cleanup] order ${payment.id}: ${error.message}`); }
        }
      }
      for (const payment of db.getPaymentsNeedingProcessing({ sheetsEnabled: sheets.isConfigured() })) await processPayment(payment.id);
    } finally { ticking = false; }
  }

  return { processPayment, tick };
}

module.exports = { createOrderProcessor };
