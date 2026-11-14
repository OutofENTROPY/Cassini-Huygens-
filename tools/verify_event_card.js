/* verify_event_card.js —— 事件卡折叠状态归属性校验（20261114）
 *   断言：切换任务卡片（事件列表 / 时间轴自动越事件）不得改写用户对左上角通知
 *         按钮开合状态的选择；左下角事件卡只在用户点按时收起。
 *   注：headless + swiftshader 下主线程被 WebGL 拖慢，CSS 过渡要等到下一帧才开始，
 *       因此所有可见性断言都用轮询等待（固定 sleep 会误判）。
 * 用法：node tools/verify_event_card.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8901;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(ROOT, u === '/' ? '/index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--disable-gpu-sandbox', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.CassiniTimeline && window.CassiniCamera, null, { timeout: 90000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.CassiniTimeline.setPlaying(false));

  const snap = () => page.evaluate(() => {
    const card = document.getElementById('event-card');
    return {
      folded: document.body.classList.contains('event-folded'),
      open: document.body.classList.contains('event-open'),
      hidden: card.classList.contains('hidden'),
      opacity: parseFloat(getComputedStyle(card).opacity),
      title: document.getElementById('event-title').textContent,
      hitAtFold: (() => {   // ⌄ 按钮中心是否真的命中按钮（层叠顺序自检）
        const b = document.getElementById('event-fold').getBoundingClientRect();
        const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return el ? (el.id || el.tagName) : 'none';
      })(),
    };
  });
  const clickEvent = (i) => page.evaluate((idx) => {
    const items = [...document.querySelectorAll('.ev-item')];
    items[idx % items.length].click();
    return items.length;
  }, i);
  // 等到「折叠类」与「实际透明度」一致（CSS 过渡要等帧）
  const waitState = async (folded) => {
    try {
      await page.waitForFunction((f) => {
        const card = document.getElementById('event-card');
        const op = parseFloat(getComputedStyle(card).opacity);
        const isFolded = document.body.classList.contains('event-folded');
        return isFolded === f && (f ? op < 0.05 : op > 0.9);
      }, folded, { timeout: 20000, polling: 200 });
      return true;
    } catch (e) { return false; }
  };

  const n = await clickEvent(2);
  check('事件列表项数量 > 3', n > 3, 'n=' + n);
  let ok = await waitState(true);
  let s = await snap();
  check('切卡后默认折叠：内容已装入、卡片收起、铃铛呼吸态', ok && s.open && !s.hidden, JSON.stringify(s));

  // 用户展开
  await page.click('#event-fab');
  ok = await waitState(false);
  s = await snap();
  check('点铃铛 → 卡片展开', ok, JSON.stringify(s));
  // 展开态下 ⌄ 按钮中心必须真的命中按钮（或其内部 svg），不能被全宽文本块盖住
  check('⌄ 收起按钮可点击（层叠顺序自检）', /^(event-fold|svg|path)$/.test(s.hitAtFold), 'hit=' + s.hitAtFold);

  // 切换任务卡片三次：必须保持展开
  for (const i of [5, 9, 3]) {
    await clickEvent(i);
    ok = await waitState(false);
    s = await snap();
    check(`切到事件 #${i} 后卡片仍展开（不自动收起）`, ok && !s.folded,
      `op=${s.opacity} title=${s.title.slice(0, 14)}`);
  }

  // 播放自动越事件（前进 400 天）也不得收起
  const before = await page.evaluate(() => document.getElementById('event-title').textContent);
  await page.evaluate(() => {
    const tl = window.CassiniTimeline;
    tl.setNow(tl.state.t + 86400 * 400);
    tl.refresh && tl.refresh();
  });
  // 主循环按帧比对事件索引，需等它跑到（软渲染帧率低，轮询而非固定 sleep）
  let titleChanged = true;
  try {
    await page.waitForFunction((b) => document.getElementById('event-title').textContent !== b,
      before, { timeout: 20000, polling: 200 });
  } catch (e) { titleChanged = false; }
  ok = await waitState(false);
  const after = await page.evaluate(() => document.getElementById('event-title').textContent);
  s = await snap();
  check('时间推进跨事件：卡片仍展开且内容已更新', ok && titleChanged,
    `${before.slice(0, 12)} → ${after.slice(0, 12)} op=${s.opacity}`);

  // 用户收起
  await page.click('#event-fold');
  ok = await waitState(true);
  s = await snap();
  check('点卡片 ⌄ → 收起', ok, JSON.stringify(s));

  // 收起后再切卡：必须保持收起
  await clickEvent(7);
  ok = await waitState(true);
  s = await snap();
  check('收起后切卡仍保持收起（不被其他按钮翻转）', ok && s.folded, `op=${s.opacity}`);

  // 铃铛再展开 → 显示当前事件
  await page.click('#event-fab');
  ok = await waitState(false);
  s = await snap();
  const cur = await page.evaluate(() => {
    const c = document.querySelector('.ev-item.current .ev-title');
    return c ? c.textContent : null;
  });
  check('再展开显示当前事件内容', ok && (cur === null || s.title === cur),
    `title=${s.title.slice(0, 16)} current=${String(cur).slice(0, 16)}`);

  check('无 pageerror', errs.length === 0, errs.join(' | '));

  await browser.close();
  server.close();
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad}/${results.length} PASS`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ERR', e); server.close(); process.exit(1); });
