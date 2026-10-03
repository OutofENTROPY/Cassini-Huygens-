/* probe_mirror.js —— 验证「地球相对轨迹是否被镜像」。
 * 对每个 SOI 窗口顶点 i：drawn_rel = vertex(i) - earth_world_now（场景/相机相对系）
 *                      true_rel   = eclToThree(trail_ecl[i] - earth_ecl[i])
 * 二者应一致；若 y 或 z 分量符号相反即为镜像。
 * 还需检查全部顶点里，与「飞船当前位置」相对地球的方位是否吻合。
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

(async () => {
  srv.listen(8911,'127.0.0.1'); await new Promise(r=>setTimeout(r,700));
  const browser = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true, args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
  const page = await browser.newPage({ viewport:{width:1600,height:900} });
  page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,300)));
  await page.goto('http://127.0.0.1:8911/index.html',{waitUntil:'load',timeout:60000});
  await page.waitForTimeout(10000);
  await page.evaluate(({when,focus,dist})=>{
    const t=(Date.parse(when)-946728000000)/1000;
    if(window.CassiniTimeline){window.CassiniTimeline.setNow(t);window.CassiniTimeline.setPlaying(false);}
    if(window.CassiniCamera) window.CassiniCamera.focus(focus,{dist,animate:false,theta:0.9,phi:1.05});
  },{when:WHEN,focus:FOCUS,dist:DIST});
  await page.waitForTimeout(3000);

  const out = await page.evaluate(()=>{
    const s=window.CassiniScene;
    const cw=s.camWorld;
    const t=window.CassiniTimeline.state.t;
    const res={t};
    function eclToThree(v){ return [v[0], v[2], -v[1]]; }
    const sp=s.soiPlanets.get('earth');
    if(!sp) return {err:'no earth soi'};
    const e=sp.entry;
    res.earthWorld=[e.world[0],e.world[1],e.world[2]];
    const w=sp.wins[0];
    const line=w.full;
    const a=line.geometry.attributes.position, o=line.position;
    const N=a.count;
    // 采样若干索引
    const idxs=[0, Math.floor(N*0.1), Math.floor(N*0.25), Math.floor(N*0.5), Math.floor(N*0.75), N-1];
    res.samples=[];
    for(const i of idxs){
      // 顶点 = 对象位置 + 数组；对象位置 = w.o - cam + (planet_now - pRef)
      const sx=a.getX(i)+o.x, sy=a.getY(i)+o.y, sz=a.getZ(i)+o.z;
      const wW=[sx+cw.x, sy+cw.y, sz+cw.z];          // 世界坐标
      // 该顶点对应的时刻
      const ti=w.times?w.times[i]:null;
      res.samples.push({i, ti, relWorld:[wW[0]-e.world[0], wW[1]-e.world[1], wW[2]-e.world[2]]});
    }
    // 当前 Cassini 相对地球
    const cr=[s.cassWorld[0]-e.world[0], s.cassWorld[1]-e.world[1], s.cassWorld[2]-e.world[2]];
    res.cassRelEarth=cr;
    res.cassRelEarthNorm=Math.hypot(cr[0],cr[1],cr[2]);
    // 所有窗口顶点中离飞船最近的索引（应接近 idxNow - w.i0）
    const idxNow=s.trailIndexAt(t);
    res.idxNow=idxNow; res.i0=w.i0; res.expectIdx=idxNow-w.i0;
    // 逐点求与飞船世界坐标的最近距离
    let best=1e18,bi=-1;
    for(let i=0;i<N;i++){
      const dx=a.getX(i)+o.x+cw.x-s.cassWorld[0], dy=a.getY(i)+o.y+cw.y-s.cassWorld[1], dz=a.getZ(i)+o.z+cw.z-s.cassWorld[2];
      const d2=dx*dx+dy*dy+dz*dz; if(d2<best){best=d2;bi=i;}
    }
    res.nearestVertToShip={idx:bi, km:Math.sqrt(best)};
    // —— 屏幕角对比 ——
    const px=w2=>s.screenPosOf(w2);
    function segAngle(line){
      const A=line.geometry.attributes.position, dr=line.geometry.drawRange, oo=line.position;
      const k0=dr.start, k1=dr.start+dr.count-1;
      const P=i=>px([A.getX(i)+oo.x+cw.x, A.getY(i)+oo.y+cw.y, A.getZ(i)+oo.z+cw.z]);
      const p0=P(k0), p1=P(k1);
      return {k0,k1,p0,p1, dx:p1.x-p0.x, dy:p1.y-p0.y, ang:Math.atan2(p1.y-p0.y,p1.x-p0.x)*180/Math.PI};
    }
    res.angles={};
    res.angles.helioFlown=segAngle(s.trailFlownLine);
    res.angles.helioFull=segAngle(s.trailFullLine);
    res.angles.earthFlown=segAngle(sp.wins[0].flown);
    res.angles.earthFull=segAngle(sp.wins[0].full);
    res.angles.tailAbs=segAngle(s.tailAbs);
    // 轨迹整体走向：helio 从 i=0 到 idxNow，earth 从 0 到 138
    function dir(line, i0, i1){
      const A=line.geometry.attributes.position, oo=line.position;
      const P=i=>px([A.getX(i)+oo.x+cw.x, A.getY(i)+oo.y+cw.y, A.getZ(i)+oo.z+cw.z]);
      const a=P(i0), b=P(i1);
      return {px:[a,b], ang:Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI};
    }
    res.dirHelioPast=dir(s.trailFlownLine,0,138);
    res.dirEarthPast=dir(sp.wins[0].flown,0,138);
    return res;
  });
  console.log(JSON.stringify(out,null,1));
  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
