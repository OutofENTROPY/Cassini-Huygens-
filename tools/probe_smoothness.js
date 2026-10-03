/* probe_smoothness.js —— 最终判据：屏幕坐标对 θ 的「平滑性」。
 * 原理：相机绕聚焦点连续转动时，任何顶点的屏幕坐标都应是 θ 的**平滑单调函数**。
 *   - 纯透视 → 平滑曲线（一阶导连续）
 *   - f32 量化抖动 → 曲线上出现**阶梯跳变**（二阶差分出现孤立尖峰）
 * 测法：θ 以极小步长扫描（例如 0.0005 rad × 60 步），记录某顶点屏位的
 *   一阶差分 Δ与二阶差分 Δ²。抖动 = |Δ²| 远大于局部典型值且呈尖峰。
 * 用法：node probe_smoothness.js [WHEN] [DIST] [TAG]
 */
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = 'D:/Programming/HTML/Cassini';
const MIME = { '.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.glb':'model/gltf-binary','.wasm':'application/wasm','.json':'application/json' };
const srv = http.createServer((req,res)=>{ let r=decodeURIComponent(req.url.split('?')[0]); if(r==='/')r='/index.html'; const fp=path.join(ROOT,r); fs.readFile(fp,(e,b)=>{ if(e){res.writeHead(404);return res.end();} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(b);});});
const WHEN = process.argv[2] || '2007-06-01T00:00:00Z';
const DIST = parseFloat(process.argv[3] || '1e7');
const TAG  = process.argv[4] || 'smooth';
const NSTEP = 80, DTH = 0.0004;   // 总跨度 0.032 rad ≈ 1.83°
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
  await page.waitForTimeout(1500);
  // 预热 + 固定一组采样顶点索引
  await page.evaluate(({dist})=>{ window.CassiniCamera.focus('cassini',{dist,animate:false,theta:0.9,phi:1.05}); },{dist:DIST});
  await page.waitForTimeout(2500);
  const idxs = await page.evaluate(()=>{
    const s=window.CassiniScene, n=s.trailLength|0, iNow=s.trailIndexAt(s.__nowT);
    const out=[];
    for(let k=-5;k<=5;k++){ const ii=Math.max(0,Math.min(n-1,iNow+k*40)); out.push(ii); }
    return out;
  });
  console.log(`WHEN=${WHEN} DIST=${DIST.toExponential(2)}  采样索引=${JSON.stringify(idxs)}  步长=${DTH}rad×${NSTEP}`);

  const series = [];   // series[step] = [ [ii,x,y], ... ]  (相对聚焦点屏位)
  for(let s=0;s<=NSTEP;s++){
    const dth=s*DTH;
    await page.evaluate(({dist,dth})=>{
      const C=window.CassiniCamera;
      C.focus('cassini',{dist,animate:false,theta:0.9+dth,phi:1.05});
      // 关键：直接把平滑角同步到目标角，消除指数缓动的收敛残留，
      // 使每步的相机姿态完全确定（否则测的是缓动曲线而非渲染误差）。
      if (C.state) { C.state.sTheta = C.state.theta; C.state.sPhi = C.state.phi; C.state.sDist = C.state.dist; }
    },{dist:DIST,dth});
    await page.waitForTimeout(150);
    const row = await page.evaluate((idxs)=>{
      const s=window.CassiniScene;
      const cass=s.cassWorld; const f=s.screenPosOf([cass[0],cass[1],cass[2]]);
      return idxs.map(ii=>{ const w=s.trailWorldAt(ii); const p=s.screenPosOf(w);
        return [ii, p.x-f.x, p.y-f.y, p.behind?1:0]; });
    }, idxs);
    series.push(row);
  }

  // 分析每个顶点：一阶差分与二阶差分
  console.log('\nidx        一阶Δ范围        二阶|Δ²|max   二阶|Δ²|中位    尖峰比    判定');
  for(let j=0;j<idxs.length;j++){
    const ii=idxs[j];
    const xs=[], ys=[];
    let ok=true;
    for(const row of series){ const e=row[j]; if(!e||e[3]){ok=false;break;} xs.push(e[1]); ys.push(e[2]); }
    if(!ok||xs.length<10){ console.log(`${String(ii).padStart(8)}  (数据不足/被遮挡)`); continue; }
    const d1=[], d2=[];
    for(let i=1;i<xs.length;i++) d1.push(Math.hypot(xs[i]-xs[i-1], ys[i]-ys[i-1]));
    for(let i=1;i<d1.length;i++) d2.push(Math.abs(d1[i]-d1[i-1]));
    const d1min=Math.min(...d1), d1max=Math.max(...d1);
    const d2max=Math.max(...d2);
    const srt=[...d2].sort((a,b)=>a-b);
    const med=srt[Math.floor(srt.length/2)];
    const ratio = med>1e-9 ? d2max/med : (d2max>1e-9?Infinity:0);
    const verdict = (d2max>0.02 && ratio>8) ? '  <<< 阶梯跳变(抖动)' : (d2max>0.005?'  < 轻微':'  OK');
    console.log(`${String(ii).padStart(8)}  [${d1min.toFixed(5)}, ${d1max.toFixed(5)}]  ${d2max.toFixed(6).padStart(10)}  ${med.toFixed(6).padStart(10)}  ${ratio.toFixed(2).padStart(8)}${verdict}`);
  }
  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
