const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const sharp = process.env.IMAGE_TOOLS_MODULES
  ? createRequire(path.join(process.env.IMAGE_TOOLS_MODULES, "package.json"))("sharp")
  : require("sharp");

async function main() {
  const publicDir = path.join(__dirname, "..", "public");
  const names = ["aboutme.png", "the-light.jpg", "the-light-reveal.jpg", "the-wading-man.jpg", "flower.jpg", "wine-night.jpg", "dogs-playing-poker-original.jpg"];
  const manifest = {};
  let originalBytes = 0;
  let optimizedBytes = 0;
  for (const name of names) {
    const input = await fs.readFile(path.join(publicDir, "images", name));
    const metadata = await sharp(input).metadata();
    const hash = crypto.createHash("sha256").update(input).digest("hex").slice(0, 12);
    const stem = `${path.parse(name).name}-${hash}`;
    const widths = [480, 960, 1440].filter((width) => width <= metadata.width);
    if (!widths.length || widths.at(-1) < Math.min(metadata.width, 1440)) widths.push(Math.min(metadata.width, 1440));
    const sources = [];
    for (const width of widths) {
      const filename = `${stem}-${width}.webp`;
      const data = await sharp(input).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 82, effort: 6 }).toBuffer();
      await fs.writeFile(path.join(publicDir, "images", filename), data);
      sources.push({ url: `/images/${filename}`, width, bytes: data.length });
    }
    manifest[`/images/${name}`] = { width: metadata.width, height: metadata.height, sources };
    originalBytes += input.length;
    optimizedBytes += sources.at(-1).bytes;
  }
  await fs.writeFile(path.join(publicDir, "image-assets.js"), `window.ART_IMAGE_ASSETS = ${JSON.stringify(manifest)};\n`);
  console.log(JSON.stringify({ originalBytes, optimizedBytes, reductionPercent: Math.round((1 - optimizedBytes / originalBytes) * 100), images: manifest }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
