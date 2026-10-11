/* verify_ao.js —— 飞船逐顶点 AO A/B 截图取证
 *   前置：aoV 属性存在性与数值分布检查（GLB _AO → GLTFLoader _ao → 重映射）
 *   A：真实光照 + AO（setSunMode 联动开启）
 *   B：同帧 setAO(false)（uniform 门禁直控，确定性冻结管线推帧）
 * 判据：B 差异像素集中在缝隙/盘下（AO 弱化间接光），向阳受照区逐位不动；
 *       普通模式 A/B 逐位一致（uAOOn=0 乘 1 无扰动）。
 * 用法：NODE_PATH=<node_modules> node verify_ao.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { chromium } = require('playwright-core');

const ROOT = 'D:/Programming/HTML/Cassini';
const OUT_A = path.join(ROOT, '.workbuddy/shots/ao_on.png');
const OUT_B = path.join(ROOT, '.workbuddy/shots/ao_off.png');
const OUT_N = path.join(ROOT, '.workbuddy/shots/ao_norm.png');
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

/* 冻结推帧方案废弃（裸 S.render() 不含主循环全部 pass，模型丢失——互反射
 * 轮 C 帧同款症状）。改用 RAF 帧 + 门禁直控：setSunMode 仅在模式切换时
 * 调用（scene.js:935），setAO 翻转 uniform 后 RAF 各帧保持，等待数帧即稳。 */

function diff(fileA, fileB, th) {
  const A = PNG.sync.read(fs.readFileSync(fileA));
  const B = PNG.sync.read(fs.readFileSync(fileB));
  let n = 0, sumA = 0, sumB = 0;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < A.height; y++) {
    for (let x = 0; x < A.width; x++) {
      const i = (y * A.width + x) * 4;
      const d = Math.max(Math.abs(A.data[i] - B.data[i]),
                         Math.abs(A.data[i + 1] - B.data[i + 1]),
                         Math.abs(A.data[i + 2] - B.data[i + 2]));
      if (d > th) {
        n++;
        sumA += A.data[i] + A.data[i + 1] + A.data[i + 2];
        sumB += B.data[i] + B.data[i + 1] + B.data[i + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return `pixels=${n} bbox=(${x0},${y0})-(${x1},${y1})` +
    (n ? ` meanRGB A=${(sumA / n / 3).toFixed(1)} B=${(sumB / n / 3).toFixed(1)}` : '');
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

  /* 前置：aoV 属性检查 */
  const attr = await page.evaluate(() => {
    const cm = window.CassiniScene.cassiniModel;
    const out = { meshes: 0, withAoV: 0, stats: [] };
    cm.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      out.meshes++;
      const a = o.geometry.attributes.aoV;
      if (!a) return;
      out.withAoV++;
      if (out.stats.length < 4) {
        let s = 0, mn = 255, mx = 0;
        for (let i = 0; i < a.count; i++) {
          const v = a.array[i];
          s += v; if (v < mn) mn = v; if (v > mx) mx = v;
        }
        out.stats.push({ n: a.count, mean: +(s / a.count).toFixed(3), min: +mn.toFixed(3), max: +mx.toFixed(3) });
      }
    });
    return out;
  });
  console.log('aoV attr:', JSON.stringify(attr));
  if (attr.withAoV === 0) { console.log('FAIL: 无 aoV 属性'); await browser.close(); srv.close(); return; }

  /* 场景：2004-12-24 20:00（分离前夜，天线盘受照），真实光照 */
  const setup = await page.evaluate(() => {
    const J2000 = 946728000000;
    const t = (Date.parse('2004-12-24T20:00:00Z') - J2000) / 1000;
    const tl = window.CassiniTimeline;
    tl.setNow(t); tl.setPlaying(false);
    window.CassiniScene.setRealisticLighting(true);
    const cam = window.CassiniCamera;
    cam.focus('cassini', { dist: 0.028, animate: false });
    cam.state.anim = null;
    cam.state.sTheta = cam.state.theta;
    cam.state.sPhi = cam.state.phi;
    cam.state.sDist = cam.state.dist;
    return { t };
  });
  console.log('setup:', JSON.stringify(setup));
  await page.waitForTimeout(2000);

  /* A：AO 开（RAF 正常帧） */
  await page.screenshot({ path: OUT_A, fullPage: false, clip: CLIP });

  /* B：AO 关（setAO 直控 uniform；RAF 后续帧保持，等 0.7s 取稳态帧） */
  await page.evaluate(() => { window.CassiniModel.setAO(false); });
  await page.waitForTimeout(700);
  await page.screenshot({ path: OUT_B, fullPage: false, clip: CLIP });

  /* 普通模式视觉留档（AO 门禁只在真实光照开启，普通模式走原路径） */
  await page.evaluate(() => {
    window.CassiniModel.setAO(true);
    window.CassiniScene.setRealisticLighting(false);
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: OUT_N, fullPage: false, clip: CLIP });

  await browser.close();
  srv.close();

  console.log('A(on) vs B(off) th=6 :', diff(OUT_A, OUT_B, 6));
  console.log('A(on) vs B(off) th=12:', diff(OUT_A, OUT_B, 12));
})().catch((e) => { console.error('ERR', e); process.exit(1); });
