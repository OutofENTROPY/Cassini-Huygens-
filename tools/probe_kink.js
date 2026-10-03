/* probe_kink.js —— 精确测量 Cassini 处「past / tail / future」三段接缝的屏幕角度差。
 * 输出：各段方向向量与夹角（度），以及标记到各线端点的像素偏差。
 */
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = 'D:/Programming/HTML/Cassini';
const MIME = { '.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.glb':'model/gltf-binary','.wasm':'application/wasm','.json':'application/json' };
const srv = http.createServer((req,res)=>{ let r=decodeURIComponent(req.url.split('?')[0]); if(r==='/')r='/index.html'; const fp=path.join(ROOT,r); fs.readFile(fp,(e,b)=>{ if(e){res.writeHead(404);return res.end();} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(b);});});
const WHEN = process.argv[2] || '1997-10-15T11:40:00Z';
const FOCUS = process.argv[3] || 'earth';
const DIST = parseFloat(process.argv[4] || '1.2e7');
const MODE = process.argv[5] || 'recent';

(async () => {
  srv.listen(8913,'127.0.0.1'); await new Promise(r=>setTimeout(r,700));
  const browser = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true, args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
  const page = await browser.newPage({ viewport:{width:1600,height:900} });
  page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,300)));
  await page.goto('http://127.0.0.1:8913/index.html',{waitUntil:'load',timeout:60000});
  await page.waitForTimeout(10000);
  await page.evaluate(({when,focus,dist,mode})=>{
    const t=(Date.parse(when)-946728000000)/1000;
    if(window.CassiniScene) window.CassiniScene.setTrailOptions({future:true, mode});
    if(window.CassiniTimeline){window.CassiniTimeline.setNow(t);window.CassiniTimeline.setPlaying(false);}
    if(window.CassiniCamera) window.CassiniCamera.focus(focus,{dist,animate:false,theta:0.9,phi:1.05});
  },{when:WHEN,focus:FOCUS,dist:DIST,mode:MODE});
  await page.waitForTimeout(3000);

  const out = await page.evaluate(()=>{
    const s=window.CassiniScene, cw=s.camWorld;
    const px=w=>s.screenPosOf(w);
    const W=(line,i)=>{const a=line.geometry.attributes.position,o=line.position;
      return [a.getX(i)+o.x+cw.x,a.getY(i)+o.y+cw.y,a.getZ(i)+o.z+cw.z];};
    const P=(line,i)=>px(W(line,i));
    const ang=(a,b)=>Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI;
    const res={};
    const fl=s.trailFlownLine, fu=s.trailFullLine, ta=s.tailAbs;
    const drF=fl.geometry.drawRange, drU=fu.geometry.drawRange, drT=ta.geometry.drawRange;
    res.ranges={flown:[drF.start,drF.start+drF.count-1], full:[drU.start,drU.start+drU.count-1], tail:[drT.start,drT.start+drT.count-1]};
    const fEnd=drF.start+drF.count-1, uBeg=drU.start, tEnd=drT.count-1;
    // 各段在接缝处的局部方向（取接缝前/后各 2 个顶点，抗锯齿噪声）
    const flA=P(fl,Math.max(drF.start,fEnd-6)), flB=P(fl,fEnd);
    const taA=P(ta,0), taB=P(ta,tEnd);
    const fuA=P(fu,uBeg), fuB=P(fu,Math.min(uBeg+6, drU.start+drU.count-1));
    res.pts={flownEnd:flB, tailFirst:taA, tailLast:taB, fullFirst:fuA};
    res.ang={flownSeg:ang(flA,flB), tailSeg:ang(taA,taB), fullSeg:ang(fuA,fuB)};
    // 夹角（取 0-90 归一）
    const d=(a,b)=>{let x=Math.abs(a-b)%180; if(x>90)x=180-x; return x;};
    res.kink={flown_tail:d(res.ang.flownSeg,res.ang.tailSeg), tail_full:d(res.ang.tailSeg,res.ang.fullSeg), flown_full:d(res.ang.flownSeg,res.ang.fullSeg)};
    // 标记
    const mk=s.cassiniMarker;
    res.markerPx=px([mk.position.x+cw.x,mk.position.y+cw.y,mk.position.z+cw.z]);
    const pd=(p,q)=>Math.hypot(p.x-q.x,p.y-q.y);
    res.markerDev={vsFlownEnd:pd(res.markerPx,flB), vsTailFirst:pd(res.markerPx,taA), vsTailLast:pd(res.markerPx,taB), vsFullFirst:pd(res.markerPx,fuA)};
    // 像素跨度
    res.spanPx={flown:pd(P(fl,drF.start),flB), tail:pd(taA,taB), full:pd(fuA,P(fu,drU.start+drU.count-1))};
    return res;
  });
  console.log(JSON.stringify(out,null,1));
  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
