/* probe_shake_local.js —— 只采样「时间上邻近当前历元」的轨迹顶点（局部窗口），
 * 这些顶点必然在相机附近、屏内可见，才是用户实际看到的会抖动的那段。
 * 判据：局部窗口内相邻顶点的屏幕弦长 / 屏幕转角跨帧变化。
 * 用法：node probe_shake_local.js [WHEN] [FOCUS] [DIST] [WIN_HOURS] [TAG]
 */
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = 'D:/Programming/HTML/Cassini';
const MIME = { '.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.glb':'model/gltf-binary','.wasm':'application/wasm','.json':'application/json' };
const srv = http.createServer((req,res)=>{ let r=decodeURIComponent(req.url.split('?')[0]); if(r==='/')r='/index.html'; const fp=path.join(ROOT,r); fs.readFile(fp,(e,b)=>{ if(e){res.writeHead(404);return res.end();} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(b);});});

const WHEN  = process.argv[2] || '2007-06-01T00:00:00Z';
const FOCUS = process.argv[3] || 'saturn';
const TAG   = process.argv[4] || 'local';
const WIN_H = parseFloat(process.argv[5] || '72');
const DISTS = [3e5, 1e6, 3e6, 1e7, 3e7, 1e8];
const DTHS  = [0, 0.002, 0.004, 0.008, 0.016, 0.03, 0.06];

