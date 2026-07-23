# Rayan Rao Art — automatic auction charging version

This version changes the auction flow so bidders must register before bidding, save a payment method through Stripe, and authorize automatic charging if they win.

## What changed

- `/register.html` requires:
  - name
  - email address for receipts
  - shipping address
  - auction terms checkbox
  - automatic winner-charge authorization checkbox
  - Stripe setup-mode payment-method verification
- Bidding requires a registered, approved email.
- When an auction ends, the server checks ended auctions and automatically charges the highest bidder.
- The charge includes:
  - winning bid amount
  - estimated shipping/packaging charge
- Receipt email is sent through Resend after successful automatic charge.
- Admin page shows bidders, shipping estimate, charge status, and a force-charge button for Stripe test mode.

## Run locally

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

## Required `.env`

Copy your existing `.env` into this folder, then make sure it has:

```env
PORT=3000
BASE_URL=http://localhost:3000
ADMIN_SECRET=rayan-test-admin-12345

STRIPE_SECRET_KEY=sk_test_your_key_here
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret_here

RESEND_API_KEY=re_your_key_here
FROM_EMAIL=Rayan Rao Art <onboarding@resend.dev>
ARTIST_EMAIL=raorayan4@gmail.com

PRINTFUL_API_KEY=your_printful_api_key
PRINTFUL_WEBHOOK_SECRET=use_a_long_random_secret
PRINTFUL_WEBHOOK_URL=https://your-render-site.onrender.com/api/printful/webhook?token=use_a_long_random_secret
PRINTFUL_WEBHOOK_ON_STARTUP=false

AUTO_CHARGE_AUCTIONS=true
AUCTION_PROCESS_INTERVAL_MS=60000
```

## Stripe webhook is required

Automatic bidder approval requires the Stripe webhook while testing locally:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Paste the `whsec_...` value into `.env` as `STRIPE_WEBHOOK_SECRET`, restart `npm run dev`, and keep the Stripe CLI terminal running.

## Printful shipment tracking emails

When Printful sends a `package_shipped` event, the server records the carrier, service, tracking number, and tracking URL for the matching paid order, then sends the customer a tracking email through Resend. The shipment webhook is authenticated with the token in `PRINTFUL_WEBHOOK_SECRET`.

For a Render deployment, add the Printful variables above. Set `PRINTFUL_WEBHOOK_ON_STARTUP=true` for one deploy so the server registers the webhook with Printful, confirm the Render logs show `[printful webhook setup] configured`, then change it back to `false` and redeploy. Keep `PRINTFUL_WEBHOOK_URL` and `PRINTFUL_WEBHOOK_SECRET` unchanged after setup.

## How automatic charging works

1. Bidder registers on `/register.html`.
2. Stripe saves a payment method in setup mode.
3. The webhook stores the Stripe payment method ID and approves the bidder.
4. Bidder places bids using the registered email.
5. When the auction end time passes, the Node server checks ended auctions every 60 seconds.
6. The server finds the highest bid.
7. The server calculates shipping/packaging.
8. The server creates and confirms a Stripe PaymentIntent using the saved payment method with `off_session: true`.
9. If payment succeeds, the artwork becomes `sold` and the bidder receives a receipt email.
10. If payment fails or requires authentication, the artwork becomes `auto_charge_failed` and emails are sent.

## Shipping estimate logic

Shipping is estimated in `src/shipping.js` from:

- artwork dimensions parsed from the size string or stored width/height/depth
- estimated artwork weight
- packaging type
- protective materials
- packing labor
- carrier-cost buffer
- oversized/dimensional adjustments

This is not a live USPS/UPS/FedEx quote. It is a predictable internal estimate.

## Testing automatic charging

Use Stripe test card:

```text
4242 4242 4242 4242
```

For a quick test, register a bidder, place a bid, then go to:

```text
http://localhost:3000/admin.html
```

Click:

```text
Force auto-charge winner now
```

Use this only in Stripe test mode.

## Before public launch

You still need:

