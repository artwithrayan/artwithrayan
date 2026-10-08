# Rayan Rao Art

Original paintings are available by email inquiry, while prints use Stripe Checkout, SQLite order storage, Google Sheets reporting, and shipment tracking emails. Auction, admin, and new original checkout endpoints are disabled. Print Club is coming soon.

## Original Painting Inquiries

Available originals link to artwithrayan@gmail.com with the artwork title, dimensions, and medium prefilled. Prices are omitted from the gallery, inquiry emails, and public original API responses; historical prices remain stored internally. Buyers request pricing and shipping by email. Sold originals remain in the gallery labeled Sold, without an inquiry button or sale price.

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

Printful checkout accepts international destinations using Printful's cached country/state metadata. This address list is not a promise of product availability: each selected variant and destination must return both a shipping rate and a fulfillment estimate before checkout. Canada and Australia require a province/state. Postal codes are required for country formats recognized by the existing Validator library; destinations without postal codes, such as Hong Kong, can leave this blank. International deliveries require a phone number including its country code. Brazilian recipients must provide a valid numeric CPF/CNPJ tax ID, which is stored with the shipping address and forwarded to Printful, not copied into the public catalog. Self-fulfilled prints remain US-only. Originals remain email-only.

Checkout and fulfillment estimates must both be in USD; mixed-currency quotes are rejected rather than silently converted. Shipping uses the fulfillment estimate when available so store shipping settings are reflected. International buyers are warned that customs duties, import taxes, and carrier handling fees may be payable separately. These are not guaranteed to be included in the Printful fulfillment-tax estimate. The existing Stripe fee/profit estimate uses domestic card rates; actual international-card fees can be higher. No product prices or fee markup were changed for international shipping.

International fulfillment estimates and drafts include the customer's actual product price as the USD retail value. Optional mailing-address fields are preserved as entered rather than replaced with values from the Stripe billing address.

The Light and Sun Beam offer a country/state shipping estimator while remaining email-inquiry-only. The server assumes a 4 lb packed parcel from North Carolina, adds a $14 or $16 packing allowance respectively to a regional store allowance ($20-$38), adds a 25% cushion, and rounds upward to $5. These are conservative store estimates, not carrier tariffs or guaranteed shipping prices. Contiguous-US estimates range from $45-$65 for The Light and $45-$70 for Sun Beam. Alaska, Hawaii, and other destinations require an individual email quote. Confirm packed dimensions, destination, and insurance before agreeing on the final amount. Profiles and regional allowances live in src/shipping.js; this estimator does not collect street addresses, create orders, or change Printful shipping.

## Original Auctions

Auctions are opt-in. `config/auctions.json` is intentionally empty; deploying this feature does not start an auction or restore the old auction/admin endpoints. Ordinary originals stay email-inquiry-only. A configuration entry has `id` (unique lowercase slug), `originalId`, `startingPrice` in USD, `startsAt`, and `endsAt` as ISO dates with explicit UTC offsets. Supply the starting minimum and closing time before adding an entry. Only The Light and Sun Beam currently have the supported shipping profiles. Existing database auctions are never reset or repriced by a deployment or by removing their configuration entry.

The opening price is also the minimum selling price, with no hidden reserve. Bidders verify email, review a private maximum bid plus fixed destination-based shipping, explicitly authorize the maximum total, and save a card through Stripe Checkout setup mode before their first bid is accepted. Subsequent increases need fresh explicit authorization. A bidder's shipping address and charge are locked after their first accepted bid. The actual charge is the winning bid plus accepted shipping, never the losing bidder's maximum or an extra processing fee. The 4 lb NC shipping allowances are store charges, not carrier quotes; the store bears any difference in postage/insurance. Auction totals do not add tax at settlement: review your tax obligations and account for any seller-remitted tax within the advertised amounts before activation.

Automatic maximum bidding uses $5/$10/$25/$50 increments at $100/$500/$1,000 thresholds. Tied maximums favor the earlier accepted maximum. Competing last-minute bids extend the closing time to two minutes after receipt. The persistent worker checks every 15 seconds and resumes on startup. Keep the service always on and `DB_PATH` on the persistent disk. Back up the database, which now contains bid authorizations, shipping addresses, private maxima, and payment references. Full card numbers and CVC are held by Stripe, not this application.

The worker records one winner, creates a Stripe PaymentIntent without charging, saves its ID, then confirms it off-session. Network ambiguity is reconciled using that same intent. An unknown creation outcome older than 23 hours goes to manual review rather than risking a second intent after Stripe's idempotency window. If the bank declines or requests verification, the original intent is cancelled before a separate card-only Checkout recovery link is offered. Winners get up to 24 hours to pay; unpaid auctions remain held for review. Runners-up are never charged automatically. Paid originals enter the existing Google Sheets queue and remain self-fulfilled, never Printful orders. Auction emails have a persisted retry queue.

Before enabling a real auction:

