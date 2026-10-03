/* probe_seam.js —— 检查「past/future/tail 三段在 Cassini 处的接缝」以及与标记的偏差。
 * 输出：标记屏幕坐标；flown 末顶点；full 首顶点；tailAbs 首/末顶点的世界坐标与屏幕坐标。
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
const TAG = process.argv[5] || 'seam';
const FUT = process.argv[6] === 'fut';
const MODE = process.argv[7] || 'recent';

(async () => {
  srv.listen(8910,'127.0.0.1'); await new Promise(r=>setTimeout(r,700));
  const browser = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true, args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
  const page = await browser.newPage({ viewport:{width:1600,height:900} });
  page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,300)));
  await page.goto('http://127.0.0.1:8910/index.html',{waitUntil:'load',timeout:60000});
  await page.waitForTimeout(10000);

  await page.evaluate(({when,focus,dist,fut,mode})=>{
    const t=(Date.parse(when)-946728000000)/1000;
    if(window.CassiniScene) window.CassiniScene.setTrailOptions({future:!!fut, mode});
    if(window.CassiniTimeline){window.CassiniTimeline.setNow(t);window.CassiniTimeline.setPlaying(false);}
    if(window.CassiniCamera) window.CassiniCamera.focus(focus,{dist,animate:false,theta:0.9,phi:1.05});
  },{when:WHEN,focus:FOCUS,dist:DIST,fut:FUT,mode:MODE});
  await page.waitForTimeout(3000);

  const out = await page.evaluate(()=>{
    const s=window.CassiniScene;
    const cw=s.camWorld;
    const px=w=>s.screenPosOf([w[0],w[1],w[2]]);
    const toW=(o,a,i)=>[a.getX(i)+o.x+cw.x, a.getY(i)+o.y+cw.y, a.getZ(i)+o.z+cw.z];
    const res={};
    const mk=s.cassiniMarker;
    res.cassMarkerScene=[mk.position.x,mk.position.y,mk.position.z];
    res.cassMarkerWorld=[mk.position.x+cw.x,mk.position.y+cw.y,mk.position.z+cw.z];
    res.cassMarkerPx=px(res.cassMarkerWorld);
    res.cassWorldScene=[s.cassWorld[0],s.cassWorld[1],s.cassWorld[2]];
    res.cassAirPx=px(s.cassWorld);
    function lineInfo(line,name){
      if(!line) return null;
      const a=line.geometry.attributes.position, dr=line.geometry.drawRange, o=line.position;
      const i0=dr.start, i1=dr.start+dr.count-1;
      return {name, visible:line.visible, range:[i0,i1], count:line.geometry.attributes.position.count,
        firstW:toW(o,a,i0), lastW:toW(o,a,i1),
        firstPx:px(toW(o,a,i0)), lastPx:px(toW(o,a,i1))};
    }
    res.flown=lineInfo(s.trailFlownLine,'flown');
    res.full=lineInfo(s.trailFullLine,'full');
    res.tailAbs=lineInfo(s.tailAbs,'tailAbs');
    // 尾迹是否可见
    try {
      if(s.tailAbs && s.tailAbs.geometry && s.tailAbs.geometry.drawRange && s.tailAbs.geometry.drawRange.count>0){
        const a=s.tailAbs.geometry.attributes.position, dr=s.tailAbs.geometry.drawRange;
        res.tailFirstW=[a.getX(0)+cw.x,a.getY(0)+cw.y,a.getZ(0)+cw.z];
        res.tailLastW=[a.getX(dr.count-1)+cw.x,a.getY(dr.count-1)+cw.y,a.getZ(dr.count-1)+cw.z];
      }
    } catch(e){ res.tailErr=String(e); }    // 屏幕像素偏差
    function pd(a,b){ return (a&&b)?Math.hypot(a.x-b.x,a.y-b.y):null; }
    res.dev = {
      marker_vs_flownLast: pd(res.cassMarkerPx, res.flown&&res.flown.lastPx),
      marker_vs_fullFirst: pd(res.cassMarkerPx, res.full&&res.full.firstPx),
      marker_vs_tailFirst: pd(res.cassMarkerPx, res.tailAbs&&res.tailAbs.firstPx),
      marker_vs_tailLast: pd(res.cassMarkerPx, res.tailAbs&&res.tailAbs.lastPx),
      flownLast_vs_fullFirst: pd(res.flown&&res.flown.lastPx, res.full&&res.full.firstPx),
    };
    // 三维距离（km）
    function d3(a,b){ return (a&&b)?Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]):null; }
    res.d3 = {
      marker_vs_air: d3(res.cassMarkerWorld,res.cassWorldScene),
      marker_vs_flownLast: d3(res.cassMarkerWorld,res.flown&&res.flown.lastW),
      marker_vs_fullFirst: d3(res.cassMarkerWorld,res.full&&res.full.firstW),
      marker_vs_tailLast: d3(res.cassMarkerWorld,res.tailLastW),
      flownLast_vs_fullFirst: d3(res.flown&&res.flown.lastW,res.full&&res.full.firstW),
    };
    // 颜色：flown 末顶点色、full 首顶点色、tail 末顶点色
    function colAt(line,i){ if(!line||!line.geometry.attributes.color) return null; const c=line.geometry.attributes.color.array; return [c[i*3],c[i*3+1],c[i*3+2]].map(v=>+v.toFixed(3)); }
    res.colors={
      flownLast: colAt(s.trailFlownLine, res.flown?res.flown.range[1]:0),
      fullFirst: colAt(s.trailFullLine, res.full?res.full.range[0]:0),
      tailFirst: colAt(s.tailAbs,0),
      tailLast: colAt(s.tailAbs, (res.tailAbs&&res.tailAbs.count)?res.tailAbs.count-1:0),
    };
    res.trailOptions = JSON.parse(JSON.stringify(s.trailOptions));
    // —— SOI 相对轨迹（地球）——
    try{
      const soi = s.soiDebug || null;
    }catch(e){}
    // 通过 soiState 找到当前锚定体，再从 registry + 内部结构读窗口
    res.soiState = s.soiState ? {name:s.soiState.name, k:s.soiState.k, moon:s.soiState.moon, k2:s.soiState.k2} : null;
    res.earthSOI = null;
    try{
      const sp = s.soiPlanets.get('earth');
      if (sp) {
        const e=sp.entry;
        res.earthEntry={world:[e.world[0],e.world[1],e.world[2]], radius:e.radius};
        res.earthWins = sp.wins.map(w=>{
          const info=(line)=>{ if(!line) return null;
            const a=line.geometry.attributes.position, dr=line.geometry.drawRange, o=line.position;
            const i0=dr.start,i1=dr.start+dr.count-1;
            const W=(i)=>[a.getX(i)+o.x+cw.x,a.getY(i)+o.y+cw.y,a.getZ(i)+o.z+cw.z];
            return {vis:line.visible, range:[i0,i1], count:a.count,
                    firstW:W(i0), lastW:W(i1),
                    firstPx:px(W(i0)), lastPx:px(W(i1)),
                    pos:[o.x,o.y,o.z]};
          };
          return {a:w.a, b:w.b, n:w.n, i0:w.i0,
                  tFirst:w.times&&w.times[0], tLast:w.times&&w.times[w.n-1],
                  full:info(w.full), flown:info(w.flown)};
        });
      }
    }catch(e){ res.earthSOIErr=String(e); }
    return res;
  });
  console.log(JSON.stringify(out,null,1).slice(0,5000));
  await page.screenshot({path:path.join(OUT,`seam_${TAG}.png`)});
  console.log('saved', path.join(OUT,`seam_${TAG}.png`));
  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
