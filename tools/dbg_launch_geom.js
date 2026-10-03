/* dbg_launch_geom.js —— 在真实渲染状态下，输出发射历元前后若干 trail 顶点的世界/屏幕坐标，
 * 判断「past 缺失」与「future 双向」的具体成因。 */
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
  await page.evaluate(() => { document.getElementById('help-close')?.click();
    document.querySelector('.overlay,#help,.welcome')?.style && (document.querySelector('.overlay,#help,.welcome').style.display='none'); });
  await page.evaluate(() => { window.CassiniScene.setTrailOptions({ mode:'all', future:true, cassini:true }); });
  await page.evaluate(() => {
    const C = window.CassiniCamera, T = window.CassiniTimeline;
    T.setNow((Date.parse('1997-10-15T09:26:22Z') - 946728000000)/1000);
    T.setPlaying(false); C.focus('cassini', { dist: 4.0e5, animate: false });
  });
  await page.waitForTimeout(3000);
  const r = await page.evaluate(() => {
    const S = window.CassiniScene, T = window.CassiniTimeline;
    const t = T.state.t, o = S.trailOrigin;
    const fu = S.trailFullLine, fl = S.trailFlownLine, ta = S.tailAbs;
    const W = (l,i) => { const a=l.geometry.attributes.position.array;
      return [a[i*3]+o.x, a[i*3+1]+o.y, a[i*3+2]+o.z]; };
    const scr = (v) => { const s=S.screenPosOf(v); return s?[+s.x.toFixed(1),+s.y.toFixed(1)]:null; };
    const cass=[0,0,0]; S.cassiniPosAt(t,cass);
    const d3=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
    const out={ t:+t.toFixed(1), cass: cass.map(v=>+v.toFixed(0)),
      fullRange: JSON.stringify(fu.geometry.drawRange),
      flownVis: fl.visible, tailVis: ta.visible,
      trailT_len: S.trailT ? S.trailT.length : 'n/a' };
    // full 线前 8 个顶点
    out.full0_8 = []; for (let i=0;i<8;i++) out.full0_8.push({ i, km:+d3(W(fu,i),cass).toFixed(0), scr: scr(W(fu,i)) });
    // full 线末尾 4 个顶点（是否绕回）
    const last = fu.geometry.attributes.position.count - 1;
    out.fullLast = []; for (let i=last-3;i<=last;i++) out.fullLast.push({ i, km:+d3(W(fu,i),cass).toFixed(0), scr: scr(W(fu,i)) });
    // tail 全段
    out.tail = []; const r2 = ta.geometry.drawRange;
    for (let i=r2.start;i<Math.min(r2.start+r2.count,12);i++) out.tail.push({ i, km:+d3(W(ta,i),cass).toFixed(3), scr: scr(W(ta,i)) });
    // —— 诊断「past 缺失」：t 在 trail 中的索引、flown 应有顶点数 ——
    // 复刻 scene 的 idxNow / idxTail 计算
    const tt = S.trailT;
    let lo=0, hi=tt.length-1;
    while (hi-lo>1){ const m=(lo+hi)>>1; if (tt[m]<=t) lo=m; else hi=m; }
    out.idxNow = lo;
    out.trailT0 = +tt[0].toFixed(2); out.trailT1 = +tt[1].toFixed(2);
    out.tNow_minus_trailT0 = +(t - tt[0]).toFixed(2);
    out.tailTimes_len = 12;
    // 未来线首顶点的时刻
    out.fullStartTime_vs_t = { trailT_at_idx1: +tt[1].toFixed(2), t: +t.toFixed(2), dt: +(tt[1]-t).toFixed(2) };
    // tail 前 3 点与 future 首点的世界坐标（判断衔接是否连续）
    const w = (i)=>W(ta,i);
    out.tailFirst3 = [w(0), w(1), w(2)].map(v=>v.map(x=>+x.toFixed(0)));
    out.futureFirst3 = [W(fu,1), W(fu,2), W(fu,3)].map(v=>v.map(x=>+x.toFixed(0)));
    out.tailLast = w(11).map(x=>+x.toFixed(0));
    return out;
  });
  console.log(JSON.stringify(r, null, 2));
  await browser.close(); srv.close();
})().catch((e)=>{ console.error('ERR', e); process.exit(1); });
