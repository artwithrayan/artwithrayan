const { logger } = require("../src/security");
require("dotenv").config();

const printful = require("../src/printful");
const db = require("../src/db");

async function main() {
  const syncData = await printful.fetchPrintfulProductsForWebsite();
  const results = db.upsertPrintfulPrints(syncData.importedProducts);
  const archived = syncData.complete ? db.archiveMissingPrintfulPrints(syncData.importedProducts.map((item) => item.printfulSyncVariantId)) : 0;
  if (!syncData.complete) logger.warn("Catalog fetch was incomplete; existing listings were preserved.");
  const created = results.filter((item) => item.action === "created").length;
  const updated = results.filter((item) => item.action === "updated").length;

  logger.log(`Printful products found: ${syncData.printfulProductCount}`);
  logger.log(`Variants imported: ${syncData.importedProducts.length}`);
  logger.log(`Created: ${created} · Updated: ${updated}`);
  logger.log(`Archived no-longer-synced products: ${archived}`);

  if (syncData.skipped.length) {
    logger.log("Skipped:");
    syncData.skipped.forEach((item) => logger.log(`- ${item.product || "Unknown product"}: ${item.reason}`));
  }
}

main().catch((error) => {
  logger.error(`Printful sync failed: ${error.message}`);
  process.exitCode = 1;
});
