import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1872, height: 954 } });

const logs = [];
const errors = [];
page.on('console', (msg) => logs.push(`${msg.type()}: ${msg.text()}`));
page.on('pageerror', (err) => errors.push(err.stack || err.message));

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.fill('#address-input', 'tour eiffel');
await page.click('#search-btn');
await page.waitForTimeout(15000);

await page.screenshot({ path: '.codex-logs/tour-eiffel.png', fullPage: true });

const sample = await page.evaluate(() => {
  const canvas = document.querySelector('#game-canvas');
  const tmp = document.createElement('canvas');
  tmp.width = canvas.width;
  tmp.height = canvas.height;
  const ctx = tmp.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0);
  const image = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
  let black = 0;
  let skyLike = 0;
  let bright = 0;
  const step = 16;
  for (let y = 0; y < tmp.height; y += step) {
    for (let x = 0; x < tmp.width; x += step) {
      const i = (y * tmp.width + x) * 4;
      const r = image[i], g = image[i + 1], b = image[i + 2];
      if (r < 8 && g < 8 && b < 8) black++;
      if ((r > 120 && g > 80 && b > 70) || (r > 90 && b > 100)) skyLike++;
      if (r + g + b > 450) bright++;
    }
  }
  return {
    size: [tmp.width, tmp.height],
    black,
    skyLike,
    bright,
    ratioBlack: black / Math.ceil(tmp.width / step) / Math.ceil(tmp.height / step)
  };
});

console.log(JSON.stringify({ logs, errors, sample }, null, 2));
await browser.close();
