// Renders app/assets/icon.html (a CD with a glass lyric bar) to icon.png (1024px) and icon.icns for the app bundle.
//   npm run icon
import puppeteer from 'puppeteer';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/assets');
const png = path.join(ASSETS, 'icon.png');

const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 1024, deviceScaleFactor: 1 });
  await page.goto(`file://${path.join(ASSETS, 'icon.html')}`);
  await page.screenshot({ path: png, omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
} finally {
  await browser.close();
}

// macOS wants every size in an .iconset folder, then iconutil packs it.
const set = fs.mkdtempSync(path.join(os.tmpdir(), 'floatlyrics-')) + '/icon.iconset';
fs.mkdirSync(set);
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = size * scale;
    const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
    execFileSync('sips', ['-z', String(px), String(px), png, '--out', path.join(set, name)], { stdio: 'ignore' });
  }
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(ASSETS, 'icon.icns')]);
console.log(`wrote ${png} and ${path.join(ASSETS, 'icon.icns')}`);
