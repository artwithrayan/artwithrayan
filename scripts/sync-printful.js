require("dotenv").config();

const printful = require("../src/printful");
const db = require("../src/db");

async function main() {
  const syncData = await printful.fetchPrintfulProductsForWebsite();
  const results = db.upsertPrintfulPrints(syncData.importedProducts);
  const archived = db.archiveMissingPrintfulPrints(syncData.importedProducts.map((item) => item.printfulSyncVariantId));
  const created = results.filter((item) => item.action === "created").length;
  const updated = results.filter((item) => item.action === "updated").length;

  console.log(`Printful products found: ${syncData.printfulProductCount}`);
  console.log(`Variants imported: ${syncData.importedProducts.length}`);
  console.log(`Created: ${created} · Updated: ${updated}`);
  console.log(`Archived no-longer-synced products: ${archived}`);

  if (syncData.skipped.length) {
    console.log("Skipped:");
    syncData.skipped.forEach((item) => console.log(`- ${item.product || "Unknown product"}: ${item.reason}`));
  }
}

main().catch((error) => {
  console.error(`Printful sync failed: ${error.message}`);
  process.exitCode = 1;
});
