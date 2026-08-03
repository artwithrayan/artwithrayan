const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const FROM_EMAIL = process.env.FROM_EMAIL || "Rayan Rao Art <onboarding@resend.dev>";

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

async function sendShipmentTrackingEmail({ to, customerName, productName, carrier, service, trackingNumber, trackingUrl }) {
  const trackingLink = trackingUrl ? `<p><a href="${trackingUrl}" style="display:inline-block;background:#111;color:#fff;padding:12px 18px;text-decoration:none;">Track shipment</a></p><p>${trackingUrl}</p>` : "";
  return sendEmail({
    to,
    subject: `Your ${productName} has shipped`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111;">
        <h1 style="font-weight:500;">Your order has shipped</h1>
        <p>Hi ${customerName || "there"},</p>
        <p>Your order for <strong>${productName}</strong> has shipped.</p>
        <p><strong>Carrier:</strong> ${carrier || "Printful carrier"}</p>
        <p><strong>Service:</strong> ${service || "Standard shipping"}</p>
        <p><strong>Tracking number:</strong> ${trackingNumber || "Available through the tracking link"}</p>
        ${trackingLink}
        <p>Thank you,<br>Rayan Rao Art</p>
      </div>
    `
  });
}

module.exports = {
  isEmailEnabled,
  sendShipmentTrackingEmail
};
