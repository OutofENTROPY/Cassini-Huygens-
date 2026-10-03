/* shot_repro.js —— 精确复现用户截图的取景
 *   时间：1997-10-15T11:40:00Z（用户截图时刻）
 *   视角：跟随 Cassini，但拉远到能看到地球球体 + 标记 + 轨迹
 * 用法：node shot_repro.js [outPng]
 */
const { chromium } = require('playwright-core');
const OUT = process.argv[2] || 'D:/Programming/HTML/Cassini/tools/shots/repro_1140.png';

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--disable-gpu-sandbox', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

  await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(10000);

  // 切到“全部轨迹”模式，确保轨迹线可见
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, .btn, [role=button]')];
    const b = btns.find((x) => /全部轨迹/.test(x.innerText || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(800);

  // 精确设置时间为 1997-10-15T11:40:00Z
  const res = await page.evaluate(() => {
    const J2000 = 946728000000;
    const t = (Date.parse('1997-10-15T11:40:00Z') - J2000) / 1000;
    const tl = window.CassiniTimeline;
    if (!tl) return { ok: false, why: 'no timeline' };
    tl.setNow(t);
    tl.setPlaying(false);
    return { ok: true, t, stateT: tl.state.t };
  });
  console.log('setNow:', JSON.stringify(res));
  await page.waitForTimeout(1500);

  // 跟随 Cassini，并设一个中等距离（让地球可见）
  const cam = await page.evaluate(() => {
    const c = window.CassiniCamera;
    if (!c) return { ok: false };
    c.focus('cassini', { dist: 9.0e5, animate: false });
    return { ok: true, dist: c.state && c.state.dist, focus: c.state && c.state.focusName,
             mode: c.currentMode && c.currentMode() };
  });
  console.log('camera:', JSON.stringify(cam));
  await page.waitForTimeout(2500);

  const hud = await page.evaluate(() => {
    const el = document.querySelector('.hud, .status, #status');
    const txt = el ? el.innerText : (document.body.innerText || '');
    return txt.split('\n').filter((l) => /UTC|Earth|Sun|发射|km|km\/s/.test(l)).slice(0, 6).join(' | ');
  });
  console.log('HUD:', hud);

  await page.screenshot({ path: OUT, fullPage: false });
  console.log('screenshot saved:', OUT);
  await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
