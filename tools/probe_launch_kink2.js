/* probe_launch_kink2.js —— 量化发射历元轨迹折线：past / tail / future 三段屏幕角。
 * 世界坐标 = 缓冲 + trailOrigin（浮动原点）。
 * 必须让主循环自然跑几帧（cam.update 刷新 camWorld / trailOrigin）后再测量。
 * 用法：node probe_launch_kink2.js [UTC] [camDist]
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
  // 关掉欢迎浮层（"开始探索"）并切到"全部轨迹"
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button,[role=button],.btn')];
    const go = btns.find((b) => /开始探索|开始/.test(b.innerText || ''));
    if (go) go.click();
  });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button,[role=button],.btn')];
    const all = btns.find((b) => /全部轨迹/.test(b.innerText || ''));
    if (all) all.click();
  });
  await page.waitForTimeout(800);

  const utc = process.argv[2] || '1997-10-15T09:26:22Z';
  const camDist = parseFloat(process.argv[3] || '4.0e5');

  await page.evaluate(({ utcStr, camDist }) => {
    const C = window.CassiniCamera, T = window.CassiniTimeline;
    const t = (Date.parse(utcStr) - 946728000000) / 1000;
    T.setNow(t); T.setPlaying(false);
    C.focus('cassini', { dist: camDist, animate: false });
  }, { utcStr: utc, camDist });
  await page.waitForTimeout(2500);   // 让主循环跑几帧

  const res = await page.evaluate(({ utcStr }) => {
    const S = window.CassiniScene, C = window.CassiniCamera, T = window.CassiniTimeline;
    const t = T.state.t;
    const o = S.trailOrigin;
    const fl = S.trailFlownLine, fu = S.trailFullLine, ta = S.tailAbs;
    const rng = (l) => { const r = l.geometry.drawRange, n = l.geometry.attributes.position.count;
      return [r.start, Math.min(r.start + r.count, n)]; };
    const W = (l, i) => { const a = l.geometry.attributes.position.array;
      // 世界 = 缓冲 + trailOrigin（线对象 position = origin − cam 由渲染处理，
      // 因此世界坐标应为 buffer + origin）
      return [a[i*3] + o.x, a[i*3+1] + o.y, a[i*3+2] + o.z]; };
    const scr = (v) => { const s = S.screenPosOf(v); return s ? [s.x, s.y] : null; };

    const turn = (pts) => {
      const s = pts.map(scr).filter(Boolean);
      if (s.length < 3) return { n: s.length, maxDeg: null };
      let mx = 0, mi = -1;
      for (let i = 1; i < s.length - 1; i++) {
        const ax = s[i][0]-s[i-1][0], ay = s[i][1]-s[i-1][1];
        const bx = s[i+1][0]-s[i][0], by = s[i+1][1]-s[i][1];
        const la = Math.hypot(ax,ay), lb = Math.hypot(bx,by);
        if (la < 1e-6 || lb < 1e-6) continue;
        const cs = Math.max(-1, Math.min(1, (ax*bx+ay*by)/(la*lb)));
        const d = Math.acos(cs)*180/Math.PI;
        if (d > mx) { mx = d; mi = i; }
      }
      return { n: s.length, maxDeg: +mx.toFixed(2), at: mi,
               first: s[0].map(v=>+v.toFixed(1)), last: s[s.length-1].map(v=>+v.toFixed(1)) };
    };

    const [f0,f1] = rng(fl), [u0,u1] = rng(fu), [t0,t1] = rng(ta);
    const flownTail = []; for (let i = Math.max(f0, f1-14); i < f1; i++) flownTail.push(W(fl,i));
    const fullHead  = []; for (let i = u0; i < Math.min(u1, u0+14); i++) fullHead.push(W(fu,i));
    const tailAll   = []; for (let i = t0; i < t1; i++) tailAll.push(W(ta,i));

    const cass = [0,0,0]; S.cassiniPosAt(t, cass);
    const d3 = (a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);

    return {
      t: +t.toFixed(2),
      v: { flown: [fl.visible, JSON.stringify(rng(fl))],
           full: [fu.visible, JSON.stringify(rng(fu))],
           tailAbs: [ta.visible, JSON.stringify(rng(ta))] },
      opts: (() => { try { return JSON.stringify(window.CassiniScene.trailOptionsDebug || null); } catch(e){ return 'n/a'; } })(),
      visFlags: (() => {
        const r = {};
        const tgl = [...document.querySelectorAll('button,[role=button],.toggle,label')];
        r.buttons = tgl.map(b => (b.innerText||b.textContent||'').trim()).filter(Boolean).slice(0, 20);
        return r;
      })(),
      cam: { dist: C.state && C.state.sDist, focus: C.state && C.state.focusName },
      trailOrigin: [+o.x.toFixed(0), +o.y.toFixed(0), +o.z.toFixed(0)],
      cassDistEarth_km: (()=>{ const e = S.registry.get('earth').world; return +d3(cass, e).toFixed(1); })(),
      pastTail: turn(flownTail),
      futureHead: turn(fullHead),
      tailAbs: turn(tailAll),
      joinPastTail: turn([...flownTail.slice(-4), ...tailAll]),
      joinTailFuture: turn([...tailAll.slice(-4), ...fullHead]),
      tailEndToMarker_km: tailAll.length ? +d3(tailAll[tailAll.length-1], cass).toFixed(4) : null,
      flownEndToMarker_km: flownTail.length ? +d3(flownTail[flownTail.length-1], cass).toFixed(4) : null,
      futureStartToMarker_km: fullHead.length ? +d3(fullHead[0], cass).toFixed(4) : null,
    };
  }, { utcStr: utc });

  console.log(JSON.stringify(res, null, 2));
  await page.screenshot({ path: 'D:/Programming/HTML/Cassini/tools/shots/kink2.png' });
  await browser.close();
  srv.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
