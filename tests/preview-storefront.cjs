// Isolated preview: public catalog only; payment providers and order data are test fixtures.
const express = require("express");
const f = require("./fixture.cjs");

async function main() {
  const response = await fetch("https://artwithrayan.com/api/prints");
  if (!response.ok) throw new Error("Could not load the public print catalog.");
  const catalog = await response.json();
  const app = express();
  app.get("/api/prints", (req, res) => res.json(catalog));
  app.post("/api/prints/:id/checkout", (req, res) => res.status(403).json({ error: "Purchases are disabled in this local visual preview." }));
  app.use(f.app);
  const server = app.listen(Number(process.env.PREVIEW_PORT || 3118), "127.0.0.1");
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") server.listen(0, "127.0.0.1");
    else throw error;
  });
  server.on("listening", () => console.log("Visual preview: http://localhost:" + server.address().port));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
