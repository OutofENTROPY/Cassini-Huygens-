/* probe_shake_repeat.js —— 对照组：完全不改任何参数，连续抓 N 次同一个相机状态。
 * 若顶点屏位仍有变化 → 抖动来自「每帧重算的非确定性」（缓动/时序/状态残留），
 * 而非视角变化。再用不同等待时长看是否收敛。
 */
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = 'D:/Programming/HTML/Cassini';
const MIME = { '.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.glb':'model/gltf-binary','.wasm':'application/wasm','.json':'application/json' };
const srv = http.createServer((req,res)=>{ let r=decodeURIComponent(req.url.split('?')[0]); if(r==='/')r='/index.html'; const fp=path.join(ROOT,r); fs.readFile(fp,(e,b)=>{ if(e){res.writeHead(404);return res.end();} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(b);});});
const WHEN = process.argv[2] || '2007-06-01T00:00:00Z';
const DIST = parseFloat(process.argv[3] || '1e7');
const WAITS = [300, 600, 1200, 2500, 5000];
(async () => {
  await new Promise(res => srv.listen(0,'127.0.0.1',res));
  const P = srv.address().port;
  const browser = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true, args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
  const page = await browser.newPage({ viewport:{width:1600,height:900} });
  page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,300)));
  await page.goto(`http://127.0.0.1:${P}/index.html`,{waitUntil:'load',timeout:60000});
  await page.waitForTimeout(9000);
  await page.evaluate(()=>{ const b=document.getElementById('help-close'); if(b) b.click(); });
  await page.evaluate((when)=>{ const t=(Date.parse(when)-946728000000)/1000; if(window.CassiniTimeline){window.CassiniTimeline.setNow(t);window.CassiniTimeline.setPlaying(false);} window.CassiniScene.__nowT=t; },WHEN);
  await page.waitForTimeout(1200);

  const setCam = (dth)=>page.evaluate(({dist,dth})=>{ window.CassiniCamera.focus('cassini',{dist,animate:false,theta:0.9+dth,phi:1.05}); },{dist:DIST,dth});
  const grab = ()=>page.evaluate(()=>{
    const s=window.CassiniScene, n=s.trailLength|0, T=s.trailT;
    const tNow=s.__nowT, iNow=s.trailIndexAt(tNow);
    const V=[];
    for(let k=0;k<=40;k++){ const ii=Math.max(0,Math.min(n-1,iNow-600+Math.round(k*30)));
      const w=s.trailWorldAt(ii); if(!w)continue; const p=s.screenPosOf(w);
      V.push([ii, +p.x.toFixed(4), +p.y.toFixed(4), p.behind?1:0]); }
    const cass=s.cassWorld; const fp=s.screenPosOf([cass[0],cass[1],cass[2]]);
    return {V, focus:[+fp.x.toFixed(4), +fp.y.toFixed(4)], cam:[s.camWorld.x,s.camWorld.y,s.camWorld.z], theta:window.CassiniCamera.state&&window.CassiniCamera.state.sTheta, dist:window.CassiniCamera.currentDist};
  });

  // A) 完全不改参数，重复抓 5 次
  await setCam(0); await page.waitForTimeout(3000);
  console.log('=== A) 相机不变，连续抓 5 次（看非确定性）===');
  let prev=null;
  for(let i=0;i<5;i++){
    const g=await grab();
    if(prev){
      let mx=0;
      for(const [ii,x,y,b] of g.V){ const p=prev.V.find(v=>v[0]===ii); if(!p||b||p[3])continue; mx=Math.max(mx,Math.hypot(x-p[1],y-p[2])); }
      console.log(`  抓 ${i}: 顶点屏位Δmax = ${mx.toFixed(5)} px   focusScr=(${g.focus[0]},${g.focus[1]})  sTheta=${g.theta}  dist=${g.dist}`);
    } else console.log(`  抓 0: focusScr=(${g.focus[0]},${g.focus[1]})  sTheta=${g.theta}`);
    prev=g; await page.waitForTimeout(500);
  }
  // B) 改角度后不同等待时长
  console.log('\n=== B) 改 θ 后不同等待时长（看缓动收敛）===');
  await setCam(0); await page.waitForTimeout(3000);
  const base=await grab();
  for(const W of WAITS){
    await setCam(0.02); await page.waitForTimeout(W);
    const g=await grab();
    let mx=0;
    for(const [ii,x,y,b] of g.V){ const p=base.V.find(v=>v[0]===ii); if(!p||b||p[3])continue; mx=Math.max(mx,Math.hypot(x-p[1],y-p[2])); }
    console.log(`  wait=${W}ms: sTheta=${g.theta}  顶点屏位Δmax=${mx.toFixed(4)}px  focusScr=(${g.focus[0]},${g.focus[1]})`);
    await setCam(0); await page.waitForTimeout(3000);
  }
  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
