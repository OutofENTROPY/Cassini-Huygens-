/* probe_shake_buf.js —— 只测「顶点缓冲 f32 量化抖动」。
 * 原理：顶点缓冲 = [世界 − trailOrigin]（f32 存储）。同一顶点在世界系是不动的，
 *       若把它的缓冲值 + trailOrigin 还原成世界坐标，在任意可能原点下都应几乎相同；
 *       而屏幕位置 = (缓冲值 + trailOrigin − camWorld) 投影。
 *       抖动来源 = 缓冲值 f32 量化随 trailOrigin 变化而「跳桶」。
 * 判据：还原世界坐标 W_i(shot) 的跨帧差 ΔW 应 ≪ 屏幕 1 px 对应公里数。
 *       同时给出「若不用浮动原点（直接写 世界−camWorld）」的对照 ΔW_direct。
 * 用法：node probe_shake_buf.js [WHEN] [FOCUS] [DIST] [TAG]
 */
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = 'D:/Programming/HTML/Cassini';
const OUT = path.join(ROOT, 'tools/shots');
const MIME = { '.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.glb':'model/gltf-binary','.wasm':'application/wasm','.json':'application/json' };
const srv = http.createServer((req,res)=>{ let r=decodeURIComponent(req.url.split('?')[0]); if(r==='/')r='/index.html'; const fp=path.join(ROOT,r); fs.readFile(fp,(e,b)=>{ if(e){res.writeHead(404);return res.end();} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(b);});});

const WHEN = process.argv[2] || '2004-06-11T00:00:00Z';
const FOCUS = process.argv[3] || 'saturn';
const DIST = parseFloat(process.argv[4] || '1.2e9');
const TAG = process.argv[5] || 'shkbuf';
const DTHS = [0, 0.002, 0.004, 0.006, 0.008, 0.012, 0.02];   // 走一遍连续拖拽

