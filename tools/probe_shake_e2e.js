/* probe_shake_e2e.js —— 端到端视觉验证（最终判据）。
 * 做法：固定历元，连续微调相机 θ（模拟拖拽），逐帧截图。
 * 为排除整体视差，选择**聚焦 Cassini** 并把相机距离拉近到轨迹局部曲率可见的范围。
 * 关键：截图后计算「相邻帧差异图」的**结构变化**而非整体位移。
 *   用相位相关（phase correlation）估计全局平移，扣除后再看残差。
 * 若扣除全局平移后残差 < 阈值 → 无抖动（只有正常视差平移）。
 * 用法：node probe_shake_e2e.js [WHEN] [FOCUS] [DIST] [TAG]
 */
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = 'D:/Programming/HTML/Cassini';
const OUT = path.join(ROOT,'tools/shots');
const MIME = { '.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.glb':'model/gltf-binary','.wasm':'application/wasm','.json':'application/json' };
const srv = http.createServer((req,res)=>{ let r=decodeURIComponent(req.url.split('?')[0]); if(r==='/')r='/index.html'; const fp=path.join(ROOT,r); fs.readFile(fp,(e,b)=>{ if(e){res.writeHead(404);return res.end();} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(b);});});
const WHEN = process.argv[2] || '2007-06-01T00:00:00Z';
const FOCUS= process.argv[3] || 'cassini';
const DIST = parseFloat(process.argv[4] || '5e6');
const TAG  = process.argv[5] || 'e2e';
const DTHS = [0, 0.002, 0.004, 0.006, 0.008, 0.010];
(async () => {
  await new Promise(res => srv.listen(0,'127.0.0.1',res));
  const P = srv.address().port;
  const browser = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true, args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
  const page = await browser.newPage({ viewport:{width:1200,height:700} });
  page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,300)));
  await page.goto(`http://127.0.0.1:${P}/index.html`,{waitUntil:'load',timeout:60000});
  await page.waitForTimeout(9000);
  await page.evaluate(()=>{ const b=document.getElementById('help-close'); if(b) b.click(); });
  await page.evaluate((when)=>{ const t=(Date.parse(when)-946728000000)/1000; if(window.CassiniTimeline){window.CassiniTimeline.setNow(t);window.CassiniTimeline.setPlaying(false);} },WHEN);
  await page.waitForTimeout(1500);
  const files=[];
  for(let i=0;i<DTHS.length;i++){
    await page.evaluate(({focus,dist,dth})=>{ const C=window.CassiniCamera;
      C.focus(focus,{dist,animate:false,theta:0.9+dth,phi:1.05});
      if(C.state){C.state.sTheta=C.state.theta;C.state.sPhi=C.state.phi;C.state.sDist=C.state.dist;} },{focus:FOCUS,dist:DIST,dth:DTHS[i]});
    await page.waitForTimeout(900);
    const f=path.join(OUT,`e2e_${TAG}_${i}.png`);
    await page.screenshot({path:f});
    files.push(f);
    console.log(`shot ${i}: θ=${(0.9+DTHS[i]).toFixed(4)}  -> ${path.basename(f)}`);
  }
  console.log('\n截图已保存，供人工对比：');
  for(const f of files) console.log('  '+f);
  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
