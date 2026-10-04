/* probe_marker_px.js —— 实测 Cassini / Huygens 标记亮点的屏占像素对比。
 * 用法：node probe_marker_px.js [UTC] [outPngPrefix]
 * 对若干相机距离分别截图，并从场景直接读取两个 sprite 的世界尺度换算屏占 px。
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = 'D:/Programming/HTML/Cassini';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.json': 'application/json' };

(async () => {
  const srv = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    fs.readFile(p, (e, d) => {
      if (e) { res.writeHead(404); return res.end('nf'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
      res.end(d);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const PORT = srv.address().port;

  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--disable-gpu-sandbox', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(12000);

  await page.evaluate(() => {
    const c = document.getElementById('help-close'); if (c) c.click();
    const ov = document.querySelector('.overlay, #help, .welcome');
    if (ov) ov.style.display = 'none';
  });
  await page.waitForTimeout(600);

  const utc = process.argv[2] || '2005-01-14T10:00:00Z';
  const prefix = process.argv[3] || 'D:/Programming/HTML/Cassini/tools/shots/markerpx';

  await page.evaluate(() => {
    const S = window.CassiniScene;
    S.setTrailOptions({ mode: 'all', future: true, cassini: true, huygens: true, planetOrbits: true });
  });

  await page.evaluate(({ utcStr }) => {
    const C = window.CassiniCamera, T = window.CassiniTimeline;
    const t = (Date.parse(utcStr) - 946728000000) / 1000;
    T.setNow(t); T.setPlaying(false);
  }, { utcStr: utc });

  const dists = [3e4, 1e5, 3e5, 1e6, 3e6, 1.2e9];
  for (const dist of dists) {
    await page.evaluate((d) => {
      window.CassiniCamera.focus('titan', { dist: d, animate: false });
    }, dist);
    await page.waitForTimeout(2500);
    const info = await page.evaluate(() => {
      const S = window.CassiniScene;
      const cam = S.camera;
      const hPx = cam.getRenderTarget ? window.innerHeight : window.innerHeight;
      const halfTan = Math.tan(cam.fov * Math.PI / 360);
      const sprites = [];
      S.scene.traverse((o) => {
        if (o.isSprite && o.visible) {
          const d = o.position.length();
          // Sprite sizeAttenuation：屏占 px ≈ scale·hPx / (2·tan(fov/2)·dist)
          const px = o.scale.x * hPx / (2 * halfTan * Math.max(d, 1e-9));
          sprites.push({
            px: +px.toFixed(2),
            distKm: +d.toExponential(3),
            scaleKm: +o.scale.x.toExponential(3),
            opacity: +o.material.opacity.toFixed(3),
            renderOrder: o.renderOrder,
          });
        }
      });
      return sprites;
    });
    console.log(`dist=${dist.toExponential(1)}`, JSON.stringify(info));
    await page.screenshot({ path: `${prefix}_${dist.toExponential(0)}.png` });
  }

  console.log('done');
  await browser.close();
  srv.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
