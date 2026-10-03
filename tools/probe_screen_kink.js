/* probe_screen_kink.js —— 浏览器内实测：把主轨迹顶点投影到屏幕，检查「折线」
 * 在屏幕空间是否仍存在。用真实 scene.js 运行时（含 smoothTrailNoise +
 * collapseMicroSteps）与真实相机。
 * 用法：node probe_screen_kink.js [UTC] [camDist]
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
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(12000);

  const utc = process.argv[2] || '1997-10-15T09:26:22Z';
  const camDist = parseFloat(process.argv[3] || '1.2e5');

  await page.evaluate(() => {
    const c = document.getElementById('help-close'); if (c) c.click();
    const ov = document.querySelector('.overlay, #help, .welcome'); if (ov) ov.style.display = 'none';
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const S = window.CassiniScene;
    S.setTrailOptions({ mode: 'all', future: true, cassini: true, huygens: true, planetOrbits: true });
  });
  await page.evaluate(({ utcStr, camDist }) => {
    const C = window.CassiniCamera, T = window.CassiniTimeline;
    const t = (Date.parse(utcStr) - 946728000000) / 1000;
    T.setNow(t); T.setPlaying(false);
    C.focus('cassini', { dist: camDist, animate: false });
  }, { utcStr: utc, camDist });
  await page.waitForTimeout(3000);

  const res = await page.evaluate(() => {
    const S = window.CassiniScene;
    const line = S.trailFullLine;
    const pos = line.geometry.getAttribute('position');
    const N = S.trailLength;
    // 世界坐标 = 缓冲 + origin
    const o = S.trailOrigin;
    const cam = S.camWorld;
    // 复刻投影
    const cam3 = window.CassiniCamera;
    // 直接调用暴露的 screenPosOf（world 坐标）
    const pts = [];
    const step = 1;
    for (let i = 0; i < N; i += step) {
      const x = pos.array[i * 3] + o.x;
      const y = pos.array[i * 3 + 1] + o.y;
      const z = pos.array[i * 3 + 2] + o.z;
      pts.push([x, y, z]);
    }
    // 屏幕投影：用 scene 暴露的接口；若无则手工投影
    let scr = null;
    if (S.screenPosOf) {
      scr = pts.map((p) => { const q = S.screenPosOf([p[0], p[1], p[2]]); return q ? [q.x, q.y, q.behind] : null; });
    }
    return { N, hasScreen: !!scr, origin: [o.x, o.y, o.z],
      sample: pts.slice(0, 3), scrSample: scr ? scr.slice(0, 3) : null };
  });
  console.log('trailN =', res.N, ' hasScreenPosOf =', res.hasScreen);
  console.log('origin =', res.origin.map((v) => v.toExponential(3)).join(', '));

  if (res.hasScreen) {
    // 重新取全量屏幕坐标并算屏幕折角
    const ang = await page.evaluate(() => {
      const S = window.CassiniScene;
      const line = S.trailFullLine;
      const pos = line.geometry.getAttribute('position');
      const N = S.trailLength, o = S.trailOrigin;
      const scr = new Array(N);
      for (let i = 0; i < N; i++) {
        const x = pos.array[i*3] + o.x, y = pos.array[i*3+1] + o.y, z = pos.array[i*3+2] + o.z;
        const q = S.screenPosOf([x, y, z]);
        scr[i] = q && !q.behind ? [q.x, q.y] : null;
      }
      const W = window.innerWidth, H = window.innerHeight;
      const onScreen = (p) => p && p[0] >= -200 && p[0] <= W + 200 && p[1] >= -200 && p[1] <= H + 200;
      const out = [];
      for (let i = 1; i < N - 1; i++) {
        const a = scr[i-1], b = scr[i], c = scr[i+1];
        if (!a || !b || !c) continue;
        if (!onScreen(a) || !onScreen(b) || !onScreen(c)) continue;
        const ax = b[0]-a[0], ay = b[1]-a[1], bx = c[0]-b[0], by = c[1]-b[1];
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        if (la < 1e-6 || lb < 1e-6) continue;
        const cs = Math.max(-1, Math.min(1, (ax*bx+ay*by)/(la*lb)));
        out.push({ i, deg: Math.acos(cs)*180/Math.PI, la, lb, t: S.trailT ? S.trailT[i] : 0 });
      }
      return out;
    });
    // 只看屏幕弦长 >= 0.4px 的（可视角）
    const vis = ang.filter((e) => e.la >= 0.4 && e.lb >= 0.4);
    vis.sort((a, b) => b.deg - a.deg);
    console.log('屏幕折角（双弦>=0.4px）top-8:');
    for (const e of vis.slice(0, 8)) {
      console.log(`  i=${e.i} deg=${e.deg.toFixed(2)}° chord=${e.la.toFixed(2)}/${e.lb.toFixed(2)} px`);
    }
    const la = ang.filter((e) => e.la > 0.01 && e.lb > 0.01);
    la.sort((a, b) => b.deg - a.deg);
    console.log('屏幕折角（任意弦）top-5:');
    for (const e of la.slice(0, 5)) {
      console.log(`  i=${e.i} deg=${e.deg.toFixed(2)}° chord=${e.la.toFixed(3)}/${e.lb.toFixed(3)} px`);
    }
    // 发射段（t < -69700000）最大屏幕折角
    const lm = ang.filter((e) => e.t < -69700000 && e.la > 0.01 && e.lb > 0.01)
      .sort((a, b) => b.deg - a.deg).slice(0, 5);
    console.log('发射段屏幕折角 top-5:');
    for (const e of lm) console.log(`  i=${e.i} deg=${e.deg.toFixed(2)}° chord=${e.la.toFixed(3)}/${e.lb.toFixed(3)} px`);
  }

  await browser.close(); srv.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
