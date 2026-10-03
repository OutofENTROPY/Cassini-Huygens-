/* probe_join.js —— 检查「聚焦地球时 Cassini 轨迹与地球的屏幕衔接」。
 * 输出：地球屏幕坐标、Cassini 标记屏幕坐标、轨迹首尾顶点屏幕坐标、轨迹与地球的像素距离。
 * 用法：node probe_join.js [WHEN] [FOCUS] [DIST] [TAG] [AZIMUTH]
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
const TAG = process.argv[5] || 'join';

(async () => {
  srv.listen(8909,'127.0.0.1'); await new Promise(r=>setTimeout(r,700));
  const browser = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true, args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
  const page = await browser.newPage({ viewport:{width:1600,height:900} });
  page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,300)));
  await page.goto('http://127.0.0.1:8909/index.html',{waitUntil:'load',timeout:60000});
  await page.waitForTimeout(10000);

  await page.evaluate(({when,focus,dist})=>{
    const t=(Date.parse(when)-946728000000)/1000;
    if(window.CassiniTimeline){window.CassiniTimeline.setNow(t);window.CassiniTimeline.setPlaying(false);}
    if(window.CassiniCamera) window.CassiniCamera.focus(focus,{dist,animate:false,theta:0.9,phi:1.05});
  },{when:WHEN,focus:FOCUS,dist:DIST});
  await page.waitForTimeout(3000);
  const cst = await page.evaluate(()=>{
    const c=window.CassiniCamera;
    return {focus:c.currentFocus(), dist:c.currentDist(), sDist:c.state.sDist, theta:c.state.sTheta, phi:c.state.sPhi, anim:!!c.state.anim};
  });
  console.log('CAMSTATE', JSON.stringify(cst));

  const out = await page.evaluate(()=>{
    const s=window.CassiniScene;
    const three = window.THREE;
    function pxOf(world){ // 世界坐标（km，绝对）→ 屏幕 px
      return s.screenPosOf([world[0],world[1],world[2]]);
    }
    function sceneToWorld(v){ // 场景坐标（相机相对）+ camWorld → 世界坐标
      return [v[0]+s.camWorld.x, v[1]+s.camWorld.y, v[2]+s.camWorld.z];
    }
    const res={};
    // 地球世界坐标（场景系）
    const ce=s.registry.get('earth');
    res.earthWorld=[ce.world[0],ce.world[1],ce.world[2]];
    res.earthPx=pxOf(ce.world);
    res.camWorld=[s.camWorld.x,s.camWorld.y,s.camWorld.z];
    res.camPos=[s.camera.position.x,s.camera.position.y,s.camera.position.z];
    // Cassini 标记相对地球的屏幕距离
    if(res.earthPx && !res.earthPx.behind){
      res.markerEarthPxDist=Math.hypot(res.earthPx.x - res.earthPx.x, 0);
    }
    // Cassini 标记
    const mk=s.cassiniMarker||null;
    res.cassPx = mk?pxOf(sceneToWorld([mk.position.x,mk.position.y,mk.position.z])):null;
    res.cassWorld = s.cassWorld?[s.cassWorld[0],s.cassWorld[1],s.cassWorld[2]]:null;
    if(res.cassWorld&&ce.world){
      res.cassEarthKm=Math.hypot(res.cassWorld[0]-ce.world[0],res.cassWorld[1]-ce.world[1],res.cassWorld[2]-ce.world[2]);
    }
    if(res.cassPx&&res.earthPx){
      res.markerEarthPxDist=Math.hypot(res.cassPx.x-res.earthPx.x,res.cassPx.y-res.earthPx.y);
    }
    // flown 线首顶点 / 末顶点
    const tw=s.trailFlownLine;
    if(tw){
      const a=tw.geometry.attributes.position;
      const dr=tw.geometry.drawRange;
      const i0=dr.start, i1=dr.start+dr.count-1;
      const o=tw.position; // 对象位置（origin-cam）
      const g0=sceneToWorld([a.getX(i0)+o.x,a.getY(i0)+o.y,a.getZ(i0)+o.z]);
      const g1=sceneToWorld([a.getX(i1)+o.x,a.getY(i1)+o.y,a.getZ(i1)+o.z]);
      res.flownFirst=[{v:g0,px:pxOf(g0)}];
      res.flownLast=[{v:g1,px:pxOf(g1)}];
      res.flownRange=[i0,i1];
    }
    const tf=s.trailFullLine;
    if(tf){
      const a=tf.geometry.attributes.position;
      const dr=tf.geometry.drawRange;
      const i0=dr.start, i1=dr.start+dr.count-1;
      const o=tf.position;
      const g0=sceneToWorld([a.getX(i0)+o.x,a.getY(i0)+o.y,a.getZ(i0)+o.z]);
      const g1=sceneToWorld([a.getX(i1)+o.x,a.getY(i1)+o.y,a.getZ(i1)+o.z]);
      res.fullFirst=[{v:g0,px:pxOf(g0)}];
      res.fullLast=[{v:g1,px:pxOf(g1)}];
      res.fullRange=[i0,i1];
    }
    if(tw && ce){
      const a=tw.geometry.attributes.position; const o=tw.position;
      let best=1e18,bi=-1;
      for(let i=tw.geometry.drawRange.start;i<tw.geometry.drawRange.start+tw.geometry.drawRange.count;i++){
        const dx=a.getX(i)+o.x+s.camWorld.x-ce.world[0], dy=a.getY(i)+o.y+s.camWorld.y-ce.world[1], dz=a.getZ(i)+o.z+s.camWorld.z-ce.world[2];
        const d2=dx*dx+dy*dy+dz*dz; if(d2<best){best=d2;bi=i;}
      }
      res.flownNearestEarth={idx:bi, km:Math.sqrt(best)};
      const g1=sceneToWorld([a.getX(bi)+o.x,a.getY(bi)+o.y,a.getZ(bi)+o.z]);
      res.flownNearestEarthPx=pxOf(g1);
    }
    res.camDist=s.camera.position.length();
    res.camWorldDistToEarth=Math.hypot(s.camWorld.x-ce.world[0],s.camWorld.y-ce.world[1],s.camWorld.z-ce.world[2]);
    // 用世界坐标换算：marker 世界 = camWorld + marker.position（场景为相机相对系）
    if(mk) res.markerWorld=[s.camWorld.x+mk.position.x,s.camWorld.y+mk.position.y,s.camWorld.z+mk.position.z];
    return res;
  });
  console.log(JSON.stringify(out,null,1).slice(0,6000));
  await page.screenshot({path:path.join(OUT,`join_${TAG}.png`)});
  console.log('saved', path.join(OUT,`join_${TAG}.png`));
  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
