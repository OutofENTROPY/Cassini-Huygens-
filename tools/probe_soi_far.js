/* probe_soi_far.js —— 验证「SOI 相对轨迹」在远视角拖动相机时不再错位，
 * 且近场精度达标。判据（新设计）：
 *   world_k（渲染世界坐标） = full.position + buf_k
 *                           ≡ planet_now + rel0 + (rel_k − rel0) = planet_now + rel_k
 * 与相机位置无关（相机只通过 screenPosOf 投影影响屏幕坐标）。
 *
 * 测三项：
 *   A) 世界坐标稳定性：远视角滑动相机 12 步，max|世界位移| 必须 ≈ 0；
 *   B) 相对系精度：world_k − planet_now 应等于窗口内真实 rel_k（由数据重构）→ residual；
 *   C) 屏幕位移单调性：屏幕位移应只由投影引起，无台阶跳变。
 * 用法：node probe_soi_far.js [WHEN] [FOCUS] [DIST] [WINNAME]
 */
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = 'D:/Programming/HTML/Cassini';
const MIME = { '.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.glb':'model/gltf-binary','.wasm':'application/wasm','.json':'application/json' };
const srv = http.createServer((req,res)=>{ let r=decodeURIComponent(req.url.split('?')[0]); if(r==='/')r='/index.html'; const fp=path.join(ROOT,r); fs.readFile(fp,(e,b)=>{ if(e){res.writeHead(404);return res.end();} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(b);});});
const WHEN = process.argv[2] || '2004-07-01T00:00:00Z';
const FOCUS = process.argv[3] || 'saturn';
const DIST = parseFloat(process.argv[4] || '3e7');
const WIN = process.argv[5] || 'saturn';
const pad=(s,l)=>String(s).padEnd(l);

