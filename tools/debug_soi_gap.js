/* debug_soi_gap.js —— 诊断 SOI 窗口顶点与飞船标记的间隙来源。
 * 打印：t_now、窗口顶点时刻、Δt、以及把 gap 分解为
 *   (a) 行星平移差 planet_now − planet(t_j)   （语义性，应随 Δt→0 消失）
 *   (b) 飞船自身网格弦差 cassini(t_j) − cassini(t)（沿轨迹，≤1 步长）
 */
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = 'D:/Programming/HTML/Cassini';
const MIME = { '.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css','.png':'image/png' };
const srv = http.createServer((req,res)=>{ let r=decodeURIComponent(req.url.split('?')[0]); if(r==='/')r='/index.html'; const fp=path.join(ROOT,r); fs.readFile(fp,(e,b)=>{ if(e){res.writeHead(404);return res.end();} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(b);});});
const CASES = [
  ['1998-04-26T13:45:00Z', 'venus', 2.0e6, 'venus'],
  ['2004-07-01T01:00:00Z', 'saturn', 5.0e5, 'saturn'],
  ['2017-04-26T00:00:00Z', 'saturn', 1.0e5, 'saturn'],
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
  const out=await page.evaluate((cases)=>{
    const OFF=65;
    const S=window.CassiniScene, C=window.CassiniCamera;
    const frame=(t)=>{const {cassWorld}=S.updatePositions(t);
      const cache={}; for(const [n,e] of S.registry) cache[n]=e.world; cache.cassini=cassWorld;
      try{C.update(performance.now(),cache,cassWorld,S);}catch(e){}
      S.updateRender(t);};
    const res=[];
    for(const [when,focus,dist,winName] of cases){
      const t=(Date.parse(when)-946728000000)/1000+OFF;
      if(window.CassiniTimeline){window.CassiniTimeline.setNow(t);window.CassiniTimeline.setPlaying(false);}
      frame(t); C.focus(focus,{dist,animate:false}); if(C.state)C.state.sDist=dist; frame(t); frame(t);
      const sp=S.soiPlanets.get(winName);
      const e=sp.entry; let w=null;
      for(const x of sp.wins){if(x.flown.visible||x.full.visible){w=x;break;}}
      if(!w){res.push({when,skip:'win不可见'});continue;}
      const idxNow=S.trailIndexAt(t);
      const relIdx=Math.min(Math.max(idxNow-w.i0,0),w.n-1);
      const buf=w.flown.geometry.attributes.position.array, rel0=w.rel0||[0,0,0];
      const c=S.camWorld, o=w.flown.position, g=relIdx*3;
      const vWin=[c.x+o.x+buf[g], c.y+o.y+buf[g+1], c.z+o.z+buf[g+2]];
      const cw=S.cassiniPosAt(t,[0,0,0]);
      // 用窗口 rel 与行星当前位置重构「行星在 t_j 的位置」：planet(t_j) = planet_now + rel_now_marker... 不可直接得。
      // 改为：shipAt(t_j) 重构 = vWin − planet_now + planet(t_j)。直接给出：
      const tj=S.trailT[w.i0+relIdx];
      const shipNow=[cw[0],cw[1],cw[2]];
      const gap=Math.hypot(vWin[0]-cw[0],vWin[1]-cw[1],vWin[2]-cw[2]);
      // 主轨迹插值位置（与 cassiniPosAt 同源之一）在该时刻的值
      const shipAtTj=S.cassiniPosAt(tj,[0,0,0]);
      // planet(t_j) = shipAtTj − rel_j（rel_j = ship−planet @t_j，baked）
      const relj=[rel0[0]+buf[g], rel0[1]+buf[g+1], rel0[2]+buf[g+2]];
      const planetTj=[shipAtTj[0]-relj[0], shipAtTj[1]-relj[1], shipAtTj[2]-relj[2]];
      const planetNow=e.world;
      const transErr=Math.hypot(planetNow[0]-planetTj[0],planetNow[1]-planetTj[1],planetNow[2]-planetTj[2]);
      res.push({when, winName, t, tj, dt:t-tj, idxNow, wI0:w.i0, relIdx, n:w.n,
        gap, transErr, shipMove:Math.hypot(shipAtTj[0]-cw[0],shipAtTj[1]-cw[1],shipAtTj[2]-cw[2]),
        trailIdxNow: idxNow, wEnd: w.i0+w.n-1});
    }
    return res;
  }, CASES);
  for(const r of out){
    if(r.skip){console.log(r.when,'[skip]',r.skip);continue;}
    console.log(`\n[${r.winName}] ${r.when}`);
    console.log(`  t=${r.t.toFixed(1)}  t_j=${r.tj.toFixed(1)}  Δt=${r.dt.toFixed(1)} s`);
    console.log(`  idxNow=${r.idxNow}  w.i0=${r.wI0}  relIdx=${r.relIdx}/${r.n}  (i0+n-1=${r.wEnd})`);
    console.log(`  gap(窗口顶点 vs 标记) = ${r.gap.toExponential(3)} km`);
    console.log(`  行星平移差 |planet_now − planet(t_j)| = ${r.transErr.toExponential(3)} km`);
    console.log(`  飞船弦差 |ship(t_j) − ship(t)| = ${r.shipMove.toExponential(3)} km`);
  }
  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
