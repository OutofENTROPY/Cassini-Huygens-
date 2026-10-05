/* shot_epoch.js —— 在指定历元/聚焦/距离 截一张图（可带裁剪框）。
 * 用法：node shot_epoch.js <WHEN> <FOCUS> <DIST> <TAG> [cropX cropY cropW cropH]
 */
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = 'D:/Programming/HTML/Cassini';
const OUT = path.join(ROOT,'.workbuddy/shots');
const MIME = { '.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.glb':'model/gltf-binary','.wasm':'application/wasm','.json':'application/json' };
const srv = http.createServer((req,res)=>{ let r=decodeURIComponent(req.url.split('?')[0]); if(r==='/')r='/index.html'; const fp=path.join(ROOT,r); fs.readFile(fp,(e,b)=>{ if(e){res.writeHead(404);return res.end();} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(b);});});
const WHEN=process.argv[2]||'1997-10-15T09:26:00Z';
const FOCUS=process.argv[3]||'cassini';
const DIST=parseFloat(process.argv[4]||'1.5e6');
const TAG=process.argv[5]||'shot';
const TH=parseFloat(process.argv[6]||'0.9'), PH=parseFloat(process.argv[7]||'1.05');
const CLIP = process.argv.slice(8).map(Number);
(async()=>{
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const P=srv.address().port;
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1400,height:800}});
  page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,200)));
  await page.goto(`http://127.0.0.1:${P}/index.html`,{waitUntil:'load',timeout:60000});
  await page.waitForTimeout(9000);
  await page.evaluate(()=>{const b=document.getElementById('help-close');if(b)b.click();});
  await page.evaluate(({when,focus,dist,th,ph})=>{
    const t=(Date.parse(when)-946728000000)/1000;
    if(window.CassiniTimeline){window.CassiniTimeline.setNow(t);window.CassiniTimeline.setPlaying(false);}
    const C=window.CassiniCamera; C.focus(focus,{dist,animate:false,theta:th,phi:ph});
    if(C.state){C.state.sTheta=th;C.state.sPhi=ph;C.state.sDist=dist;}
  },{when:WHEN,focus:FOCUS,dist:DIST,th:TH,ph:PH});
  await page.waitForTimeout(2500);
  const opts = CLIP.length===4 ? {path:path.join(OUT,`${TAG}.png`), clip:{x:CLIP[0],y:CLIP[1],width:CLIP[2],height:CLIP[3]}}
                               : {path:path.join(OUT,`${TAG}.png`)};
  await page.screenshot(opts);
  console.log('saved', path.join(OUT,`${TAG}.png`));
  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