(async()=>{
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const P = srv.address().port;
  const browser = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true, args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
  const page = await browser.newPage({ viewport:{width:1400,height:800} });
  page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,300)));
  await page.goto(`http://127.0.0.1:${P}/index.html`,{waitUntil:'load',timeout:60000});
  await page.waitForTimeout(9000);
  await page.evaluate(()=>{const b=document.getElementById('help-close');if(b)b.click();});

  const res = await page.evaluate(async ({when,focus,dist,winName})=>{
    const OFF=65;   // ET_UTC_OFF
    const t=(Date.parse(when)-946728000000)/1000 + OFF;
    const S=window.CassiniScene, C=window.CassiniCamera;
    // 驱动一帧（与 main.js 主循环同序）：位置 → 相机 → 渲染
    const frame=()=>{ const {cassWorld}=S.updatePositions(t);
      const cache={}; for(const [n,e] of S.registry) cache[n]=e.world;
      cache.cassini=cassWorld;
      try{ C.update(performance.now(), cache, cassWorld, S); }catch(err){}
      S.updateRender(t); };
    if(window.CassiniTimeline){ window.CassiniTimeline.setNow(t); window.CassiniTimeline.setPlaying(false); }
    frame();
    C.focus(focus,{dist,animate:false});
    if(C.state){ C.state.sDist=dist; }
    for(let q=0;q<6;q++){ frame(); }   // 让相机/窗口稳定

    const sp=S.soiPlanets.get(winName);
    if(!sp) return {err:'窗口不存在 '+winName};
    const e=sp.entry;
    let w=null;
    for(const x of sp.wins){ if(x.full.visible||x.flown.visible){w=x;break;} }
    if(!w) w=sp.wins[0];
    const buf=w.full.geometry.attributes.position.array;
    const idx=[0, Math.floor(w.n*0.1), Math.floor(w.n*0.25), Math.floor(w.n*0.5), Math.floor(w.n*0.75), Math.floor(w.n*0.9), w.n-1];
    // 渲染世界坐标 = full.position + camWorld + buf（position 内含 −camWorld）
    const readW=()=>idx.map(i=>{const g=i*3;const c=S.camWorld;return [w.full.position.x+buf[g]+c.x, w.full.position.y+buf[g+1]+c.y, w.full.position.z+buf[g+2]+c.z];});
    const readS=()=>idx.map(i=>{const g=i*3;const c=S.camWorld;const wp=[w.full.position.x+buf[g]+c.x, w.full.position.y+buf[g+1]+c.y, w.full.position.z+buf[g+2]+c.z];const s=S.screenPosOf(wp);return {x:s.x,y:s.y};});

    // B) 精度：world − planet_now 应 = rel0 + buf（= 真 rel_k）
    const rel0=w.rel0||[0,0,0];
    const W0=readW();
    const resid=idx.map((i,j)=>{const g=i*3;
      const trueRel=[rel0[0]+buf[g], rel0[1]+buf[g+1], rel0[2]+buf[g+2]];
      const got=[W0[j][0]-e.world[0], W0[j][1]-e.world[1], W0[j][2]-e.world[2]];
      return Math.hypot(got[0]-trueRel[0],got[1]-trueRel[1],got[2]-trueRel[2]);});
    let maxResid=0; for(const r of resid) if(r>maxResid)maxResid=r;

    // A) 远视角滑动相机
    const th0=C.state.sTheta, ph0=C.state.sPhi;
    let prevW=W0, prevS=readS();
    const steps=[]; let maxMoveAll=0;
    for(let k=1;k<=12;k++){
      const th=th0+k*0.03, ph=ph0+k*0.008;
      C.focus(focus,{dist,animate:false,theta:th,phi:ph});
      if(C.state){C.state.sTheta=th;C.state.sPhi=ph;C.state.sDist=dist;}
      frame();
      const W=readW(), Sc=readS();
      let mv=0, ms=0;
      for(let j=0;j<idx.length;j++){
        const d=Math.hypot(W[j][0]-prevW[j][0],W[j][1]-prevW[j][1],W[j][2]-prevW[j][2]);
        if(d>mv)mv=d;
        const ds=Math.hypot(Sc[j].x-prevS[j].x, Sc[j].y-prevS[j].y);
        if(ds>ms)ms=ds;
      }
      if(mv>maxMoveAll)maxMoveAll=mv;
      steps.push({k,mv,ms,sx:Sc.map(o=>o.x),sy:Sc.map(o=>o.y)});
      prevW=W; prevS=Sc;
    }
    return {winName, n:w.n, idx,
      bufMax:(()=>{let m=0;for(let i=0;i<w.n;i++){const g=i*3;const v=Math.hypot(buf[g],buf[g+1],buf[g+2]);if(v>m)m=v;}return m;})(),
      rel0, maxResid, maxMoveAll, steps, dist, cam:[S.camWorld.x,S.camWorld.y,S.camWorld.z],
      distToPlanet: Math.hypot(e.world[0]-S.camWorld.x, e.world[1]-S.camWorld.y, e.world[2]-S.camWorld.z)};
  },{when:WHEN,focus:FOCUS,dist:DIST,winName:WIN});

  if(res.err){ console.log('ERR', res.err); await browser.close(); srv.close(); return; }

  console.log(`=== 窗口 ${res.winName}  n=${res.n}  相机距行星 ${res.distToPlanet.toExponential(3)} km  设距 ${res.dist}}`);
  console.log(`缓冲 |buf|max = ${res.bufMax.toExponential(3)} km   →  f32 ULP@p99 量级 ~${(res.bufMax*2**-23).toExponential(2)} km`);
  console.log(`rel0 = [${res.rel0.map(v=>v.toExponential(2)).join(', ')}]`);
  console.log(`\n[B] 相对系重构残差 max|world−planet−rel_true| = ${res.maxResid.toExponential(3)} km  (应 ≈ 0)`);
  console.log(`\n[A] 远视角滑动 12 步（每步 0.03 rad 方位 + 0.008 rad 俯仰）：`);
  console.log(`  k | 世界位移max(km) | 屏幕位移max(px)`);
  for(const s of res.steps) console.log(`  ${String(s.k).padStart(2)} | ${s.mv.toExponential(3)} | ${s.ms.toFixed(3)}`);
  console.log(`\n  ⇒ 全程 世界位移 max = ${res.maxMoveAll.toExponential(3)} km  ${res.maxMoveAll<1e-6?'✓ 完全稳定（无错位）':'⚠ 有位移'}`);

  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
