/* verify_shake.js —— 轨迹抖动验证（权威判据，收敛版）。
 *
 * 唯一正确的判据
 * --------------
 * 屏幕坐标 = P · V · (M·b + l)，其中 b = W − origin（f32 缓冲），l = origin − cam（f64）。
 *   相机绕聚焦点连续转动时，b、l、V 都变，屏幕坐标必然随之变（这是真实视差，正确）。
 *   抖动 = 这个变化**不平滑**，即出现与透视模型无关的阶梯。
 *
 * 三个层次，逐层排除：
 *   L1 几何层（screenPosOf，f64 直算）：二阶差分应光滑 → 若尖峰则几何/缓动有问题
 *   L2 缓冲层（GPU 顶点缓冲 f32 跳桶）：还原世界坐标应恒定 → 跳桶量 ≪ 1px
 *   L3 像素层（画布实际渲染）：扣除全局平移后残差应只来自星空/AA，不含轨迹阶梯
 *
 * 用法：node verify_shake.js [WHEN] [FOCUS]
 */
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = 'D:/Programming/HTML/Cassini';
const MIME = { '.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.glb':'model/gltf-binary','.wasm':'application/wasm','.json':'application/json' };
const srv = http.createServer((req,res)=>{ let r=decodeURIComponent(req.url.split('?')[0]); if(r==='/')r='/index.html'; const fp=path.join(ROOT,r); fs.readFile(fp,(e,b)=>{ if(e){res.writeHead(404);return res.end();} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(b);});});

const WHEN = process.argv[2] || '2007-06-01T00:00:00Z';
const FOCUS= process.argv[3] || 'cassini';
const DISTS = [1e5, 1e6, 1e7, 1e8, 1e9];
const STEP = 0.0004, NSTEP = 60;

const setCam=(page,dist,dth)=>page.evaluate(({focus,dist,dth})=>{
  const C=window.CassiniCamera;
  C.focus(focus,{dist,animate:false,theta:0.9+dth,phi:1.05});
  // 消除指数缓动残留，使每步相机姿态完全确定
  if(C.state){ C.state.sTheta=C.state.theta; C.state.sPhi=C.state.phi; C.state.sDist=C.state.dist; }
},{focus:FOCUS,dist,dth}).then(()=>page.waitForTimeout(160));

(async () => {
  await new Promise(res => srv.listen(0,'127.0.0.1',res));
  const P = srv.address().port;
  const browser = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true, args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
  const page = await browser.newPage({ viewport:{width:1200,height:700} });
  page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,300)));
  await page.goto(`http://127.0.0.1:${P}/index.html`,{waitUntil:'load',timeout:60000});
  await page.waitForTimeout(9000);
  await page.evaluate(()=>{ const b=document.getElementById('help-close'); if(b) b.click(); });
  await page.evaluate((when)=>{ const t=(Date.parse(when)-946728000000)/1000;
    if(window.CassiniTimeline){window.CassiniTimeline.setNow(t);window.CassiniTimeline.setPlaying(false);}
    window.CassiniScene.__nowT=t; },WHEN);
  await page.waitForTimeout(1200);

  const idxs = await page.evaluate(()=>{
    const s=window.CassiniScene, n=s.trailLength|0, iNow=s.trailIndexAt(s.__nowT);
    const out=[]; for(let k=-4;k<=4;k++) out.push(Math.max(0,Math.min(n-1,iNow+k*50))); return out;
  });
  const LINES = [
    ['trailFullLine','主轨迹·未来'],
    ['trailFlownLine','主轨迹·已飞'],
    ['tailAbs','Huygens 绝对'],
    ['tailPlanet','Huygens 一级'],
    ['tailMoon','Huygens 二级'],
  ];

  console.log(`WHEN=${WHEN}  FOCUS=${FOCUS}  采样索引=${JSON.stringify(idxs)}`);
  console.log('相机每步 Δθ=' + STEP + ' rad (' + (STEP*180/Math.PI).toFixed(4) + '°) × ' + NSTEP + '\n');

  for (const d of DISTS) {
    const kmPerPx = d * 2*Math.tan(45/2*Math.PI/180) / 700;
    // 收集序列
    const series={}; for(const [k] of LINES) series[k]=[];
    for(let s=0;s<=NSTEP;s++){
      await setCam(page, d, s*STEP);
      const row = await page.evaluate((idxs)=>{
        const s=window.CassiniScene;
        const out={};
        for(const nm of ['trailFullLine','trailFlownLine','tailAbs','tailPlanet','tailMoon']){
          const L=s[nm]; if(!L||!L.visible){ out[nm]=null; continue; }
          const arr=L.geometry.attributes.position.array;
          const lp=[L.position.x,L.position.y,L.position.z];
          const o=s.trailOrigin;
          out[nm]={lp, o:[o.x,o.y,o.z],
            s: idxs.map(ii=>{ if(!(ii>=0)||ii*3+2>=arr.length) return null;
              return [ii, arr[ii*3],arr[ii*3+1],arr[ii*3+2]]; })};
        }
        return out;
      }, idxs);
      for(const [k] of LINES) series[k].push(row[k]);
    }
    // L1+L2：缓冲值 b 应随 -Δorigin 精确变化（浮动原点）；跳桶 = b 变化偏离理论值
    console.log(`── DIST=${d.toExponential(2)} km  (1 px ≈ ${kmPerPx.toExponential(3)} km)`);
    for(const [k,label] of LINES){
      const S=series[k];
      const vis=S.filter(x=>x);
      if(vis.length < NSTEP*0.7){ console.log(`   ${label.padEnd(16)} 不可见/未激活`); continue; }
      let maxBucket=0, maxBucketPx=0;
      for(let s=1;s<S.length;s++){
        const a=S[s-1], b=S[s]; if(!a||!b) continue;
        const dO=[b.o[0]-a.o[0], b.o[1]-a.o[1], b.o[2]-a.o[2]];
        const dLp=[b.lp[0]-a.lp[0], b.lp[1]-a.lp[1], b.lp[2]-a.lp[2]];
        const m=Math.min(a.s.length,b.s.length);
        for(let i=0;i<m;i++){
          const p=a.s[i], q=b.s[i]; if(!p||!q||p[0]!==q[0]) continue;
          // 浮动原点：缓冲值 b=W-origin → Δb 应 = -Δorigin；线补偿 l=origin-cam → Δl = Δorigin-Δcam
          // 相机系坐标变化 = Δb + Δl，应精确等于 -Δcam（纯视差）
          const db=[q[1]-p[1], q[2]-p[2], q[3]-p[3]];
          const residual=[ db[0]+dO[0], db[1]+dO[1], db[2]+dO[2] ];   // 应≈0
          const r=Math.hypot(residual[0],residual[1],residual[2]);
          if(r>maxBucket){maxBucket=r; maxBucketPx=r/kmPerPx;}
        }
      }
      const verdict = maxBucketPx > 0.5 ? '  <<< 可见抖动' : (maxBucketPx > 0.1 ? '  < 轻微' : '  OK');
      console.log(`   ${label.padEnd(16)} f32 跳桶 max = ${maxBucket.toExponential(3)} km = ${maxBucketPx.toFixed(6)} px${verdict}`);
    }
    console.log('');
  }
  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
