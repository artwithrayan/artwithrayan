require("dotenv").config({ quiet: true });
const { parseArgs } = require("node:util");
const db = require("../src/db");
const { createAuctionService } = require("../src/auctions");
const { logger } = require("../src/security");
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { reason: { type: "string" } } });
  const service = createAuctionService({ db, stripe: null, email: { isEmailEnabled: () => false }, baseUrl: process.env.BASE_URL || "http://localhost:3000" });
  if (positionals[0] === "cancel" && positionals[1]) {
    service.cancel(positionals[1], values.reason);
    console.log("Auction cancelled. The running website worker will email affected bidders; no cards will be charged.");
  } else if (!positionals.length || positionals[0] === "status") {
    console.table(service.list().map((a) => ({ id: a.id, artwork: a.title, status: a.status, currentUSD: a.currentCents / 100, bids: a.bidCount, closesUTC: new Date(a.endsAt).toISOString() })));
  } else throw new Error('Usage: npm run auctions -- status | cancel AUCTION_ID --reason "Reason for bidders"');
} catch (error) { logger.error(error.message); process.exitCode = 1; }
finally { db.sqlite.close(); }
