/* shot_launch.js —— 按用户截图取景：发射历元 + 全部轨迹 + 未来轨迹开启。
 * 用法：node shot_launch.js [UTC] [camDist] [outPng]
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

  const utc = process.argv[2] || '1997-10-15T09:26:22Z';
  const camDist = parseFloat(process.argv[3] || '4.0e5');
  const out = process.argv[4] || 'D:/Programming/HTML/Cassini/tools/shots/launch_cur.png';

  // 关欢迎层
  await page.evaluate(() => {
    const c = document.getElementById('help-close'); if (c) c.click();
    const ov = document.querySelector('.overlay, #help, .welcome');
    if (ov) ov.style.display = 'none';
  });
  await page.waitForTimeout(600);

  // 直接设 scene 选项：全部轨迹 + 未来开启
  await page.evaluate(() => {
    const S = window.CassiniScene;
    S.setTrailOptions({ mode: 'all', future: true, cassini: true, huygens: true, planetOrbits: true });
    // UI 同步高亮
    document.getElementById('trail-all')?.classList.add('on');
    document.getElementById('trail-recent')?.classList.remove('on');
    const f = document.getElementById('trail-future');
    f?.classList.add('on'); f?.setAttribute('aria-checked', 'true');
  });

  await page.evaluate(({ utcStr, camDist }) => {
    const C = window.CassiniCamera, T = window.CassiniTimeline;
    const t = (Date.parse(utcStr) - 946728000000) / 1000;
    T.setNow(t); T.setPlaying(false);
    C.focus('cassini', { dist: camDist, animate: false });
  }, { utcStr: utc, camDist });

  await page.waitForTimeout(3000);
  await page.screenshot({ path: out });

  const st = await page.evaluate(() => {
    const S = window.CassiniScene;
    return {
      flown: S.trailFlownLine.visible, full: S.trailFullLine.visible,
      tailAbs: S.tailAbs.visible,
      flownRange: JSON.stringify(S.trailFlownLine.geometry.drawRange),
      fullRange: JSON.stringify(S.trailFullLine.geometry.drawRange),
    };
  });
  console.log('state:', JSON.stringify(st));
  console.log('saved:', out);
  await browser.close();
  srv.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
