/* verify_bounce.js —— 飞船互反射（bounce light）A/B/C 截图取证 v3
 *   A：RAF 正常渲染（反弹光解算生效）
 *   B：__bounceOff 调试门禁置零（scene.js updateCraftBounce 顶部钩子）
 *   C：__pauseLoop 冻结 RAF + 强制 col=50（管路旁证，应炸亮）
 * 用法：node verify_bounce.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { chromium } = require('playwright-core');

const ROOT = 'D:/Programming/HTML/Cassini';
const OUT_A = path.join(ROOT, '.workbuddy/shots/bounce_on.png');
const OUT_B = path.join(ROOT, '.workbuddy/shots/bounce_off.png');
const OUT_C = path.join(ROOT, '.workbuddy/shots/bounce_force.png');
const CLIP = { x: 540, y: 240, width: 520, height: 420 };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(ROOT, req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]);
      fs.readFile(p, (err, data) => {
        if (err) { res.writeHead(404); res.end('nf'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(8899, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const srv = await serve();
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--disable-gpu-sandbox', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
  page.on('console', (m) => {
    const s = m.text();
    if (/Shader Error|ERROR|错误/.test(s)) console.log('[console]', s.slice(0, 400));
  });

  await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(14000);

  const setup = await page.evaluate(() => {
    const J2000 = 946728000000;
    const t = (Date.parse('2004-12-24T20:00:00Z') - J2000) / 1000;
    const tl = window.CassiniTimeline;
    tl.setNow(t); tl.setPlaying(false);          // RAF 继续渲染，只是 t 冻结
    window.CassiniScene.setRealisticLighting(true);
    const cam = window.CassiniCamera;
    cam.focus('cassini', { dist: 0.028, animate: false });
    cam.state.anim = null;
    cam.state.sTheta = cam.state.theta;
    cam.state.sPhi = cam.state.phi;
    cam.state.sDist = cam.state.dist;
    return { t, dist: cam.state.dist };
  });
  console.log('setup:', JSON.stringify(setup));
  await page.waitForTimeout(2500);

  await page.screenshot({ path: OUT_A, fullPage: false, clip: CLIP });   // A：反弹光生效

  await page.evaluate(() => { window.__bounceOff = true; });             // B：门禁置零
  await page.waitForTimeout(700);
  await page.screenshot({ path: OUT_B, fullPage: false, clip: CLIP });

  const c = await page.evaluate(() => {                                  // C：强制管路旁证
    window.__pauseLoop = true;                 // 冻结 RAF（此后只有手动推帧）
    const S = window.CassiniScene;
    const t = window.CassiniTimeline.state.t;
    S.updateRender(t);                         // 正常解算一遍（相机/姿态/位置刷新）
    const anchor = window.CassiniModel.getDishAnchor();
    const cm = S.cassiniModel;
    const p = new THREE.Vector3(anchor.pos.x, anchor.pos.y, anchor.pos.z)
      .applyQuaternion(cm.quaternion).add(cm.position)
      .applyMatrix4(S.camera.matrixWorldInverse);   // 场景系 → 视图空间
    p.z += 0.0025;                             // 向相机侧抬 2.5 m：光源置于表面前方（bNL>0）
    window.CassiniModel.setBounce(p, new THREE.Vector3(50, 50, 50));
    S.render();
    return 'forced';
  });
  console.log('C:', c);
  await page.screenshot({ path: OUT_C, fullPage: false, clip: CLIP });

  await browser.close();
  srv.close();

  const A = PNG.sync.read(fs.readFileSync(OUT_A));
  const B = PNG.sync.read(fs.readFileSync(OUT_B));
  let n = 0, sumA = 0, sumB = 0;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < A.height; y++) {
    for (let x = 0; x < A.width; x++) {
      const i = (y * A.width + x) * 4;
      if (Math.abs(A.data[i] - B.data[i]) > 20 ||
          Math.abs(A.data[i + 1] - B.data[i + 1]) > 20 ||
          Math.abs(A.data[i + 2] - B.data[i + 2]) > 20) {
        n++;
        sumA += A.data[i] + A.data[i + 1] + A.data[i + 2];
        sumB += B.data[i] + B.data[i + 1] + B.data[i + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  console.log(`diff A(on) vs B(off): pixels=${n} bbox=(${x0},${y0})-(${x1},${y1})` +
    (n ? ` meanRGB on=${(sumA / n / 3).toFixed(1)} off=${(sumB / n / 3).toFixed(1)}` : ''));
})().catch((e) => { console.error('ERR', e); process.exit(1); });
