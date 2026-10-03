/* probe_orbit.js —— 渲染发射历元，聚焦地球附近，检查地球轨道线形状与相位。
 * 单进程：内置 http 服务器 + playwright-core。
 */
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = 'D:/Programming/HTML/Cassini';
const OUT = path.join(ROOT, 'tools/shots');
const MIME = { '.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.glb':'model/gltf-binary','.wasm':'application/wasm','.json':'application/json' };
const srv = http.createServer((req,res)=>{ let r=decodeURIComponent(req.url.split('?')[0]); if(r==='/')r='/index.html'; const fp=path.join(ROOT,r); fs.readFile(fp,(e,b)=>{ if(e){res.writeHead(404);return res.end();} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(b);});});

const WHEN = process.argv[2] || '1997-10-15T11:40:00Z';
const FOCUS = process.argv[3] || 'earth';
const DIST = parseFloat(process.argv[4] || '1.2e7');
const TAG = process.argv[5] || 'orbit';

(async () => {
  srv.listen(8907,'127.0.0.1'); await new Promise(r=>setTimeout(r,700));
  const browser = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true, args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
  const page = await browser.newPage({ viewport:{width:1600,height:900} });
  page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,200)));
  await page.goto('http://127.0.0.1:8907/index.html',{waitUntil:'load',timeout:60000});
  await page.waitForTimeout(10000);

  await page.evaluate(({when,focus,dist})=>{
    const t=(Date.parse(when)-946728000000)/1000;
    if(window.CassiniTimeline){window.CassiniTimeline.setNow(t);window.CassiniTimeline.setPlaying(false);}
    if(window.CassiniCamera) window.CassiniCamera.focus(focus,{dist,animate:false,theta:0.9,phi:1.05});
  },{when:WHEN,focus:FOCUS,dist:DIST});
  await page.waitForTimeout(2500);

  // 检查地球轨道线顶点，与真实椭圆对比
  const diag = await page.evaluate(()=>{
    const s=window.CassiniScene; const reg=s.registry;
    const out={};
    for(const nm of ['earth','venus']){
      const e=reg.get(nm); if(!e||!e.orbitLineObj) continue;
      const pos=e.orbitLineObj.geometry.attributes.position;
      const N=pos.count;
      // 采样 8 个顶点（three 局部系）
      const pts=[];
      for(let i=0;i<N;i+=Math.max(1,Math.floor(N/12))){
        pts.push([pos.getX(i),pos.getY(i),pos.getZ(i)]);
      }
      out[nm]={N, linePos:[e.orbitLineObj.position.x,e.orbitLineObj.position.y,e.orbitLineObj.position.z],
               world:[e.world[0],e.world[1],e.world[2]], pts, _orbitK:e._orbitK, _orbitMt:e._orbitMt};
    }
    return out;
  });
  console.log('DIAG:', JSON.stringify(diag).slice(0,2000));

  await page.screenshot({path:path.join(OUT,`orbit_${TAG}.png`)});
  console.log('saved', path.join(OUT,`orbit_${TAG}.png`));
  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
