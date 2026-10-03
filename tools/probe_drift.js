/* probe_drift.js —— 直接验证「远景轨迹随视角晃动」：
 * 用真实鼠标拖拽（或直接改 camera.state.theta）移动相机，测量同一条线的
 * 世界坐标是否保持恒定（世界坐标 = 场景坐标 + camWorld）。
 * 若世界坐标随相机变化 → 该线的浮动原点补偿有误。
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

const SAMPLE = () => {
  const s = window.CassiniScene, cw = s.camWorld;
  const grab = (line, name, indices) => {
    if (!line) return null;
    const a = line.geometry.attributes.position, o = line.position;
    const out = { name, objPos: [o.x, o.y, o.z], verts: [] };
    for (const i of indices) {
      out.verts.push([a.getX(i) + o.x + cw.x, a.getY(i) + o.y + cw.y, a.getZ(i) + o.z + cw.z]);
    }
    return out;
  };
  const sp = s.soiPlanets.get('earth');
  const ew = sp ? [sp.entry.world[0], sp.entry.world[1], sp.entry.world[2]] : null;
  return {
    camWorld: [cw.x, cw.y, cw.z],
    trailOrigin: [s.trailOrigin.x, s.trailOrigin.y, s.trailOrigin.z],
    earthWorld: ew,
    helio: grab(s.trailFlownLine, 'helio', [0, 60, 122]),
    helioFull: grab(s.trailFullLine, 'helioFull', [123, 200, 400]),
    tailAbs: grab(s.tailAbs, 'tailAbs', [0, 6, 11]),
    earthFlown: sp ? grab(sp.wins[0].flown, 'earthFlown', [0, 60, 122]) : null,
    earthFull: sp ? grab(sp.wins[0].full, 'earthFull', [139, 300, 800, 3556]) : null,
  };
};

(async () => {
  srv.listen(8912,'127.0.0.1'); await new Promise(r=>setTimeout(r,700));
  const browser = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true, args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
  const page = await browser.newPage({ viewport:{width:1600,height:900} });
  page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,300)));
  await page.goto('http://127.0.0.1:8912/index.html',{waitUntil:'load',timeout:60000});
  await page.waitForTimeout(10000);
  await page.evaluate(({when,focus,dist})=>{
    const t=(Date.parse(when)-946728000000)/1000;
    if(window.CassiniTimeline){window.CassiniTimeline.setNow(t);window.CassiniTimeline.setPlaying(false);}
    if(window.CassiniCamera) window.CassiniCamera.focus(focus,{dist,animate:false,theta:0.9,phi:1.05});
  },{when:WHEN,focus:FOCUS,dist:DIST});
  await page.waitForTimeout(2500);

  const results = [];
  // 用真实鼠标拖拽：从画面中心拖到各个方向，模拟「晃动视角」
  const cx = 800, cy = 450;
  for (const [label, dx, dy] of [['a',0,0],['b',120,0],['c',120,90],['d',-150,60],['e',60,-120]]) {
    if (dx||dy) {
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let k=1;k<=8;k++) await page.mouse.move(cx+dx*k/8, cy+dy*k/8);
      await page.mouse.up();
      await page.waitForTimeout(700);
    }
    const s = await page.evaluate(SAMPLE);
    results.push({label, ...s});
  }
  // 世界坐标对比：每次拖拽后同一顶点的世界坐标应保持不变（浮点误差上限 ~m 级）
  const base = results[0];
  const names = ['helio','helioFull','tailAbs','earthFlown','earthFull'];
  console.log('camWorld drift (km):');
  for (const r of results) {
    console.log(' ', r.label, 'cam', r.camWorld.map(v=>v.toFixed(0)).join(','), 'origin', r.trailOrigin.map(v=>v.toFixed(0)).join(','));
  }
  console.log('\nworld-coordinate drift of same vertices (km):');
  for (const nm of names) {
    if (!base[nm]) continue;
    for (let vi=0; vi<base[nm].verts.length; vi++) {
      const deltas = results.map(r=>{
        if(!r[nm]) return null;
        const a=base[nm].verts[vi], b=r[nm].verts[vi];
        return Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
      });
      console.log(`  ${nm}[${vi}] max drift = ${Math.max(...deltas.filter(v=>v!==null)).toFixed(1)} km`);
    }
  }
  console.log('\nrelative drift (line vs earth center, subtract earth move):');
  for (const nm of names) {
    if (!base[nm]) continue;
    for (let vi=0; vi<base[nm].verts.length; vi++) {
      const rel = results.map(r=>{
        if(!r[nm]||!r.earthWorld) return null;
        const a=r[nm].verts[vi];
        return [a[0]-r.earthWorld[0],a[1]-r.earthWorld[1],a[2]-r.earthWorld[2]];
      }).filter(Boolean);
      let mx=0;
      for(let i=1;i<rel.length;i++) mx=Math.max(mx,Math.hypot(rel[0][0]-rel[i][0],rel[0][1]-rel[i][1],rel[0][2]-rel[i][2]));
      console.log(`  ${nm}[${vi}] max drift rel-earth = ${mx.toFixed(1)} km`);
    }
  }
  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