(async () => {
  await new Promise(res => srv.listen(0,'127.0.0.1',res));
  const PORT = srv.address().port;
  const browser = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true, args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
  const page = await browser.newPage({ viewport:{width:1600,height:900} });
  page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,300)));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'load',timeout:60000});
  await page.waitForTimeout(9000);
  await page.evaluate(()=>{ const b=document.getElementById('help-close'); if(b) b.click(); });
  await page.evaluate((when)=>{ const t=(Date.parse(when)-946728000000)/1000; if(window.CassiniTimeline){window.CassiniTimeline.setNow(t);window.CassiniTimeline.setPlaying(false);} window.CassiniScene.__nowT=t;; },WHEN);
  const tnow = await page.evaluate((when)=>(Date.parse(when)-946728000000)/1000, WHEN);
  await page.evaluate((t)=>window.CassiniScene.__nowT=t, tnow);
  await page.waitForTimeout(1200);

  const snap = async (dist, dth) => {
    await page.evaluate(({focus,dist,dth})=>{
      window.CassiniCamera.focus(focus,{dist,animate:false,theta:0.9+dth,phi:1.05});
    },{focus:FOCUS,dist,dth});
    await page.waitForTimeout(1100);
    return await page.evaluate((winH)=>{
      const s=window.CassiniScene, n=s.trailLength|0, T=s.trailT;
      const tNow = s.__nowT;
      const iNow = s.trailIndexAt(tNow);
      // 取 [tNow-winH*3600, tNow] 内所有索引，均匀抽 60 个
      let lo=iNow; while(lo>0 && T[iNow]-T[lo-1] < winH*3600) lo--;
      const span=iNow-lo;
      const pts=[];
      if (span>=8) {
        for(let k=0;k<=60;k++){
          const ii=lo+Math.round(span*k/60);
          const w=s.trailWorldAt(ii); if(!w) continue;
          const p=s.screenPosOf(w);
          pts.push([ii, p.x, p.y, p.behind?1:0, p.dist]);
        }
      }
      // 聚焦点（Cassini 当前位置）的屏幕位置：相机绕它转，故它屏位应恒定；
      // 用「顶点屏位 − 聚焦点屏位」消除视差与整体平移。
      const fw = s.cassWorld;
      const fp = fw ? s.screenPosOf([fw[0],fw[1],fw[2]]) : {x:0,y:0,behind:0};
      return {pts, focusScr:[fp.x, fp.y, fp.behind?1:0], iNow, tNow, lo, span, W:window.innerWidth, H:window.innerHeight, cam:[s.camWorld.x,s.camWorld.y,s.camWorld.z]};
    }, WIN_H);
  };

  const metrics = (pts, rel) => {
    // 注意：不做 behind/离屏筛选，改为「按索引对齐」跨帧比较——筛选会在帧间
    // 改变可见集合大小 → 数组索引错位 → 假抖动信号。这里保留全部采样点，
    // 用 Map(idx → [x,y]) 对齐，只对两帧都存在的索引比较。
    const m = new Map();
    for (const p of pts) m.set(p[0], {x:p[1]-rel[0], y:p[2]-rel[1], behind:p[3], dist:p[4]});
    return m;
  };

  console.log(`WHEN=${WHEN} FOCUS=${FOCUS}  局部窗口=±${WIN_H}h`);
  console.log('dist(km)  可见n  弦长Δmax(px)  相对%   转角Δmax(°)  顶点屏位Δmax(px) 说明');
  for (const d of DISTS) {
    const A = await snap(d, 0);
    const ma = metrics(A.pts, A.focusScr);
    const keys = [...ma.keys()].sort((a,b)=>a-b);
    if (keys.length < 6) { console.log(`${d.toExponential(2).padStart(9)}  ${String(keys.length).padStart(5)}  (可见顶点不足)`); continue; }
    let maxDc=0,maxRel=0,maxDt=0,maxPt=0;
    for (const dth of DTHS.slice(1)) {
      const B = await snap(d, dth);
      const mb = metrics(B.pts, B.focusScr);
      // 顶点屏位差（同索引）——最直接的抖动指标
      for (const k of keys) {
        const a=ma.get(k), b=mb.get(k);
        if(!a||!b) continue;
        if(a.behind||b.behind) continue;
        if(a.x<-100||a.x>1700||a.y<-100||a.y>1000) continue;
        const dp=Math.hypot(a.x-b.x, a.y-b.y);
        if(dp>maxPt)maxPt=dp;
      }
      // 弦长（同索引相邻对）
      for (let i=1;i<keys.length;i++){
        const k0=keys[i-1], k1=keys[i];
        const a0=ma.get(k0),a1=ma.get(k1),b0=mb.get(k0),b1=mb.get(k1);
        if(!a0||!a1||!b0||!b1) continue;
        if(a0.behind||a1.behind||b0.behind||b1.behind) continue;
        if(a0.x<-100||a0.x>1700||a0.y<-100||a0.y>1000) continue;
        if(a1.x<-100||a1.x>1700||a1.y<-100||a1.y>1000) continue;
        const ca=Math.hypot(a1.x-a0.x, a1.y-a0.y), cb=Math.hypot(b1.x-b0.x, b1.y-b0.y);
        const dc=Math.abs(ca-cb);
        if(dc>maxDc)maxDc=dc;
        const r=dc/Math.max(ca,1e-6); if(r>maxRel)maxRel=r;
      }
      // 转角（同索引三元组）
      for (let i=1;i<keys.length-1;i++){
        const a0=ma.get(keys[i-1]),a1=ma.get(keys[i]),a2=ma.get(keys[i+1]);
        const b0=mb.get(keys[i-1]),b1=mb.get(keys[i]),b2=mb.get(keys[i+1]);
        if(!a0||!a1||!a2||!b0||!b1||!b2) continue;
        if(a0.behind||a1.behind||a2.behind||b0.behind||b1.behind||b2.behind) continue;
        const ang=(p,q,r)=>{ const ax=q.x-p.x,ay=q.y-p.y,bx=r.x-q.x,by=r.y-q.y;
          const la=Math.hypot(ax,ay),lb=Math.hypot(bx,by); if(la<1e-6||lb<1e-6)return 0;
          let c=(ax*bx+ay*by)/(la*lb); c=Math.max(-1,Math.min(1,c)); return Math.acos(c)*180/Math.PI; };
        const dt=Math.abs(ang(a0,a1,a2)-ang(b0,b1,b2));
        if(dt>maxDt)maxDt=dt;
      }
    }
    const flag = (maxPt>1.0||maxDc>1.0)?'  <<< 可见抖动':((maxPt>0.3||maxDc>0.3)?'  < 轻微':'  OK');
    console.log(`${d.toExponential(2).padStart(9)}  ${String(keys.length).padStart(5)}  ${maxDc.toFixed(4).padStart(12)}  ${(maxRel*100).toFixed(2).padStart(6)}%  ${maxDt.toFixed(4).padStart(12)}  ${maxPt.toFixed(4).padStart(14)}${flag}`);
    console.log(`         (样本 iNow=${A.iNow} lo=${A.lo} span=${A.span})`);
  }
  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
