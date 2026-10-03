/* probe_shake.js —— 在给定历元聚焦某天体，输出多组相机位置下的轨迹顶点数据。
 * 目的：验证「远相机时轨迹随视角晃动」= 平移误差 ∝ 距离 的假设。
 *
 * 判据（浮动原点正确性）：
 *   1) 每个顶点的**屏幕坐标**在 3 个小角度偏移的相机下应几乎不变（拖视角=绕目标
 *      转，屏幕位置只应随视差微动，不应出现整条轨迹跳动/闪烁）。
 *   2) 轨迹线对象 position 补偿量 |position − (trailOrigin − camWorld)| ≈ 0。
 *   3) huygens 三条线（abs/sat/tit）的 position 与主轨迹一致（同浮动原点）。
 *
 * 用法：node probe_shake.js [WHEN] [FOCUS] [DIST] [TAG]
 */
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = 'D:/Programming/HTML/Cassini';
const OUT = path.join(ROOT, 'tools/shots');
const MIME = { '.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.glb':'model/gltf-binary','.wasm':'application/wasm','.json':'application/json' };
const srv = http.createServer((req,res)=>{ let r=decodeURIComponent(req.url.split('?')[0]); if(r==='/')r='/index.html'; const fp=path.join(ROOT,r); fs.readFile(fp,(e,b)=>{ if(e){res.writeHead(404);return res.end();} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(b);});});

const WHEN = process.argv[2] || '2004-06-11T00:00:00Z';   // 土星轨道段（远视角最苛刻）
const FOCUS = process.argv[3] || 'saturn';
const DIST = parseFloat(process.argv[4] || '1.2e9');
const TAG = process.argv[5] || 'shake';

const DTHS = [0, 0.004, 0.008];   // 相机方位角微偏移（弧度，约 0.23°/0.46°）

(async () => {
  await new Promise(res => srv.listen(0,'127.0.0.1',res));
  const PORT = srv.address().port;
  const browser = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true, args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
  const page = await browser.newPage({ viewport:{width:1600,height:900} });
  page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,300)));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'load',timeout:60000});
  await page.waitForTimeout(9000);
  // 关掉欢迎层，避免遮挡 canvas
  await page.evaluate(()=>{ const b=document.getElementById('help-close'); if(b) b.click(); });
  await page.waitForTimeout(800);

  await page.evaluate(({when,focus,dist})=>{
    const t=(Date.parse(when)-946728000000)/1000;
    if(window.CassiniTimeline){window.CassiniTimeline.setNow(t);window.CassiniTimeline.setPlaying(false);}
    if(window.CassiniCamera) window.CassiniCamera.focus(focus,{dist,animate:false,theta:0.9,phi:1.05});
  },{when:WHEN,focus:FOCUS,dist:DIST});
  await page.waitForTimeout(3000);

  const shots=[];
  for (let i=0;i<DTHS.length;i++) {
    const dth = DTHS[i];
    await page.evaluate(({focus,dist,dth})=>{
      if(window.CassiniCamera) window.CassiniCamera.focus(focus,{dist,animate:false,theta:0.9+dth,phi:1.05});
    },{focus:FOCUS,dist:DIST,dth});
    await page.waitForTimeout(1300);
    const st = await page.evaluate(()=>{
      const s=window.CassiniScene;
      const tf=s.trailFullLine, tw=s.trailFlownLine;
      const cam=s.camera;
      const o=s.trailOrigin;
      const camW=s.camWorld;
      const expect = o ? [o.x-camW.x, o.y-camW.y, o.z-camW.z] : null;
      const posOf = (l)=> l ? [l.position.x,l.position.y,l.position.z] : null;
      const devOf = (l)=>{ if(!l||!expect) return null;
        return Math.hypot(l.position.x-expect[0], l.position.y-expect[1], l.position.z-expect[2]); };
      // 采若干活跃顶点的屏幕坐标
      const n = s.trailLength|0;
      const idxs = [];
      if (n > 100) { for (let k=1;k<=8;k++){ const ii = Math.round((n-1)*Math.min(1, k/9 + 0.05)); if(ii>0&&ii<n) idxs.push(ii); } }
      const scr = idxs.map(ii=>{ const p = s.screenPosOf(s.trailWorldAt ? s.trailWorldAt(ii) : [0,0,0]); return [ii, +p.x.toFixed(2), +p.y.toFixed(2), p.behind?1:0]; });
      return {
        camWorld:[camW.x,camW.y,camW.z],
        trailOrigin: o?[o.x,o.y,o.z]:null,
        expect,
        fullPos: posOf(tf), flownPos: posOf(tw),
        fullDev: devOf(tf), flownDev: devOf(tw),
        fullDraw: tf?{start:tf.geometry.drawRange.start,count:tf.geometry.drawRange.count}:null,
        scr,
      };
    });
    const p = path.join(OUT,`shake_${TAG}_${i}.png`);
    await page.screenshot({path:p});
    shots.push({i,dth,st,p});
  }

  console.log('=== camera offsets: ' + DTHS.map(d=>(d*180/Math.PI).toFixed(3)+'°').join(' / '));
  for(const s of shots){
    const st=s.st;
    console.log(`SHOT ${s.i} dth=${s.dth} cam=${st.camWorld.map(v=>v.toExponential(3)).join(',')}`);
    console.log(`   trailOrigin=${st.trailOrigin.map(v=>v.toExponential(3)).join(',')}`);
    console.log(`   line.position dev from (origin-cam): full=${st.fullDev!=null?st.fullDev.toExponential(3):'n/a'} flown=${st.flownDev!=null?st.flownDev.toExponential(3):'n/a'}`);
    console.log(`   screenPts=${JSON.stringify(st.scr)}`);
  }
  // 跨帧屏幕上同一顶点的位移
  if (shots.length>=2){
    const A=shots[0].st.scr, B=shots[shots.length-1].st.scr;
    let mx=0, mxi=-1;
    for(let k=0;k<Math.min(A.length,B.length);k++){
      const d=Math.hypot(A[k][1]-B[k][1], A[k][2]-B[k][2]);
      if(d>mx){mx=d;mxi=A[k][0];}
    }
    console.log(`=== max screen displacement between shot0 and shot${shots.length-1}: ${mx.toFixed(3)} px @ i=${mxi}`);
  }
  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
