const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const FROM_EMAIL = process.env.FROM_EMAIL || "Rayan Rao Art <onboarding@resend.dev>";
const ARTIST_EMAIL = process.env.ARTIST_EMAIL || "";

function isEmailEnabled() {
  return Boolean(resend);
}

async function sendEmail({ to, subject, html }) {
  if (!resend) {
    console.log("[email skipped] RESEND_API_KEY is not configured.", { to, subject });
    return { skipped: true, reason: "RESEND_API_KEY is not configured." };
  }

  if (!to) {
    console.log("[email skipped] Missing recipient.", { subject });
    return { skipped: true, reason: "Missing recipient." };
  }

  try {
    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject,
      html
    });

    console.log("[email sent]", { to, subject, id: result?.data?.id || result?.id || null });
    return { sent: true, result };
  } catch (error) {
    console.error("[email failed]", {
      to,
      subject,
      message: error?.message || String(error),
      statusCode: error?.statusCode || error?.status || null
    });

    // Email failure should not undo a successful Stripe charge.
    return {
      failed: true,
      reason: error?.message || String(error),
      statusCode: error?.statusCode || error?.status || null
    };
  }
}

async function sendWinnerPaymentEmail({ to, bidderName, original, amount, checkoutUrl, shippingEstimate = null, subtotalAmount = null }) {
  const shippingHtml = shippingEstimate ? `
    <p><strong>Winning bid:</strong> $${subtotalAmount}</p>
    <p><strong>Estimated shipping/packaging:</strong> $${shippingEstimate.total}</p>
    <p><strong>Total due:</strong> $${amount}</p>
  ` : `<p><strong>Total due:</strong> $${amount}</p>`;

  return sendEmail({
    to,
    subject: `You won the auction for ${original.title}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111;">
        <h1 style="font-weight:500;">You won the auction</h1>
        <p>Hi ${bidderName},</p>
        <p>You are the winning bidder for <strong>${original.title}</strong>.</p>
        ${shippingHtml}
        <p>Please complete payment using the secure Stripe Checkout link below:</p>
        <p><a href="${checkoutUrl}" style="display:inline-block;background:#111;color:#fff;padding:12px 18px;text-decoration:none;">Pay securely</a></p>
        <p>${checkoutUrl}</p>
        <p>Thank you,<br>Rayan Rao Art</p>
      </div>
    `
  });
}

async function sendBidderApprovedEmail({ to, bidderName }) {
  return sendEmail({
    to,
    subject: "You are registered to bid",
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111;">
        <h1 style="font-weight:500;">You are registered to bid</h1>
        <p>Hi ${bidderName},</p>
        <p>Your bidder registration is complete. Your saved Stripe payment method will be charged automatically if you are the winning bidder when an auction closes.</p>
        <p>Before bidding, each artwork page shows the estimated shipping and packaging charge that will be added to the winning bid.</p>
        <p>Thank you,<br>Rayan Rao Art</p>
      </div>
    `
  });
}

async function sendAuctionAutoChargeReceiptEmail({ to, bidderName, original, subtotalAmount, shippingEstimate, totalAmount, paymentIntentId }) {
  const breakdownRows = Object.entries(shippingEstimate.breakdown || {})
    .map(([label, value]) => `<tr><td style="padding:4px 0;text-transform:capitalize;">${label.replace(/([A-Z])/g, " $1")}</td><td style="padding:4px 0;text-align:right;">$${value}</td></tr>`)
    .join("");

  return sendEmail({
    to,
    subject: `Receipt for ${original.title}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111;">
        <h1 style="font-weight:500;">Auction payment receipt</h1>
        <p>Hi ${bidderName},</p>
        <p>You were the highest bidder for <strong>${original.title}</strong>. Your saved payment method was automatically charged after the auction ended.</p>
        <table style="border-collapse:collapse;width:100%;max-width:520px;">
          <tr><td style="padding:6px 0;">Winning bid</td><td style="padding:6px 0;text-align:right;">$${subtotalAmount}</td></tr>
          <tr><td style="padding:6px 0;">Shipping & packaging estimate</td><td style="padding:6px 0;text-align:right;">$${shippingEstimate.total}</td></tr>
          <tr><td style="border-top:1px solid #ddd;padding:8px 0;font-weight:700;">Total charged</td><td style="border-top:1px solid #ddd;padding:8px 0;text-align:right;font-weight:700;">$${totalAmount}</td></tr>
        </table>
        <p><strong>Shipping method basis:</strong> ${shippingEstimate.packageType}</p>
        <table style="border-collapse:collapse;width:100%;max-width:520px;margin-top:8px;">${breakdownRows}</table>
        <p style="font-size:12px;color:#666;">${shippingEstimate.note}</p>
        <p>Payment reference: ${paymentIntentId}</p>
        <p>Thank you,<br>Rayan Rao Art</p>
      </div>
    `
  });
}

async function sendAuctionAutoChargeFailedEmail({ to, bidderName, original, reason }) {
  return sendEmail({
    to,
    subject: `Payment issue for ${original.title}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111;">
        <h1 style="font-weight:500;">Payment could not be completed</h1>
        <p>Hi ${bidderName},</p>
        <p>You were the highest bidder for <strong>${original.title}</strong>, but the automatic charge did not complete.</p>
        <p>Reason: ${reason || "The saved payment method could not be charged."}</p>
        <p>Rayan will follow up with next steps.</p>
      </div>
    `
  });
}

async function sendBuyerReceiptEmail({ to, subject, heading, body }) {
  return sendEmail({
    to,
    subject,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111;">
        <h1 style="font-weight:500;">${heading}</h1>
        <p>${body}</p>
        <p>Thank you,<br>Rayan Rao Art</p>
      </div>
    `
  });
}

async function sendArtistNotificationEmail({ subject, body }) {
  if (!ARTIST_EMAIL) {
    console.log("[artist email skipped] ARTIST_EMAIL is not configured.", { subject });
    return { skipped: true, reason: "ARTIST_EMAIL is not configured." };
  }

  return sendEmail({
    to: ARTIST_EMAIL,
    subject,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111;">
        <h1 style="font-weight:500;">Rayan Rao Art notification</h1>
        ${body}
      </div>
    `
  });
}

module.exports = {
  isEmailEnabled,
  sendEmail,
  sendWinnerPaymentEmail,
  sendBidderApprovedEmail,
  sendAuctionAutoChargeReceiptEmail,
  sendAuctionAutoChargeFailedEmail,
  sendBuyerReceiptEmail,
  sendArtistNotificationEmail
};
