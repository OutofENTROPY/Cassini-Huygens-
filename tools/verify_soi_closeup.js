/* verify_soi_closeup.js —— 近场精度验证：SOI 相对轨迹与主（日心）轨迹在飞船处
 * 的几何一致性 + 相对轨迹自身的光滑度（无 f32 台阶）。
 *
 * 判据 1（拼接一致性）：在窗口内取若干采样时刻 t_k，用 cassiniPosAt(t_k) 得到飞船
 *   真实世界位置；相对轨迹在对应顶点处的世界位置应落在飞船附近（沿轨迹），
 *   二者之差 = 该时刻相对轨迹的插值残差，应 ≤ trail 弦差（30 km）。
 * 判据 2（光滑度）：相对轨迹顶点的一阶差分（步长）不应出现 f32 量化引起的
 *   锯齿——以二阶差分幅值衡量，应 ~ 曲率量级而非量化步长量级。
 * 用法：node verify_soi_closeup.js [WHEN] [WINNAME]
 */
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = 'D:/Programming/HTML/Cassini';
const MIME = { '.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.glb':'model/gltf-binary','.wasm':'application/wasm','.json':'application/json' };
const srv = http.createServer((req,res)=>{ let r=decodeURIComponent(req.url.split('?')[0]); if(r==='/')r='/index.html'; const fp=path.join(ROOT,r); fs.readFile(fp,(e,b)=>{ if(e){res.writeHead(404);return res.end();} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(b);});});
const WHEN=process.argv[2]||'2004-06-20T00:00:00Z';
const WIN=process.argv[3]||'saturn';
const pad=(s,l)=>String(s).padEnd(l);

(async()=>{
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const P=srv.address().port;
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1400,height:800}});
  page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,300)));
  await page.goto(`http://127.0.0.1:${P}/index.html`,{waitUntil:'load',timeout:60000});
  await page.waitForTimeout(9000);
  await page.evaluate(()=>{const b=document.getElementById('help-close');if(b)b.click();});

  const res=await page.evaluate(({when,winName})=>{
    const OFF=65, t=(Date.parse(when)-946728000000)/1000+OFF;
    const S=window.CassiniScene, C=window.CassiniCamera;
    const frame=()=>{const {cassWorld}=S.updatePositions(t);
      const cache={}; for(const [n,e] of S.registry) cache[n]=e.world; cache.cassini=cassWorld;
      try{C.update(performance.now(),cache,cassWorld,S);}catch(e){}
      S.updateRender(t);};
    if(window.CassiniTimeline){window.CassiniTimeline.setNow(t);window.CassiniTimeline.setPlaying(false);}
    frame(); C.focus(winName,{dist:2e5,animate:false}); if(C.state)C.state.sDist=2e5; frame();

    const sp=S.soiPlanets.get(winName); if(!sp) return {err:'no win'};
    const e=sp.entry; let w=null;
    for(const x of sp.wins){if(x.full.visible||x.flown.visible){w=x;break;}}
    if(!w) w=sp.wins[0];
    const buf=w.full.geometry.attributes.position.array, rel0=w.rel0||[0,0,0];

    // 渲染世界坐标 = camWorld + position + buf
    const c=S.camWorld;
    const worldAt=i=>{const g=i*3;return [c.x+w.full.position.x+buf[g], c.y+w.full.position.y+buf[g+1], c.z+w.full.position.z+buf[g+2]];};

    // 判据 1：与飞船位置比对（每个采样点找最近顶点）
    const samples=[];
    for(let f=0.1;f<0.95;f+=0.05){
      const i=Math.min(w.n-1,Math.floor((w.i0 + f*w.n - w.i0)));
      const ti=S.trailT[w.i0+i];
      const cw=S.cassiniPosAt(ti, [0,0,0]);  // 飞船真实世界位置（three 系）
      if(!cw) continue;
      const ww=worldAt(i);
      const d=Math.hypot(ww[0]-cw[0],ww[1]-cw[1],ww[2]-cw[2]);
      samples.push({i, t:ti, gap:d});
    }
    samples.sort((a,b)=>b.gap-a.gap);

    // 判据 2：二阶差分（光滑度）。步长 = |P[i+1]-P[i]|，二阶 = |P[i+1]-2P[i]+P[i-1]|
    const step=[], sec=[];
    const N=Math.min(w.n, 20000);
    for(let i=1;i<N;i++){const a=worldAt(i-1),b=worldAt(i);step.push(Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]));}
    for(let i=1;i<N-1;i++){const a=worldAt(i-1),b=worldAt(i),d=worldAt(i+1);
      sec.push(Math.hypot(d[0]-2*b[0]+a[0], d[1]-2*b[1]+a[1], d[2]-2*b[2]+a[2]));}
    const q=(arr,p)=>{const s=arr.slice().sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(p*s.length))];};
    return {winName, n:w.n, rel0, bufMax:(()=>{let m=0;for(let i=0;i<w.n;i++){const g=i*3;const v=Math.hypot(buf[g],buf[g+1],buf[g+2]);if(v>m)m=v;}return m;})(),
      maxGap:samples[0]?samples[0].gap:0, gapBad:samples.filter(s=>s.gap>30).length, nsamp:samples.length,
      stepP50:q(step,.5), stepP99:q(step,.99), secP50:q(sec,.5), secP99:q(sec,.99)};
  },{when:WHEN,winName:WIN});

  if(res.err){console.log('ERR',res.err);await browser.close();srv.close();return;}
  console.log(`=== 窗口 ${res.winName} n=${res.n}  缓冲 |buf|max=${res.bufMax.toExponential(3)} km`);
  console.log(`  rel0=[${res.rel0.map(v=>v.toExponential(2)).join(', ')}]`);
  console.log(`\n[判据1] 相对轨迹顶点 vs 飞船真实位置：${res.nsamp} 采样，max gap = ${res.maxGap.toExponential(3)} km，>30 km 者 ${res.gapBad} 个`);
  console.log(`[判据2] 顶点步长 p50=${res.stepP50.toExponential(3)} km p99=${res.stepP99.toExponential(3)} km`);
  console.log(`        二阶差分 p50=${res.secP50.toExponential(3)} km p99=${res.secP99.toExponential(3)} km  (应为曲率量级，非 f32 台阶)`);
  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
