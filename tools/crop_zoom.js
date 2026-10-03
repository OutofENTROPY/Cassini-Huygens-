/* crop_zoom.js —— 裁剪并放大两张截图的同一区域，便于目视对比折线。
 * 用法：node crop_zoom.js <in.png> <out.png> [sx sy w h] [scale]
 * 依赖：纯 JS PNG 解码/裁剪用 sharp 不可得 → 用 canvas? 均无。
 * 改用 Playwright 页面做图像裁剪（浏览器 canvas）。
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = 'D:/Programming/HTML/Cassini';

const [inP, outP, sx='0', sy='0', w='0', h='0', scale='1'] = process.argv.slice(2);

(async () => {
  const srv = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    fs.readFile(p, (e, d) => {
      if (e) { res.writeHead(404); return res.end('nf'); }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(d);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const PORT = srv.address().port;
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
  const rel = '/' + path.relative(ROOT, inP).replace(/\\/g, '/');
  const SX=+sx, SY=+sy, W=+w, H=+h, SC=+scale;
  const out = await page.evaluate(async ({ rel, SX, SY, W, H, SC }) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = rel; });
    const c = document.createElement('canvas');
    c.width = Math.round(W * SC); c.height = Math.round(H * SC);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(img, SX, SY, W, H, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }, { rel, SX, SY, W, H, SC });
  fs.writeFileSync(outP, Buffer.from(out.split(',')[1], 'base64'));
  console.log('saved', outP);
  await browser.close(); srv.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
