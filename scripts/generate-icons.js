/**
 * Rasterizes src-tauri/icons/lobbylens_icon.svg into Tauri bundle icon assets.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const iconsDir = join(root, "src-tauri", "icons");
const svgPath = join(iconsDir, "lobbylens_icon.svg");

function logWrote(relPath) {
  console.log(`Wrote ${relPath}`);
}

async function main() {
  mkdirSync(iconsDir, { recursive: true });
  const svgBuf = readFileSync(svgPath);

  const render = (size) =>
    sharp(svgBuf, { density: 300 }).resize(size, size).png();

  const out32 = await render(32).toBuffer();
  writeFileSync(join(iconsDir, "32x32.png"), out32);
  logWrote("src-tauri/icons/32x32.png");

  const out128 = await render(128).toBuffer();
  writeFileSync(join(iconsDir, "128x128.png"), out128);
  logWrote("src-tauri/icons/128x128.png");

  const out256 = await render(256).toBuffer();
  writeFileSync(join(iconsDir, "128x128@2x.png"), out256);
  logWrote("src-tauri/icons/128x128@2x.png");

  const out512 = await render(512).toBuffer();
  writeFileSync(join(iconsDir, "icon.png"), out512);
  logWrote("src-tauri/icons/icon.png");

  const icoBuf = await pngToIco([out256]);
  writeFileSync(join(iconsDir, "icon.ico"), icoBuf);
  logWrote("src-tauri/icons/icon.ico");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
