/* dbg_tail_buf.js —— 直接检查尾迹缓冲与 origin，判定浮动原点基准是否一致。 */
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
    fs.readFile(p, (e, d) => { if (e) { res.writeHead(404); return res.end('nf'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' }); res.end(d); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const PORT = srv.address().port;
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-sandbox','--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(12000);
  const r = await page.evaluate(() => {
    const S = window.CassiniScene, C = window.CassiniCamera, T = window.CassiniTimeline;
    T.setNow((Date.parse('1997-10-15T11:40:00Z') - 946728000000)/1000); T.setPlaying(false);
    S.updatePositions(T.state.t);
    S.updateRender(T.state.t);
    const o = S.trailOrigin;
    const ta = S.tailAbs, fl = S.trailFlownLine, fu = S.trailFullLine;
    const dump = (l, k) => { const a = l.geometry.attributes.position.array;
      const r = l.geometry.drawRange, n = l.geometry.attributes.position.count;
      const i0 = r.start, i1 = Math.min(r.start + r.count, n);
      const rows = [];
      for (let i = i0; i < Math.min(i1, i0 + k); i++) rows.push([+a[i*3].toFixed(1), +a[i*3+1].toFixed(1), +a[i*3+2].toFixed(1)]);
      return { vis: l.visible, range: [i0, i1], pos: [+l.position.x.toFixed(1), +l.position.y.toFixed(1), +l.position.z.toFixed(1)], rows }; };
    const cass = [0,0,0]; S.cassiniPosAt(T.state.t, cass);
    return {
      trailOrigin: [+o.x.toFixed(1), +o.y.toFixed(1), +o.z.toFixed(1)],
      camWorld: [S.camWorld.x, S.camWorld.y, S.camWorld.z].map(v=>+v.toFixed(1)),
      cass: cass.map(v=>+v.toFixed(1)),
      tailAbs: dump(ta, 4),
      flown: dump(fl, 2),
      full: dump(fu, 2),
    };
  });
  console.log(JSON.stringify(r, null, 2));
  await browser.close(); srv.close();
})().catch((e)=>{ console.error('ERR', e); process.exit(1); });
