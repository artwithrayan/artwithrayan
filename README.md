# Rayan Rao Art

Original paintings are available by email inquiry, while prints use Stripe Checkout, SQLite order storage, Google Sheets reporting, and shipment tracking emails. Auction, admin, and new original checkout endpoints are disabled. Print Club is coming soon.

## Original Painting Inquiries

Available originals link to artwithrayan@gmail.com with the artwork title, dimensions, medium, and listed price prefilled. They show their base prices without a Stripe processing markup. Sold originals remain in the gallery without an inquiry button.

Original shipping and payment are arranged directly with the buyer. Email inquiries do not reserve artwork, create a payment, or add an order to Google Sheets. Record completed direct sales and update the artwork's sold status separately. Old original checkout and shipping-rate URLs return HTTP 410, but webhook processing and order recovery remain available for existing payments.

## Local Development

```powershell
npm ci
npm test
npm run dev
```

Open http://localhost:3000. Use Stripe test credentials locally. Do not copy live credentials into test fixtures.

## Production Configuration

Set these on the Render service, not in Git:

```env
BASE_URL=https://artwithrayan.com
DB_PATH=/var/data/data.sqlite
STRIPE_SECRET_KEY=your_live_stripe_key
STRIPE_WEBHOOK_SECRET=your_production_endpoint_signing_secret
PRINTFUL_API_KEY=your_printful_token
PRINTFUL_AUTO_CREATE_DRAFT_ORDER=true
PRINTFUL_SYNC_ON_STARTUP=true
PRINTFUL_SYNC_INTERVAL_MS=900000
PRINTFUL_WEBHOOK_SECRET=your_existing_random_secret
PRINTFUL_WEBHOOK_URL=https://artwithrayan.com/api/printful/webhook?token=your_existing_random_secret
PRINTFUL_WEBHOOK_ON_STARTUP=false
PRINT_CLUB_ENABLED=false
RESEND_API_KEY=your_resend_key
FROM_EMAIL=Rayan Rao Art <shipping@artwithrayan.com>
GOOGLE_SHEETS_SPREADSHEET_ID=your_sheet_id
GOOGLE_SHEETS_RANGE=Sheet1!A:AC
GOOGLE_SERVICE_ACCOUNT_EMAIL=your_service_account_email
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=your_service_account_private_key
```

Attach a persistent disk at /var/data. The database, retry state, reservations, shipping addresses, and order records must survive deploys. Keep SQLite backups; Google Sheets is an order report, not a complete database backup.

### Resend Setup Still Requires Dashboard And DNS Changes

1. Add artwithrayan.com (or a sending subdomain) in Resend.
2. Add the DNS records Resend provides in Namecheap and wait for verification.
3. Set FROM_EMAIL on Render to an address on that verified domain.
4. Send a test shipment email to an address other than the Resend account owner's email.

The address above is an example only; it does not automatically verify the domain or create a mailbox. The code refuses onboarding@resend.dev for customer tracking, retains unsuccessful sends, and retries them. Changing source code cannot complete DNS verification. /api/health reports trackingEmailReady for basic sender/key configuration; successful delivery still needs verification with Resend.

## Webhooks

Stripe destination URL:

```text
https://artwithrayan.com/api/stripe/webhook
```

Subscribe to checkout.session.completed and checkout.session.expired. For older delayed-payment sessions, also subscribe to checkout.session.async_payment_succeeded and checkout.session.async_payment_failed. New print checkouts use card payments only, including supported card wallets. Never acknowledge an unpaid checkout as paid. Webhooks fail closed if the signing secret is missing.

Local testing:

```powershell
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Use the CLI's signing secret locally, not on Render. The deployed endpoint uses its own destination signing secret.

Printful sends package_shipped to /api/printful/webhook with the configured token. Set PRINTFUL_WEBHOOK_ON_STARTUP=true for one setup deploy, then false. Existing secrets do not need to change for these code fixes. Do not publish keys, tokens, or full token-bearing webhook URLs.

## Order Recovery

Paid orders are saved before integrations run. A worker checks persisted pending work every minute and on startup. Printful, Sheets, and tracking attempts are independent; failures back off from 30 seconds to a maximum of one hour and remain recorded in the database.

- Printful looks up the stable external order ID before creating a draft and recovers accepted requests whose responses were lost.
- Stripe refund state is checked before replaying unfulfilled historical orders. Refunded orders are not sent to Printful.
- Google Sheets checks for the order ID before every append, including after a lost response. Customer strings use RAW mode; money is numeric with cents preserved.
- Tracking uses a stable shipment-specific email idempotency key. Rejected emails are not marked sent.
- Expiration only cancels a pending checkout's own reservation. Cleanup verifies real Stripe session status before releasing it.
- A late payment conflicting with another reservation is queued for an idempotent refund rather than selling the original twice.

Printful orders remain drafts: these changes do not automatically confirm production or charge your Printful wallet. Monitor the service logs for [orders] retry failures and review your Printful drafts. Refunding in Stripe does not cancel an existing Printful order or automatically relist an original; do those separately when appropriate.

Historical totals rounded by older versions are not recoverable from the database alone. Reconcile those records with Stripe before relying on past profit figures. Estimated profit is not accounting profit: actual postage, materials, labor, original production costs, refunds, and actual Stripe fees may differ.

## Catalog And Shipping

With a Printful key configured, the server refreshes products every 15 minutes by default. Set PRINTFUL_SYNC_INTERVAL_MS=0 to disable periodic refresh. Failed partial imports never archive existing listings. A completed refresh archives missing variants. Initial import can be enabled with PRINTFUL_SYNC_ON_STARTUP=true.

Manual import:

```powershell
npm run sync:printful
```

Printful shipping/tax is estimated from its API for the selected variant and address. Self-fulfilled print products use the internal dimension/weight/packaging estimate in src/shipping.js, not a live UPS rate. Original shipping is arranged by email before payment. Changing a print variant or address invalidates the quote. If the total changes before checkout, the buyer must request a new quote.

## Images And Tests

Responsive WebP assets are checked in, with content-hashed filenames and long cache lifetimes. Source photographs are preserved. Gallery images load lazily; the homepage image uses higher loading priority. To regenerate after replacing source images, install or provide Sharp to scripts/optimize-images.cjs (IMAGE_TOOLS_MODULES can point to the bundled Node modules directory).

npm test runs isolated synthetic-database and mocked-provider regression tests. It does not create real payments, fulfillment orders, or customer emails. tests/check-browser.cjs additionally verifies desktop/mobile pages and changing quotes with bundled Playwright.

Export orders:

```powershell
npm run export:orders
```

Before deploying, run tests and npm audit, back up the production database, deploy, confirm the required environment variables, and verify one end-to-end test order and tracking email. Do not run production load tests without limits.