- Set `BASE_URL` to the exact canonical HTTPS site origin and use it consistently; alternate domains should redirect there. The auction API rejects cross-origin writes.
- Verify Stripe, `STRIPE_WEBHOOK_SECRET`, Resend, and `FROM_EMAIL` in the intended test/live mode. Registration is disabled if required integrations are unconfigured. Readiness checks detect configuration, not actual account permissions or email deliverability.
- On the existing Stripe event destination, include `checkout.session.completed`, `checkout.session.expired`, `payment_intent.succeeded`, and `payment_intent.payment_failed`, keeping the site's other enabled checkout events. Do not change the webhook URL or secret simply for this feature.
- Run a real Stripe **test-mode** walkthrough, including a declined card and an authentication-required card, with test email delivery. Automated tests use mocked providers; they do not verify your live Stripe account, Resend domain, or webhook subscriptions.
- Review the published auction rules and tax/shipping arrangements before accepting real bids. This implementation does not resolve legal or tax obligations for you.

Owner controls require server shell access, not a public admin page:

```powershell
npm run auctions -- status
npm run auctions -- cancel AUCTION_ID --reason "Reason to send to bidders"
```

Run these against the correct database (Render Shell for deployed auctions). Cancellation is only allowed before payment processing starts and emails accepted bidders. Removing an entry from the configuration is NOT cancellation. Payment-stage issues and relisting need review, not editing prices or deleting bid records. Owner emails default to `artwithrayan@gmail.com`; `AUCTION_OWNER_EMAIL` can override this. The owner is notified of successful payments, payment problems, unsold auctions, and manual-review cases.

`tests/auctions.test.js` covers winner-only charging, consent, bid races, deadlines, shipping locks, late setup, duplicates, failure recovery, and cleanup isolation. `tests/check-auction-browser.cjs` checks the real local HTTP flow against mocked providers at desktop and mobile widths. No real cards are charged by these tests.

`npm run preview:auctions` starts a loopback-only, temporary-database demo at `http://localhost:3115/auction.html?id=light-demo`. All providers are mocked, the email code is `123456`, and the card step is simulated. Never deploy this test helper or use it to take real bids. It does not run settlement or change the store database/configuration.

For a real Stripe **test-mode** walkthrough, run `npm run test:auctions:stripe` and open `http://localhost:3116/test-control`. Requires Stripe CLI on PATH (or `STRIPE_CLI_PATH`), a local `sk_test_` key, and the local Resend key. This runner uses `shipping@artwithrayan.com` as its sender (override with `AUCTION_TEST_FROM_EMAIL` if needed), without editing `.env`. Emails are limited to `artwithrayan@gmail.com` and its plus aliases and clearly labeled as tests. Use actual email verification codes and Stripe's `4242 4242 4242 4242` test card with a future expiry and any three-digit CVC; never use a real card.

Each run creates a fresh temporary SQLite database, disables Printful and Google Sheets, ignores production auction configuration, and starts its own test-only Stripe listener with an in-memory signing secret. Live keys and live webhook events are rejected. The control page can close only this local test auction and process its test payment. Stop with Ctrl+C. Nothing is deployed or pushed; this helper must never be used as the production start command. Test-mode Stripe objects and emails to your own inbox are real external test artifacts; email acceptance does not prove inbox delivery. Restarting creates a different test auction and database.

## Images And Tests

Responsive WebP assets are checked in, with content-hashed filenames and long cache lifetimes. Source photographs are preserved. Gallery images load lazily; the homepage image uses higher loading priority. To regenerate after replacing source images, install or provide Sharp to scripts/optimize-images.cjs (IMAGE_TOOLS_MODULES can point to the bundled Node modules directory).

npm test runs isolated synthetic-database and mocked-provider regression tests. It does not create real payments, fulfillment orders, or customer emails. tests/check-browser.cjs additionally verifies desktop/mobile pages and changing quotes with bundled Playwright.

Export orders:

```powershell
npm run export:orders
```

Before deploying, run tests and npm audit, back up the production database, deploy, confirm the required environment variables, and verify one end-to-end test order and tracking email. Do not run production load tests without limits.

## Secret Safety

Keep production credentials in Render environment variables or secret files, never in public assets or Git. Keep local credentials in the ignored .env file. Never attach that file, service-account JSON, private keys, or complete webhook URLs to screenshots or chats. Application logs redact configured secrets and common token formats; SDK error request objects are omitted. This is defense in depth, not a guarantee against every possible disclosure.

Run `npm run security:secrets` before committing and `npm run security:history` to scan all locally available Git refs. Reports contain filenames and credential types, not secret values. The checker compares against configured local secrets and known patterns; it cannot recognize every arbitrary token. The GitHub workflow runs the working-tree check and the production dependency audit on pushes and pull requests. It does not itself stop Render auto-deploys: configure Render to wait for CI checks, and enable GitHub secret scanning/push protection where available.

Use MFA/passkeys and unique passwords for GitHub, Render, Stripe, Printful, Resend, and Google. Restrict collaborators and API permissions to what the integrations need; use a Resend sending-only key and share only the order spreadsheet with the Google service account. Do not change Stripe/Printful scopes without testing the checkout, fulfillment, refund, sync, and tracking operations they support.

Treat any credential pasted into a chat, public repository, or shared log as exposed. Rotate it at its provider, update Render and the local environment, verify the integration, then revoke the old credential. For Printful webhook-token rotation, update both PRINTFUL_WEBHOOK_SECRET and the token in the webhook destination URL together; re-register the destination and verify shipment delivery. Do not assume redaction removes historical logs or copies, and do not rewrite Git history or revoke production credentials without coordinating the deployment.
