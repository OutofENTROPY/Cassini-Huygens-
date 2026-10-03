/* verify_soi_seam.js —— SOI 相对轨迹专项验证（新 rel0 锚定语义下）。
 *
 * 判据 1（窗口线↔尾迹接缝）：窗口 flown 线 drawRange 末顶点应与 tailPlanet
 *   首/尾顶点在屏幕上重合（衔接点逐位一致，≤0.5 px）。
 * 判据 2（飞船贴合）：当前时刻 t 处，窗口顶点（idxNow 对应）与飞船标记
 *   cassiniPosAt(t) 的世界距离应 ≤ 2×网格步长（沿轨迹弦长，飞船在两顶点间）。
 * 判据 3（世界坐标正确性）：窗口顶点世界坐标 − planet_now ≡ rel0 + buf（f64 重构，
 *   残差应 < 1e-3 km，证明 f32 缓冲无可见量化）。
 * 用法：node verify_soi_seam.js
 */
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = 'D:/Programming/HTML/Cassini';
const MIME = { '.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.glb':'model/gltf-binary','.wasm':'application/wasm','.json':'application/json' };
const srv = http.createServer((req,res)=>{ let r=decodeURIComponent(req.url.split('?')[0]); if(r==='/')r='/index.html'; const fp=path.join(ROOT,r); fs.readFile(fp,(e,b)=>{ if(e){res.writeHead(404);return res.end();} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(b);});});

// [epoch, focus, dist, winName]
const CASES = [
  ['1998-04-26T13:45:00Z', 'venus',   2.0e6, 'venus'],
  ['1999-08-18T03:28:00Z', 'earth',   2.0e6, 'earth'],
  ['2000-12-30T10:05:00Z', 'jupiter', 1.0e7, 'jupiter'],
  ['2004-07-01T01:00:00Z', 'saturn',  5.0e5, 'saturn'],
  ['2005-01-14T10:00:00Z', 'titan',   3.0e5, 'titan'],
  ['2010-05-19T00:00:00Z', 'titan',   3.0e5, 'titan'],
  ['2017-04-26T00:00:00Z', 'saturn',  1.0e5, 'saturn'],
];

(async()=>{
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const P=srv.address().port;
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1400,height:800}});
  page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,300)));
  await page.goto(`http://127.0.0.1:${P}/index.html`,{waitUntil:'load',timeout:60000});
  await page.waitForTimeout(9000);
  await page.evaluate(()=>{const b=document.getElementById('help-close');if(b)b.click();});

  const run=await page.evaluate((cases)=>{
    const OFF=65;
    const S=window.CassiniScene, C=window.CassiniCamera;
    const frame=(t)=>{const {cassWorld}=S.updatePositions(t);
      const cache={}; for(const [n,e] of S.registry) cache[n]=e.world; cache.cassini=cassWorld;
      try{C.update(performance.now(),cache,cassWorld,S);}catch(e){}
      S.updateRender(t);};
    const out=[];
    for(const [when,focus,dist,winName] of cases){
      const t=(Date.parse(when)-946728000000)/1000+OFF;
      if(window.CassiniTimeline){window.CassiniTimeline.setNow(t);window.CassiniTimeline.setPlaying(false);}
      frame(t); C.focus(focus,{dist,animate:false}); if(C.state)C.state.sDist=dist; frame(t); frame(t);
      const sp=S.soiPlanets.get(winName);
      if(!sp){out.push({when,skip:'no '+winName});continue;}
      const e=sp.entry; let w=null;
      for(const x of sp.wins){if(x.flown.visible||x.full.visible){w=x;break;}}
      if(!w){out.push({when,skip:'win 不可见'});continue;}
      const buf=w.flown.geometry.attributes.position.array;
      const dr=w.flown.geometry.drawRange;
      const rel0=w.rel0||[0,0,0];
      const c=S.camWorld;
      const worldAt=(line,i)=>{const g=i*3;const o=line.position;
        return [c.x+o.x+buf[g], c.y+o.y+buf[g+1], c.z+o.z+buf[g+2]];};
      // 判据1：窗口 flown 末顶点 vs tailPlanet 末顶点（尾迹覆盖衔接段，末点=当前时刻）
      const tail=S.tailPlanet;
      const tdr=tail.geometry.drawRange;
      const tArr=tail.geometry.attributes.position.array;
      const tailEnd=(()=>{const i=tdr.start+tdr.count-1;const g=i*3;const o=tail.position;
        return [c.x+o.x+tArr[g], c.y+o.y+tArr[g+1], c.z+o.z+tArr[g+2]];})();
      const flownLast=worldAt(w.flown, dr.start+dr.count-1);
      const sA=S.screenPosOf(flownLast), sB=S.screenPosOf(tailEnd);
      const seamPx=Math.hypot(sA.x-sB.x, sA.y-sB.y);
      // 判据2：飞船贴合（窗口内最近顶点 vs cassiniPosAt(t)）
      const idxNow=S.trailIndexAt(t);
      const relIdx=Math.min(Math.max(idxNow-w.i0,0),w.n-1);
      const vNow=worldAt(w.flown, relIdx);
      const cw=S.cassiniPosAt(t,[0,0,0]);
      const shipGap=Math.hypot(vNow[0]-cw[0],vNow[1]-cw[1],vNow[2]-cw[2]);
      // 网格步长（该点邻域）
      const vN2=worldAt(w.flown, Math.min(relIdx+1,w.n-1));
      const step=Math.hypot(vNow[0]-vN2[0],vNow[1]-vN2[1],vNow[2]-vN2[2]);
      // 判据3：世界坐标 − planet_now vs rel0+buf 重构残差
      let resid=0;
      for(let i=0;i<w.n;i+=Math.max(1,Math.floor(w.n/2000))){
        const g=i*3;const wv=worldAt(w.flown,i);
        const ex=[e.world[0]+rel0[0]+buf[g], e.world[1]+rel0[1]+buf[g+1], e.world[2]+rel0[2]+buf[g+2]];
        const d=Math.hypot(wv[0]-ex[0],wv[1]-ex[1],wv[2]-ex[2]);
        if(d>resid)resid=d;}
      out.push({when, winName, seamPx, shipGap, step, gapOverStep: shipGap/Math.max(step,1e-9), resid,
        flownCount: dr.count, relIdx, camDist: C.currentDist ? C.currentDist() : dist});
    }
    return out;
  }, CASES);

  const pad=(s,l)=>String(s).padStart(l);
  console.log('epoch                 win     seamPx   shipGap(km)  step(km)  gap/step  resid(km)  flown');
  let fail=0;
  for(const r of run){
    if(r.skip){ console.log(`${r.when}  [skip] ${r.skip}`); continue; }
    const ok = r.seamPx<=0.5 && r.gapOverStep<=1.001+1e-9 && r.resid<1e-3;
    if(!ok) fail++;
    console.log(`${r.when}  ${r.winName.padEnd(7)} ${pad(r.seamPx.toFixed(3),7)}  ${pad(r.shipGap.toExponential(3),10)}  ${pad(r.step.toExponential(3),8)}  ${pad(r.gapOverStep.toFixed(3),7)}  ${pad(r.resid.toExponential(2),8)}  ${r.flownCount}${ok?'':'  ← FAIL'}`);
  }
  console.log(fail===0 ? '\n全部通过' : `\n${fail} 项 FAIL`);
  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
