/* verify_seam_all.js —— 在多个历元批量验证「past/tail/full 三段共线」与
 * 「尾迹终点贴合标记」。任一场景折角 > 1.5° 或终点偏离 > 0.5 px 即 FAIL。
 */
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = 'D:/Programming/HTML/Cassini';
const MIME = { '.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.glb':'model/gltf-binary','.wasm':'application/wasm','.json':'application/json' };
const srv = http.createServer((req,res)=>{ let r=decodeURIComponent(req.url.split('?')[0]); if(r==='/')r='/index.html'; const fp=path.join(ROOT,r); fs.readFile(fp,(e,b)=>{ if(e){res.writeHead(404);return res.end();} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(b);});});

const CASES = [
  ['1997-10-15T11:40:00Z', 'earth',   1.2e7,  'launch'],
  ['1997-10-20T00:00:00Z', 'earth',   5.0e6,  'escape'],
  ['1998-04-26T00:00:00Z', 'venus',   3.0e6,  'venus1'],
  ['1999-08-18T00:00:00Z', 'earth',   3.0e6,  'earthflyby'],
  ['2000-12-30T00:00:00Z', 'jupiter', 1.5e7,  'jupiter'],
  ['2004-07-01T00:00:00Z', 'saturn',  5.0e6,  'soi'],
  ['2005-01-14T10:00:00Z', 'titan',   5.0e5,  'huygens'],
  ['2010-06-01T00:00:00Z', 'saturn',  2.0e6,  'mid'],
  ['2017-09-15T00:00:00Z', 'saturn',  2.0e5,  'finale'],
  ['2017-04-26T00:00:00Z', 'saturn',  1.0e5,  'ringgap'],
];

const SAMPLE = () => {
  const s = window.CassiniScene, cw = s.camWorld;
  const px = w => s.screenPosOf(w);
  const P = (line,i) => { const a=line.geometry.attributes.position,o=line.position;
    return px([a.getX(i)+o.x+cw.x, a.getY(i)+o.y+cw.y, a.getZ(i)+o.z+cw.z]); };
  const ang=(a,b)=>Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI;
  const res={};
  const fl=s.trailFlownLine, fu=s.trailFullLine, ta=s.tailAbs;
  const drF=fl.geometry.drawRange, drT=ta.geometry.drawRange, drU=fu.geometry.drawRange;
  const fEnd=drF.start+drF.count-1, tEnd=drT.start+drT.count-1;
  // tail 与 flown 重叠区（tail 起点 == flown 末点），用 tail 中段与 flown 末段比角度
  const flA=P(fl,Math.max(drF.start,fEnd-6)), flB=P(fl,fEnd);
  const taA=P(ta,drT.start+2), taB=P(ta,tEnd);
  res.angFlown=ang(flA,flB); res.angTail=ang(taA,taB);
  let fuA=null,fuB=null;
  if (fu.visible && drU.count>6) { fuA=P(fu,drU.start); fuB=P(fu,Math.min(drU.start+6,drU.start+drU.count-1)); res.angFull=ang(fuA,fuB); }
  const d=(a,b)=>{ if(a==null||b==null) return null; let x=Math.abs(a-b)%180; if(x>90)x=180-x; return x; };
  res.kinkFlownTail=d(res.angFlown,res.angTail);
  res.kinkTailFull=d(res.angTail,res.angFull);
  const mk=s.cassiniMarker;
  res.markerPx=px([mk.position.x+cw.x,mk.position.y+cw.y,mk.position.z+cw.z]);
  res.tailEndPx=P(ta,tEnd);
  res.tailEndDev=Math.hypot(res.markerPx.x-res.tailEndPx.x, res.markerPx.y-res.tailEndPx.y);
  // tail 端点世界 vs 标记世界
  const a=ta.geometry.attributes.position,o=ta.position;
  res.tailEndWorldDev=Math.hypot(
    a.getX(tEnd)+o.x+cw.x-(mk.position.x+cw.x),
    a.getY(tEnd)+o.y+cw.y-(mk.position.y+cw.y),
    a.getZ(tEnd)+o.z+cw.z-(mk.position.z+cw.z));
  res.tailVerts=drT.count; res.flownVerts=drF.count; res.fullVerts=fu.visible?drU.count:0;
  res.behind=res.markerPx.behind;
  return res;
};

(async () => {
  srv.listen(8914,'127.0.0.1'); await new Promise(r=>setTimeout(r,700));
  const browser = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true, args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
  const page = await browser.newPage({ viewport:{width:1600,height:900} });
  const errs=[];
  page.on('pageerror',e=>errs.push(String(e).slice(0,160)));
  await page.goto('http://127.0.0.1:8914/index.html',{waitUntil:'load',timeout:60000});
  await page.waitForTimeout(10000);
  await page.evaluate(()=>{ if(window.CassiniScene) window.CassiniScene.setTrailOptions({future:true, mode:'all', cassini:true, planetOrbits:true}); });

  let fail=0;
  console.log('epoch                 focus     kink(f/t)  kink(t/u)  tailEndPx   tailEndWorldKm  verts');
  for (const [when,focus,dist,tag] of CASES) {
    await page.evaluate(({when,focus,dist})=>{
      const t=(Date.parse(when)-946728000000)/1000;
      if(window.CassiniTimeline){window.CassiniTimeline.setNow(t);window.CassiniTimeline.setPlaying(false);}
      if(window.CassiniCamera) window.CassiniCamera.focus(focus,{dist,animate:false,theta:0.9,phi:1.05});
    },{when,focus,dist});
    await page.waitForTimeout(1800);
    const r = await page.evaluate(SAMPLE);
    const fmt=v=>v==null?'  n/a  ':v.toFixed(3).padStart(7);
    const k1=r.kinkFlownTail, k2=r.kinkTailFull;
    const bad = (k1!=null&&k1>1.5) || (k2!=null&&k2>1.5) || r.tailEndDev>0.5 || r.tailEndWorldDev>500;
    if(bad) fail++;
    console.log(`${when}  ${focus.padEnd(8)} ${fmt(k1)}   ${fmt(k2)}   ${r.tailEndDev.toFixed(4).padStart(8)}   ${r.tailEndWorldDev.toFixed(1).padStart(12)}  ${r.flownVerts}/${r.tailVerts}/${r.fullVerts}${bad?'   <<< FAIL':''}`);
  }
  console.log(`\n${fail===0?'全部通过':'存在 '+fail+' 处失败'}`);
  if(errs.length) console.log('pageerror:', errs.slice(0,3));
  await browser.close(); srv.close();
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e);process.exit(1);});
