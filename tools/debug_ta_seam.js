/* debug_ta_seam.js —— Ta 历元卫星窗口↔尾迹接缝分解。
 * 期望：flown末 = tailMoon首 = titan_now + rel(t0)。差值分解为
 *   (a) cassiniPosAt(t0) − ship_SPICE（经 saturn 锚定 Chebyshev + 体心轨道）
 *   (b) titanTrack(t0) − titan_SPICE（月网格 CR 插值误差）
 */
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = 'D:/Programming/HTML/Cassini';
const MIME = { '.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css' };
const srv = http.createServer((req,res)=>{ let r=decodeURIComponent(req.url.split('?')[0]); if(r==='/')r='/index.html'; const fp=path.join(ROOT,r); fs.readFile(fp,(e,b)=>{ if(e){res.writeHead(404);return res.end();} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(b);});});
(async()=>{
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const P=srv.address().port;
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1400,height:800}});
  page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,300)));
  await page.goto(`http://127.0.0.1:${P}/index.html`,{waitUntil:'load',timeout:60000});
  await page.waitForTimeout(9000);
  await page.evaluate(()=>{const b=document.getElementById('help-close');if(b)b.click();});
  const r=await page.evaluate(()=>{
    const OFF=65;
    const when='2004-10-26T15:30:00Z';
    const t=(Date.parse(when)-946728000000)/1000+OFF;
    const S=window.CassiniScene, C=window.CassiniCamera;
    const frame=(t)=>{const {cassWorld}=S.updatePositions(t);
      const cache={}; for(const [n,e] of S.registry) cache[n]=e.world; cache.cassini=cassWorld;
      try{C.update(performance.now(),cache,cassWorld,S);}catch(e){}
      S.updateRender(t);};
    if(window.CassiniTimeline){window.CassiniTimeline.setNow(t);window.CassiniTimeline.setPlaying(false);}
    frame(t); C.focus('titan',{dist:3e5,animate:false}); if(C.state)C.state.sDist=3e5; frame(t); frame(t);
    const sp=S.soiPlanets.get('titan'); const e=sp.entry;
    let w=null; for(const x of sp.wins){if(x.flown.visible||x.full.visible){w=x;break;}}
    if(!w) return {err:'win 不可见'};
    const buf=w.flown.geometry.attributes.position.array;
    const dr=w.flown.geometry.drawRange;
    const rel0=w.rel0||[0,0,0];
    const c=S.camWorld;
    const out={};
    out.junctionIdx = dr.start+dr.count-1;
    out.wI0=w.i0; out.tailIdxTail=S.tailIdxTail();
    out.relTail = out.junctionIdx;
    out.t0 = S.trailT[w.i0+out.junctionIdx];
    out.tNow = t;
    const flownLast=[c.x+w.flown.position.x+buf[out.junctionIdx*3], c.y+w.flown.position.y+buf[out.junctionIdx*3+1], c.z+w.flown.position.z+buf[out.junctionIdx*3+2]];
    const tail=S.tailMoon, tdr=tail.geometry.drawRange, tArr=tail.geometry.attributes.position.array;
    out.tailVisible=tail.visible; out.tailDR=[tdr.start,tdr.count]; out.tailOpacity=tail.material.opacity;
    const ti=tdr.start, g=ti*3, o=tail.position;
    const tailFirst=[c.x+o.x+tArr[g], c.y+o.y+tArr[g+1], c.z+o.z+tArr[g+2]];
    out.flownLast=flownLast; out.tailFirst=tailFirst;
    out.seamKm=Math.hypot(flownLast[0]-tailFirst[0],flownLast[1]-tailFirst[1],flownLast[2]-tailFirst[2]);
    // 两套 rel
    out.relBaked=[rel0[0]+buf[out.junctionIdx*3], rel0[1]+buf[out.junctionIdx*3+1], rel0[2]+buf[out.junctionIdx*3+2]];
    const shipCw=S.cassiniPosAt(out.t0,[0,0,0]);
    // frameAnchorAt(titan, t0)：titanTrack(t0)+saturnTrack(t0)。
    // 注意 track.at 返回【黄道】坐标，必须 eclToThree((x,y,z)→(x,z,−y)) 后才可与
    // three 系的 shipCw 相减（此前未映射 → dRel 虚高 1.8e9 km）
    const te=S.registryMap.get('titan');
    const anch=[0,0,0]; te.track.at(out.t0,anch);
    const ps=S.registryMap.get('saturn'); const pb=[0,0,0]; ps.track.at(out.t0,pb);
    const titanAt=[anch[0]+pb[0], anch[2]+pb[2], -(anch[1]+pb[1])];
    out.relFront=[shipCw[0]-titanAt[0], shipCw[1]-titanAt[1], shipCw[2]-titanAt[2]];
    out.dRel=Math.hypot(out.relFront[0]-out.relBaked[0],out.relFront[1]-out.relBaked[1],out.relFront[2]-out.relBaked[2]);
    out.dShipSatAnchor='n/a';
    out.dTitanTrack=Math.hypot(titanAt[0]-e.world[0], titanAt[1]-e.world[1], titanAt[2]-e.world[2]);
    out.dCassTrail=Math.hypot(shipCw[0]-S.cassWorld[0],shipCw[1]-S.cassWorld[1],shipCw[2]-S.cassWorld[2]);
    out.soiState={...S.soiState};
    out.winAB=[w.a,w.b]; out.n=w.n;
    return out;
  });
  console.log(JSON.stringify(r,(k,v)=>typeof v==='number'?(Math.abs(v)>1e6?v.toExponential(6):+v.toFixed(4)):v,1));
  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
