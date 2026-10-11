/* debug_bounce.js —— 互反射管线取证：编译期 shaderSource 钩子 + uniform 上传监听 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = 'D:/Programming/HTML/Cassini';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

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

const INIT = `
  window.__probe = { hasBounce: 0, total: 0, locNull: 0, perProg: {}, progSeq: 0 };
  const progIds = new WeakMap();
  function progId(p) {
    let id = progIds.get(p);
    if (id === undefined) { id = ++window.__probe.progSeq; progIds.set(p, id); }
    return id;
  }
  const origSS = WebGL2RenderingContext.prototype.shaderSource;
  WebGL2RenderingContext.prototype.shaderSource = function (prog, src) {
    window.__probe.total++;
    if (src && src.indexOf('uBouncePos') >= 0) window.__probe.hasBounce++;
    return origSS.call(this, prog, src);
  };
  const locMap = new Map();   // locObj -> {name, prog}
  const origGLU = WebGL2RenderingContext.prototype.getUniformLocation;
  WebGL2RenderingContext.prototype.getUniformLocation = function (prog, name) {
    const loc = origGLU.call(this, prog, name);
    if (name === 'uBounceCol' || name === 'uBouncePos' || name === 'uBounceK') {
      if (!loc) { window.__probe.locNull++; }
      else locMap.set(loc, { name, prog: progId(prog) });
    }
    return loc;
  };
  function rec(loc, x, y, z) {
    const e = locMap.get(loc);
    if (e) {
      const k = e.name + '@P' + e.prog;
      window.__probe.perProg[k] = [x, y, z].map((n) => +n.toPrecision(6));
    }
  }
  const origU3fv = WebGL2RenderingContext.prototype.uniform3fv;
  WebGL2RenderingContext.prototype.uniform3fv = function (loc, v) {
    if (locMap.size && loc && v && v.length >= 3) rec(loc, v[0], v[1], v[2]);
    return origU3fv.call(this, loc, v);
  };
  const origU3f = WebGL2RenderingContext.prototype.uniform3f;
  WebGL2RenderingContext.prototype.uniform3f = function (loc, x, y, z) {
    if (locMap.size && loc) rec(loc, x, y, z);
    return origU3f.call(this, loc, x, y, z);
  };
  const origU1f = WebGL2RenderingContext.prototype.uniform1f;
  WebGL2RenderingContext.prototype.uniform1f = function (loc, x) {
    if (locMap.size && loc) rec(loc, x, 0, 0);
    return origU1f.call(this, loc, x);
  };
`;

(async () => {
  const srv = await serve();
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--disable-gpu-sandbox', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
  await page.addInitScript(INIT);
  await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(14000);

  const out = await page.evaluate(() => {
    window.__pauseLoop = true;
    const J2000 = 946728000000;
    window.CassiniTimeline.setNow((Date.parse('2004-12-24T20:00:00Z') - J2000) / 1000);
    window.CassiniTimeline.setPlaying(false);
    window.CassiniScene.setRealisticLighting(true);
    const cam = window.CassiniCamera;
    cam.focus('cassini', { dist: 0.028, animate: false });
    cam.state.anim = null;
    cam.state.sTheta = cam.state.theta; cam.state.sPhi = cam.state.phi; cam.state.sDist = cam.state.dist;
    const S = window.CassiniScene;
    const t = window.CassiniTimeline.state.t;
    const bwc = {};
    for (const [name, e] of S.registryMap) { if (name !== '__sunLight') bwc[name] = e.world; }
    const uw = S.updatePositions(t);
    bwc.cassini = uw.cassWorld;
    bwc.huygens = (window.HuygensVis && window.HuygensVis.tryFocusWorldAt(t)) || uw.cassWorld;
    cam.update(performance.now(), bwc, uw.cassWorld, S);
    S.updateRender(t);
    S.render();
    const P = window.__probe;
    return {
      shadersCompiled: P.total,
      withBounce: P.hasBounce,
      locNull: P.locNull,
      perProg: P.perProg,
    };
  });
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
  srv.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