- real legal auction terms
- privacy policy
- refund/shipping policy
- production database
- deployed HTTPS site
- real domain verified in Resend
- stronger admin protection
- optional bidder deposit
- real carrier-rate integration if you want exact shipping by destination


## Manual auction controls

The admin page now includes direct auction controls:

- **End Bidding Now**: closes bidding immediately and charges the current highest bidder using their saved Stripe payment method. If there are no bids, the auction is marked `ended_no_bids` and no one is charged.
- **Cancel Auction**: closes bidding without charging anyone. The status becomes `cancelled`.
- **Reopen Auction**: changes the status back to `active`. If the original end time is already in the past, the system extends the auction by 7 days automatically.
- **Charge Second-Highest**: fallback option for a failed/non-paying winner. It charges the second-highest bidder using the same bid + estimated shipping/packaging logic.
- **Fallback: Manual Checkout**: creates a Stripe checkout link instead of using the saved payment method.

Use `End Bidding Now` when you want to manually close an auction before the timer. Use `Cancel Auction` if you want bidding to stop but do not want to sell the piece.


## Shipping disclosure and Resend receipt emails

This version makes shipping/packaging visible before a bidder places a bid.

On `originals.html`, each artwork shows:

- Current bid
- Estimated shipping/packaging
- Estimated total if current bid wins
- Live estimated total when the buyer types a new bid
- A confirmation popup before the bid is submitted

When the auction is ended manually or automatically, the winner is charged:

```text
winning bid + displayed estimated shipping/packaging
```

The buyer receipt email includes the winning bid, shipping/packaging estimate, total charged, package type, and a shipping-cost breakdown.

### Resend setup

Add your Resend key to `.env`:

```env
RESEND_API_KEY=re_your_actual_key_here
FROM_EMAIL=Rayan Rao Art <onboarding@resend.dev>
ARTIST_EMAIL=raorayan4@gmail.com
```

Then restart the server:

```bash
npm run dev
```

Open `http://localhost:3000/admin.html`, load the dashboard, and use **Email / Resend Test** before testing buyer receipts.

For production, verify your own domain in Resend and change `FROM_EMAIL` to something like:

```env
FROM_EMAIL=Rayan Rao Art <hello@yourdomain.com>
```

If Resend fails after a successful Stripe charge, the charge is not undone. The server logs the email failure so you can resend/follow up manually.


## Production-readiness iteration: real artwork workflow

This version adds an admin Artwork Manager so originals can be added and edited without changing code.

### Add a real original painting

1. Run the site locally.
2. Open `http://localhost:3000/admin.html`.
3. Enter your `ADMIN_SECRET`.
4. Fill out the Artwork Manager form:
   - title
   - medium
   - size
   - year
   - description
   - image URL
   - starting bid
   - bid increment
   - auction end date/time
   - width/height/depth/weight for shipping estimate
5. Click `Preview Shipping Estimate`.
6. Keep status as `Draft / hidden` until ready.
7. Change status to `Active auction / public` and save.

### Image URLs

For now, paste a public HTTPS image URL. Good options for launch are Cloudinary, S3, or another image host. Do not use private Google Drive links unless you have confirmed the direct image URL loads publicly in an incognito browser.

### Prints

Prints should still be created inside Printful and imported using `Sync Printful Products`.

### New policy pages

Draft pages were added:

- `/terms.html`
- `/privacy.html`
- `/auction-policy.html`
- `/shipping-policy.html`

These are placeholders for launch preparation, not attorney-reviewed legal documents.

### Security improvements in this iteration

- Admin, bidder registration, and bid routes now have basic rate limiting.
- Draft originals are hidden from the public originals page.
- Admin can create, edit, cancel, reopen, end, and archive draft originals.
- Email test section is available in admin.

### Still required before a real public launch

- Move from local SQLite to hosted Postgres.
- Use a real admin login instead of one shared `ADMIN_SECRET`.
- Use verified Resend domain email, not only `onboarding@resend.dev`.
- Use production Stripe keys and production webhook endpoint.
- Host images on Cloudinary/S3 or a similar service.
- Review legal pages before launch.
- Add backups and monitoring.