(async () => {
  await new Promise(res => srv.listen(0,'127.0.0.1',res));
  const PORT = srv.address().port;
  const browser = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true, args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
  const page = await browser.newPage({ viewport:{width:1600,height:900} });
  page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,300)));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'load',timeout:60000});
  await page.waitForTimeout(9000);
  await page.evaluate(()=>{ const b=document.getElementById('help-close'); if(b) b.click(); });
  await page.waitForTimeout(800);
  await page.evaluate(({when,focus,dist})=>{
    const t=(Date.parse(when)-946728000000)/1000;
    if(window.CassiniTimeline){window.CassiniTimeline.setNow(t);window.CassiniTimeline.setPlaying(false);}
    if(window.CassiniCamera) window.CassiniCamera.focus(focus,{dist,animate:false,theta:0.9,phi:1.05});
  },{when:WHEN,focus:FOCUS,dist:DIST});
  await page.waitForTimeout(3000);

  const rows=[];
  for (const dth of DTHS) {
    await page.evaluate(({focus,dist,dth})=>{
      if(window.CassiniCamera) window.CassiniCamera.focus(focus,{dist,animate:false,theta:0.9+dth,phi:1.05});
    },{focus:FOCUS,dist:DIST,dth});
    await page.waitForTimeout(900);
    const st = await page.evaluate(()=>{
      const s=window.CassiniScene;
      const tf=s.trailFullLine;
      const o=s.trailOrigin, cam=s.camWorld;
      const n=s.trailLength|0;
      const arr=tf.geometry.attributes.position.array;
      // 采样：均匀取 24 个索引
      const idxs=[]; for(let k=1;k<=24;k++){ const ii=Math.round((n-1)*k/25); if(ii>0&&ii<n) idxs.push(ii); }
      const rec=idxs.map(ii=>{
        const bx=arr[ii*3], by=arr[ii*3+1], bz=arr[ii*3+2];        // f32 缓冲值
        const w=[bx+o.x, by+o.y, bz+o.z];                          // 还原世界
        const wp=s.trailWorldAt(ii)||[0,0,0];               // 参考世界（f64）
        const lx=tf.position.x, ly=tf.position.y, lz=tf.position.z; // 线对象补偿
        return {ii, b:[bx,by,bz], w, wp, l:[lx,ly,lz],
                camRel:[bx+lx, by+ly, bz+lz]};                     // 相机系坐标（实际送渲染）
      });
      return {idxCount:n, camWorld:[cam.x,cam.y,cam.z], origin:[o.x,o.y,o.z], rec};
    });
    rows.push({dth, st});
  }

  // 跨帧对比
  const base=rows[0].st, last=rows[rows.length-1].st;
  const scaleOf = (dist)=> dist * 2 * Math.tan((45/2)*Math.PI/180) / 900;   // km per pix（fov45,vh900）
  const kmPerPx = scaleOf(DIST);
  console.log(`WHEN=${WHEN} FOCUS=${FOCUS} DIST=${DIST.toExponential(2)} km  约 ${kmPerPx.toExponential(3)} km/px`);
  console.log(`camWorld0=${base.camWorld.map(v=>v.toExponential(4)).join(',')}`);
  console.log(`origin0  =${base.origin.map(v=>v.toExponential(4)).join(',')}`);
  console.log(`originN  =${last.origin.map(v=>v.toExponential(4)).join(',')}`);

  let maxRestore=0, maxRestoreI=-1, maxDirect=0, maxDirectI=-1, maxCamRel=0;
  const NR=base.rec.length;

  for(let k=0;k<NR;k++){
    const A=base.rec[k], B=last.rec[k];
    // 浮动原点方案：还原世界坐标差
    const dr=Math.hypot(A.w[0]-B.w[0],A.w[1]-B.w[1],A.w[2]-B.w[2]);
    if(dr>maxRestore){maxRestore=dr;maxRestoreI=A.ii;}
    // 对照：若直接写 世界−camWorld（无浮动原点），则渲染值为 wp−cam，跳桶步长
    const dd=Math.hypot(A.wp[0]-base.camWorld[0]-(B.wp[0]-last.camWorld[0]),
                        A.wp[1]-base.camWorld[1]-(B.wp[1]-last.camWorld[1]),
                        A.wp[2]-base.camWorld[2]-(B.wp[2]-last.camWorld[2]));
    if(dd>maxDirect){maxDirect=dd;maxDirectI=A.ii;}
    // 相机系坐标差（实际渲染输入）
    const dc=Math.hypot(A.camRel[0]-B.camRel[0],A.camRel[1]-B.camRel[1],A.camRel[2]-B.camRel[2]);
    if(dc>maxCamRel) maxCamRel=dc;
  }
  console.log(`\n[浮动原点] 还原世界坐标最大跳变 = ${maxRestore.toExponential(3)} km @ i=${maxRestoreI}  = ${(maxRestore/kmPerPx).toFixed(4)} px等价`);
  console.log(`[相机系渲染值] 最大跳变         = ${maxCamRel.toExponential(3)} km = ${(maxCamRel/kmPerPx).toFixed(4)} px等价`);
  console.log(`[对照·无浮动原点] 理论跳桶步长   = ${maxDirect.toExponential(3)} km = ${(maxDirect/kmPerPx).toFixed(4)} px等价`);
  // f32 ULP 参考
  const rad=Math.hypot(base.origin[0],base.origin[1],base.origin[2]);
  console.log(`\ntrailOrigin 模长 = ${rad.toExponential(4)} km；f32 ULP ≈ ${(rad*Math.pow(2,-23)).toExponential(3)} km（单桶宽）`);
  console.log(`=> 一屏 900 px 覆盖 ${(900*kmPerPx).toExponential(3)} km，1 桶 ≈ ${((rad*Math.pow(2,-23))/kmPerPx).toFixed(3)} px`);
  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
