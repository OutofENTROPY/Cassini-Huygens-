/* repro_traj_bug.js —— 复现 scene.js 前端几何的数值测试台
 *
 * 目的：在不依赖浏览器的情况下，逐位复刻 js/scene.js 的轨迹几何管线
 *   （b64 解码 → eclToThree → LOESS 平滑 → trail 线性插值 → 行星 track 求值），
 * 验证「1997-10-15 11:40 UTC（发射历元）」时刻：
 *   - 卡西尼标记 (cassiniPosAt)、轨迹顶点 (trailThree)、地球网格 (earth.world)
 *     三者的世界坐标是否自洽（标记应紧贴地球，轨迹应从地球出发）。
 *
 * 输入：data/cassini_data.js, data/moons_data.js
 * 输出：stdout 打印各量世界坐标与相互距离
 * 坐标链：cassini_data.trail(f32 黄道 km) → eclToThree → three 场景 km
 * 校验项：|marker-Earth| ≈ 卡片距离；|trailVertex-Earth| 同量级
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const sandbox = { window: {}, self: {}, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function loadData(f) {
  const code = fs.readFileSync(path.join(ROOT, 'data', f), 'utf8');
  vm.runInContext(code, sandbox, { filename: f });
}

// atob/btoa polyfill（Node 有 Buffer，直接桥接）
sandbox.atob = (b64) => Buffer.from(b64, 'base64').toString('binary');
loadData('cassini_data.js');
loadData('moons_data.js');

const DATA = sandbox.window.CASSINI_DATA;
const MOONS = sandbox.window.MOONS_DATA;
if (!DATA) { console.error('cassini_data 未挂载'); console.error(Object.keys(sandbox.window)); process.exit(1); }

const META = DATA.meta;
const J2000Ms = META.j2000Ms;
console.log('j2000Ms =', J2000Ms, '=', new Date(J2000Ms).toISOString());

const sc = DATA.spacecraft.cassini;

// ---- b64 解码 ----
function b64f64(s) {
  const bin = sandbox.atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float64Array(u8.buffer, 0, u8.byteLength / 8);
}
function b64f32(s) {
  const bin = sandbox.atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(u8.buffer, 0, u8.byteLength / 4);
}
const eclToThree = (v) => [v[0], v[2], -v[1]];

const trailT = b64f64(sc.trailT);
const trailN = sc.trailN;
const xyz = b64f32(sc.trail);

const trailThree = new Float64Array(trailN * 3);
for (let i = 0; i < trailN; i++) {
  const w = eclToThree([xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]]);
  trailThree[i * 3] = w[0]; trailThree[i * 3 + 1] = w[1]; trailThree[i * 3 + 2] = w[2];
}
console.log('trailN =', trailN);
console.log('trailT[0] =', trailT[0], '=', new Date((J2000Ms + trailT[0] * 1000)).toISOString());
console.log('trailT[-1]=', trailT[trailN - 1], '=', new Date((J2000Ms + trailT[trailN - 1] * 1000)).toISOString());

// ---- LOESS 平滑（逐位复刻 scene.js smoothTrailNoise） ----
(function smoothTrailNoise() {
  const M = 10;
  const src = trailThree.slice();
  const p = new Float64Array(7), q = new Float64Array(16);
  const L = new Float64Array(16), y = new Float64Array(12);
  for (let i = 0; i < trailN; i++) {
    const m = Math.min(M, i, trailN - 1 - i);
    if (m < 2) continue;
    const o = i * 3, ti = trailT[i];
    const H = Math.max(ti - trailT[i - m], trailT[i + m] - ti);
    if (!(H > 0)) continue;
    p.fill(0); q.fill(0);
    for (let j = i - m; j <= i + m; j++) {
      const tau = (trailT[j] - ti) / H;
      const u = 1 - tau * tau;
      if (u <= 0) continue;
      const w = u * u;
      const t2 = tau * tau, t3 = t2 * tau;
      const w0 = w, w1 = w * tau, w2 = w * t2, w3 = w * t3;
      p[0] += w0; p[1] += w1; p[2] += w2; p[3] += w3;
      p[4] += w * t2 * t2; p[5] += w * t3 * t2; p[6] += w * t3 * t3;
      const g = j * 3;
      q[0] += w0 * src[g]; q[1] += w0 * src[g + 1]; q[2] += w0 * src[g + 2];
      q[4] += w1 * src[g]; q[5] += w1 * src[g + 1]; q[6] += w1 * src[g + 2];
      q[8] += w2 * src[g]; q[9] += w2 * src[g + 1]; q[10] += w2 * src[g + 2];
      q[12] += w3 * src[g]; q[13] += w3 * src[g + 1]; q[14] += w3 * src[g + 2];
    }
    let done = false;
    for (let D = 4; D >= 1 && !done; D--) {
      let ok = true;
      for (let r = 0; r < D && ok; r++) {
        for (let c = 0; c <= r; c++) {
          let s = p[r + c];
          for (let k = 0; k < c; k++) s -= L[r * 4 + k] * L[c * 4 + k];
          if (r === c) { if (s <= 1e-11) { ok = false; break; } L[r * 4 + c] = Math.sqrt(s); }
          else L[r * 4 + c] = s / L[c * 4 + c];
        }
      }
      if (!ok) continue;
      for (let c = 0; c < 3; c++) {
        for (let r = 0; r < D; r++) {
          let s = q[r * 4 + c];
          for (let k = 0; k < r; k++) s -= L[r * 4 + k] * y[k * 3 + c];
          y[r * 3 + c] = s / L[r * 4 + r];
        }
        for (let r = D - 1; r >= 0; r--) {
          let s = y[r * 3 + c];
          for (let k = r + 1; k < D; k++) s -= L[k * 4 + r] * y[k * 3 + c];
          y[r * 3 + c] = s / L[r * 4 + r];
        }
      }
      trailThree[o] = y[0]; trailThree[o + 1] = y[1]; trailThree[o + 2] = y[2];
      done = true;
    }
  }
})();

// ---- 行星 track 求值（seg + cubic 插值，复刻 makeTrack.at） ----
function makeTrackAt(getSegs) {
  return function at(t, out) {
    const segs = getSegs();
    let seg = null;
    for (const s of segs) { const end = s.t0 + s.dt * (s.n - 1); if (t >= s.t0 && t <= end) { seg = s; break; } }
    if (!seg) {
      let best = segs[segs.length - 1], bd = Infinity;
      for (const s of segs) {
        const end = s.t0 + s.dt * (s.n - 1);
        const d = t < s.t0 ? s.t0 - t : (t > end ? t - end : 0);
        if (d < bd) { bd = d; best = s; }
      }
      seg = best;
    }
    let f = (t - seg.t0) / seg.dt;
    if (f < 0) f = 0; if (f > seg.n - 1) f = seg.n - 1;
    const i = Math.min(seg.n - 2, Math.floor(f));
    if (seg.cr) {
      const s = f - i;
      const i0 = i > 0 ? i - 1 : 0;
      const i3 = i + 2 <= seg.n - 1 ? i + 2 : seg.n - 1;
      const o0 = i0 * 3, o1 = i * 3, o2 = (i + 1) * 3, o3 = i3 * 3;
      for (let k = 0; k < 3; k++) {
        const a0 = seg.xyz[o0 + k], a1 = seg.xyz[o1 + k], a2 = seg.xyz[o2 + k], a3 = seg.xyz[o3 + k];
        out[k] = 0.5 * ((2.0 * a1) + (a2 - a0) * s
          + (2.0 * a0 - 5.0 * a1 + 4.0 * a2 - a3) * s * s
          + (3.0 * a1 - a0 - 3.0 * a2 + a3) * s * s * s);
      }
      return out;
    }
    const a = f - i;
    const o = i * 3, o2 = (i + 1) * 3;
    out[0] = seg.xyz[o] + (seg.xyz[o2] - seg.xyz[o]) * a;
    out[1] = seg.xyz[o + 1] + (seg.xyz[o2 + 1] - seg.xyz[o + 1]) * a;
    out[2] = seg.xyz[o + 2] + (seg.xyz[o2 + 2] - seg.xyz[o + 2]) * a;
    return out;
  };
}

// 把 bodies.<name>.segs 解析成 {t0,dt,n,xyz,cr}
function parseBody(b) {
  const segs = b.segs.map((s) => ({
    t0: s.t0, dt: s.dt, n: s.n, xyz: b64f32(s.d), cr: !!s.cr,
  }));
  return segs;
}

const bodies = DATA.bodies;
console.log('\nbodies keys:', Object.keys(bodies).join(', '));
const earthSegs = parseBody(bodies.earth);
console.log('earth segs[0]: t0=', earthSegs[0].t0, '=',
  new Date((J2000Ms + earthSegs[0].t0 * 1000)).toISOString(),
  'dt=', earthSegs[0].dt, 'n=', earthSegs[0].n);
const earthAt = makeTrackAt(() => earthSegs);

// ---- 目标时刻 ----
const targetISO = process.argv[2] || '1997-10-15T11:40:00Z';
const tTarget = (Date.parse(targetISO) - J2000Ms) / 1000;
console.log('\n==== 时刻', targetISO, '→ t =', tTarget, '====');

// cassiniPosAt 主轨迹分支（无锚定窗口，因为该时段在发射前/初期）
let lo = 0, hi = trailN - 1;
if (tTarget <= trailT[0]) { lo = 0; hi = 1; }
else if (tTarget >= trailT[trailN - 1]) { lo = trailN - 2; hi = trailN - 1; }
else { while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (trailT[mid] <= tTarget) lo = mid; else hi = mid; } }
const aa = (tTarget - trailT[lo]) / (trailT[hi] - trailT[lo] || 1);
const marker = [0, 0, 0];
for (let k = 0; k < 3; k++) marker[k] = trailThree[lo * 3 + k] + (trailThree[hi * 3 + k] - trailThree[lo * 3 + k]) * aa;
const vtx = [trailThree[lo * 3], trailThree[lo * 3 + 1], trailThree[lo * 3 + 2]];

const earthRaw = earthAt(tTarget, [0, 0, 0]);
// 注意：bodies.<name>.segs 存的是【黄道 km】，前端 updatePositions 会做 eclToThree；
// 这里的 earthAt 返回原始黄道值，必须手动旋转后才能与 trailThree（three 系）比较。
const earth = eclToThree(earthRaw);
const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const km = (x) => x.toLocaleString('en-US', { maximumFractionDigits: 0 });
console.log('earth raw ecliptic (km) =', earthRaw.map(km).join(', '));

console.log('\nmarker (three km) =', marker.map(km).join(', '));
console.log('trailVertex[%d] =', lo, vtx.map(km).join(', '));
console.log('earth  (three km) =', earth.map(km).join(', '));
console.log('\n|marker - Earth| =', km(d(marker, earth)), 'km');
console.log('|trailVtx - Earth| =', km(d(vtx, earth)), 'km');
console.log('|marker - trailVtx| =', km(d(marker, vtx)), 'km');
console.log('|marker| (heliocentric) =', km(Math.hypot(...marker)), 'km');
console.log('|Earth|  (heliocentric) =', km(Math.hypot(...earth)), 'km');

// 锚定窗口是否覆盖该时刻？
console.log('\nanchors =', JSON.stringify((sc.anchors || []).slice(0, 3)), '... count=', (sc.anchors || []).length);
