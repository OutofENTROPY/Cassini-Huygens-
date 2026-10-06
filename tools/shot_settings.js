/* shot_settings.js —— 验证设置面板在矮视口下被 max-height 截住并可滚动
 *   视口 1080×620（复现用户截图比例），打开设置面板截图 + 量测滚动状态
 * 用法：node shot_settings.js [outPng] [W] [H]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = 'D:/Programming/HTML/Cassini';
const OUT = process.argv[2] || path.join(ROOT, '.workbuddy/shots/settings_short.png');
const W = parseInt(process.argv[3] || '1080', 10);
const H = parseInt(process.argv[4] || '620', 10);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };

(async () => {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
    fs.readFile(p, (err, buf) => {
      if (err) { res.writeHead(404); res.end('nf'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(buf);
    });
  }).listen(0);
  const port = server.address().port;

  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--disable-gpu-sandbox', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(9000);

  // 打开设置面板
  await page.evaluate(() => {
    const b = document.getElementById('btn-settings');
    if (b) b.click();
  });
  await page.waitForTimeout(800);

  // 量测：面板底部位置 vs 时间轴顶部；是否出现滚动
  const m = await page.evaluate(() => {
    const panel = document.getElementById('settings-panel');
    const tl = document.getElementById('timeline-bar');
    const pr = panel.getBoundingClientRect();
    const tr = tl.getBoundingClientRect();
    return {
      viewportH: innerHeight,
      panelBottom: Math.round(pr.bottom),
      panelScrollH: panel.scrollHeight,
      panelClientH: panel.clientHeight,
      scrollable: panel.scrollHeight > panel.clientHeight,
      timelineTop: Math.round(tr.top),
      overlap: pr.bottom > tr.top,
    };
  });
  console.log('measure:', JSON.stringify(m));

  await page.screenshot({ path: OUT, fullPage: false });
  console.log('screenshot saved:', OUT);
  await browser.close();
  server.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
