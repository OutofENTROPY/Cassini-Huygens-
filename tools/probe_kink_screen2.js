/* probe_kink_screen2.js —— 直接定位 i=432/433（折线处）在屏幕上的位置与折角。
 * 用法：node probe_kink_screen2.js [UTC] [camDist]
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
  page.on('console', (m) => { const t = m.text(); if (t.includes('[trail]')) console.log('  ' + t); });
  await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(12000);

  const utc = process.argv[2] || '1997-10-15T09:26:22Z';
  const camDist = parseFloat(process.argv[3] || '4e5');

  await page.evaluate(() => {
    const c = document.getElementById('help-close'); if (c) c.click();
    const ov = document.querySelector('.overlay, #help, .welcome'); if (ov) ov.style.display = 'none';
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.CassiniScene.setTrailOptions({ mode: 'all', future: true, cassini: true, huygens: true, planetOrbits: true });
  });
  await page.evaluate((args) => {
    const C = window.CassiniCamera, T = window.CassiniTimeline;
    T.setNow((Date.parse(args.u) - 946728000000) / 1000);
    T.setPlaying(false);
    C.focus('cassini', { dist: args.d, animate: false });
  }, { u: utc, d: camDist });
  await page.waitForTimeout(3000);

  const r = await page.evaluate(() => {
    const S = window.CassiniScene, o = S.trailOrigin;
    const pos = S.trailFullLine.geometry.getAttribute('position');
    const N = S.trailLength;
    const W = window.innerWidth, H = window.innerHeight;
    function scr(i) {
      const x = pos.array[i*3] + o.x, y = pos.array[i*3+1] + o.y, z = pos.array[i*3+2] + o.z;
      const q = S.screenPosOf([x, y, z]);
      return (q && !q.behind) ? [q.x, q.y] : null;
    }
    function pt(i) {
      const a = scr(i-1), b = scr(i), c = scr(i+1);
      if (!a || !b || !c) return null;
      const ax = b[0]-a[0], ay = b[1]-a[1], bx = c[0]-b[0], by = c[1]-b[1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la < 1e-9 || lb < 1e-9) return null;
      const cs = Math.max(-1, Math.min(1, (ax*bx+ay*by)/(la*lb)));
      return { i: i, deg: Math.acos(cs)*180/Math.PI, la: la, lb: lb, sx: b[0], sy: b[1],
               onScreen: b[0] >= 0 && b[0] <= W && b[1] >= 0 && b[1] <= H };
    }
    const out = {};
    [200, 400, 425, 430, 432, 433, 434, 436, 440, 500, 1000, 2000, 3570, 4000, 10000].forEach((i) => { out[i] = pt(i); });
    let mx = 0, mi = -1, mv = null;
    for (let i = 2; i < N - 2; i++) {
      const t = pt(i);
      if (!t || !t.onScreen) continue;
      if (t.la < 0.05 || t.lb < 0.05) continue;
      if (t.deg > mx) { mx = t.deg; mi = i; mv = t; }
    }
    // 屏内最大折角（双弦 >= 0.3px，更接近肉眼可见）
    let mx2 = 0, mi2 = -1, mv2 = null;
    for (let i = 2; i < N - 2; i++) {
      const t = pt(i);
      if (!t || !t.onScreen) continue;
      if (t.la < 0.3 || t.lb < 0.3) continue;
      if (t.deg > mx2) { mx2 = t.deg; mi2 = i; mv2 = t; }
    }
    return { out: out, mx: mx, mi: mi, mv: mv, mx2: mx2, mi2: mi2, mv2: mv2, N: N, W: W, H: H };
  });

  console.log('N=' + r.N + ' viewport ' + r.W + 'x' + r.H + ' camDist=' + camDist);
  console.log('--- 指定顶点屏幕折角 ---');
  Object.keys(r.out).forEach((k) => {
    const v = r.out[k];
    if (!v) { console.log('  i=' + k + ' (off-screen)'); return; }
    console.log('  i=' + k + ' deg=' + v.deg.toFixed(2) + ' chord=' + v.la.toFixed(3) + '/' + v.lb.toFixed(3)
      + ' px screen=(' + v.sx.toFixed(0) + ',' + v.sy.toFixed(0) + ')' + (v.onScreen ? '' : ' [off]'));
  });
  console.log('--- 屏内最大折角（弦>=0.05px） ---');
  console.log('  i=' + r.mi + ' deg=' + (r.mv ? r.mv.deg.toFixed(2) : '-') + ' chord='
    + (r.mv ? r.mv.la.toFixed(3) + '/' + r.mv.lb.toFixed(3) : '-') + ' px');
  console.log('--- 屏内最大折角（弦>=0.3px，肉眼可见） ---');
  console.log('  i=' + r.mi2 + ' deg=' + (r.mv2 ? r.mv2.deg.toFixed(2) : '-') + ' chord='
    + (r.mv2 ? r.mv2.la.toFixed(3) + '/' + r.mv2.lb.toFixed(3) : '-') + ' px');

  await browser.close(); srv.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
