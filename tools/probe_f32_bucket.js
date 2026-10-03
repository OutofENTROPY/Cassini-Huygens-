/* probe_f32_bucket.js —— 直接量化 GPU 路径的 f32 跳桶（真实抖动源）。
 * 真实渲染路径：gl_Position = P * V * (M * aPos + lineOffset)，aPos 为 f32 缓冲。
 *   缓冲值 b = W - origin（f32 存储，跳桶误差 ~ULP(|b|)）
 *   线补偿   l = origin - cam（f64，写入 line.position，Three 内部转 f32 但值很小）
 *   相机系坐标 = b + l。
 * 抖动 = 当 origin 随相机移动、b 跨越 2 的幂边界时，b 的**整桶跳变量**。
 * 判据：|Δb|（连续帧间同一顶点的缓冲值变化量，去掉理论值）相对于 1px 对应公里数。
 *   Δb_理论 = -(Δorigin)（f64 精确）；实际 Δb 偏离理论值的部分 = 量化误差。
 * 用法：node probe_f32_bucket.js [WHEN] [FOCUS] [DIST] [STEPS] [TAG]
 */
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = 'D:/Programming/HTML/Cassini';
const MIME = { '.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.glb':'model/gltf-binary','.wasm':'application/wasm','.json':'application/json' };
const srv = http.createServer((req,res)=>{ let r=decodeURIComponent(req.url.split('?')[0]); if(r==='/')r='/index.html'; const fp=path.join(ROOT,r); fs.readFile(fp,(e,b)=>{ if(e){res.writeHead(404);return res.end();} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(b);});});
const WHEN = process.argv[2] || '2007-06-01T00:00:00Z';
const FOCUS= process.argv[3] || 'cassini';
const TAG  = process.argv[4] || 'bucket';
const WIN  = parseInt(process.argv[5] || '600', 10);
const DISTS = [1e5, 3e5, 1e6, 3e6, 1e7, 3e7, 1e8, 3e8, 1e9];
const DTH   = 0.0016;   // 每步 0.092°

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

  const grab = (dist, dth)=>page.evaluate(({dist,dth,win,n2})=>{
    const C=window.CassiniCamera;
    C.focus('cassini',{dist,animate:false,theta:0.9+dth,phi:1.05});
    if(C.state){ C.state.sTheta=C.state.theta; C.state.sPhi=C.state.phi; C.state.sDist=C.state.dist; }
    return null;
  },{dist,dth,win:WIN,n2:0}).then(()=>page.waitForTimeout(200)).then(()=>page.evaluate((win)=>{
    const s=window.CassiniScene, n=s.trailLength|0, iNow=s.trailIndexAt(s.__nowT);
    const tf=s.trailFullLine, tw=s.trailFlownLine;
    const o=s.trailOrigin, cam=s.camWorld;
    const pick=(line)=>{ if(!line) return null; const arr=line.geometry.attributes.position.array;
      return {arr: Array.from(arr.subarray(0,600)), lp:[line.position.x,line.position.y,line.position.z]}; };
    const V=[];
    for(let k=0;k<=30;k++){ const ii=Math.max(0,Math.min(n-1,iNow-win+Math.round(k*2*win/30)));
      V.push(ii); }
    const A=tf?tf.geometry.attributes.position.array:null;
    const lp=[tf.position.x,tf.position.y,tf.position.z];
    return {o:[o.x,o.y,o.z], cam:[cam.x,cam.y,cam.z], lp,
      samp: V.map(ii=>[ii, A[ii*3], A[ii*3+1], A[ii*3+2], s.trailWorldAt(ii)])};
  }, WIN));

  console.log(`WHEN=${WHEN} FOCUS=${FOCUS}  每步 Δθ=${DTH}rad (${(DTH*180/Math.PI).toFixed(4)}°)`);
  console.log('dist(km)  km/px   跳桶(km)   跳桶(px)   [对照]无浮动原点理论跳桶(km) (px)');
  for(const d of DISTS){
    // 连续 6 步扫描，取相邻步的缓冲值变化
    const frames=[]; let lastQ=null;
    for(let s=0;s<6;s++){
      await page.evaluate(({dist,dth})=>{ const C=window.CassiniCamera;
        C.focus('cassini',{dist,animate:false,theta:0.9+dth,phi:1.05});
        if(C.state){C.state.sTheta=C.state.theta;C.state.sPhi=C.state.phi;C.state.sDist=C.state.dist;} },{dist:d,dth:s*DTH});
      await page.waitForTimeout(200);
      const f=await page.evaluate((win)=>{
        const s=window.CassiniScene, n=s.trailLength|0, iNow=s.trailIndexAt(s.__nowT);
        const tf=s.trailFullLine, o=s.trailOrigin, cam=s.camWorld;
        const A=tf.geometry.attributes.position.array;
        const V=[]; for(let k=0;k<=30;k++){ V.push(Math.max(0,Math.min(n-1,iNow-win+Math.round(k*2*win/30)))); }
        return {o:[o.x,o.y,o.z], cam:[cam.x,cam.y,cam.z],
          S: V.map(ii=>[ii, A[ii*3],A[ii*3+1],A[ii*3+2], s.trailWorldAt(ii)])};
      }, WIN);
      frames.push(f);
    }
    const kmPerPx = d * 2*Math.tan(45/2*Math.PI/180)/900;
    let maxJit=0, maxTheory=0;
    for(let s=1;s<frames.length;s++){
      const P0=frames[s-1], P1=frames[s];
      const dO=[P1.o[0]-P0.o[0], P1.o[1]-P0.o[1], P1.o[2]-P0.o[2]];
      const dCam=[P1.cam[0]-P0.cam[0], P1.cam[1]-P0.cam[1], P1.cam[2]-P0.cam[2]];
      const m=Math.min(P0.S.length,P1.S.length);
      for(let k=0;k<m;k++){
        const a=P0.S[k], b=P1.S[k];
        if(a[0]!==b[0]) continue;
        // 浮动原点：缓冲值变化应 = -dO（因为 b = W - o，W 固定）
        const db=[ b[1]-a[1]-( -dO[0] ), b[2]-a[2]-(-dO[1]), b[3]-a[3]-(-dO[2]) ];
        const j=Math.hypot(db[0],db[1],db[2]);
        if(j>maxJit)maxJit=j;
        // 对照：无浮动原点（b' = W - cam），跳桶 = |W-cam| 量化步长
        const wp=a[4]; if(wp){
          const bc0=[wp[0]-P0.cam[0], wp[1]-P0.cam[1], wp[2]-P0.cam[2]];
          const bc1=[wp[0]-P1.cam[0], wp[1]-P1.cam[1], wp[2]-P1.cam[2]];
          const ub=Math.max(Math.abs(bc0[0]),Math.abs(bc0[1]),Math.abs(bc0[2]));
          const ulp=Math.pow(2,-23)*2*Math.pow(2,Math.ceil(Math.log2(ub)));
          if(ulp>maxTheory)maxTheory=ulp;
        }
      }
    }
    const flag = maxJit/kmPerPx > 0.5 ? '  <<< 可见' : (maxJit/kmPerPx > 0.1 ? '  < 轻微' : '  OK');
    console.log(`${d.toExponential(2).padStart(8)} ${kmPerPx.toExponential(2).padStart(8)} ${maxJit.toExponential(3).padStart(10)} ${(maxJit/kmPerPx).toFixed(5).padStart(10)} ${maxTheory.toExponential(3).padStart(16)} ${(maxTheory/kmPerPx).toFixed(3).padStart(9)}${flag}`);
  }
  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
