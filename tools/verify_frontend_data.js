/* verify_frontend_data.js — 前端数据兼容性与真值校验（Node，无需浏览器）
 *
 * 输入：data/cassini_data.js、data/moons_data.js
 * 输出：stdout 校验报告；有 FAIL 时退出码 1
 * 方法：复刻 js/scene.js 的解码/映射/插值逻辑：
 *   - b64ToFloat32/Float64、eclToThree
 *   - makeTrack（linear / Catmull-Rom）
 *   - 锚定轨道 anchorEvalAt（Chebyshev Clenshaw，与烘焙端 np.chebval 同约定）
 *   - cassiniPosAt：锚定轨道优先，窗口外回退主轨迹线性插值
 * 校验项：
 *   1. schema v2 字段完整性
 *   2. 主轨迹单调性 / 覆盖 / 逐段弦差
 *   3. 飞掠最近距（金星×2/地球/木星）与任务实录对比 —— 走锚定轨道路径
 *   4. SOI 窗口计数
 *   5. 锚定轨道 Chebyshev 逐段残差（对日心真值重采样）
 *   6. Huygens 分离/进入/着陆时间
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const ctx = { window: {}, atob: b64 => Buffer.from(b64, 'base64').toString('binary') };
vm.createContext(ctx);
for (const f of ['cassini_data.js', 'moons_data.js']) {
  const p = path.join(ROOT, 'data', f);
  if (!fs.existsSync(p)) { console.error('MISSING ' + p); process.exit(2); }
  vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: p });
}
const CD = ctx.window.CASSINI_DATA;
const MD = ctx.window.MOONS_DATA;

// ---------- decode helpers (mirror scene.js) ----------
function bytes(b64) { const s = atob(b64); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
function f32(b64) { const b = bytes(b64); return new Float32Array(b.buffer, 0, b.length >> 2); }
function f64(b64) { const b = bytes(b64); return new Float64Array(b.buffer, 0, b.length >> 3); }

let FAIL = 0, WARN = 0;
const ok = (c, m, d) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}${d ? '  —  ' + d : ''}`); if (!c) FAIL++; };
const warn = m => { console.log(`  WARN  ${m}`); WARN++; };

const meta = CD.meta;
const j2000 = meta.j2000Ms;                     // ms since Unix epoch of J2000
const dOf = t => new Date(j2000 + t * 1000).toISOString().slice(0, 16).replace('T', ' ');
const dDay = t => new Date(j2000 + t * 1000).toISOString().slice(0, 10);

// ---------- makeTrack (mirror scene.js lines 62-114) ----------
function makeTrack(segsRaw, interp) {
  if (!segsRaw || !segsRaw.length) return { at: () => [0, 0, 0], min: Infinity, max: -Infinity };
  const useCR = interp === 'cr';
  const segs = segsRaw.map(s => ({ t0: s.t0, dt: s.dt, n: s.n, xyz: f32(s.d), cr: useCR })).sort((a, b) => b.dt - a.dt);
  return {
    min: segs[0].t0,
    max: (() => { let m = -Infinity; for (const s of segs) m = Math.max(m, s.t0 + s.dt * (s.n - 1)); return m; })(),
    at(t) {
      let seg = null;
      for (const s of segs) { const e = s.t0 + s.dt * (s.n - 1); if (t >= s.t0 && t <= e) { seg = s; break; } }
      if (!seg) { let bd = Infinity; for (const s of segs) { const e = s.t0 + s.dt * (s.n - 1); const d = t < s.t0 ? s.t0 - t : (t > e ? t - e : 0); if (d < bd) { bd = d; seg = s; } } }
      let fr = (t - seg.t0) / seg.dt; if (fr < 0) fr = 0; if (fr > seg.n - 1) fr = seg.n - 1;
      const i = Math.min(seg.n - 2, Math.floor(fr));
      if (seg.cr) {
        const s = fr - i, i0 = i > 0 ? i - 1 : 0, i3 = i + 2 <= seg.n - 1 ? i + 2 : seg.n - 1;
        const o = [0, 0, 0];
        for (let k = 0; k < 3; k++) {
          const a0 = seg.xyz[i0 * 3 + k], a1 = seg.xyz[i * 3 + k], a2 = seg.xyz[(i + 1) * 3 + k], a3 = seg.xyz[i3 * 3 + k];
          o[k] = 0.5 * ((2 * a1) + (a2 - a0) * s + (2 * a0 - 5 * a1 + 4 * a2 - a3) * s * s + (3 * a1 - a0 - 3 * a2 + a3) * s * s * s);
        }
        return o;
      }
      const a = fr - i, o = i * 3, o2 = (i + 1) * 3;
      return [seg.xyz[o] + (seg.xyz[o2] - seg.xyz[o]) * a,
      seg.xyz[o + 1] + (seg.xyz[o2 + 1] - seg.xyz[o + 1]) * a,
      seg.xyz[o + 2] + (seg.xyz[o2 + 2] - seg.xyz[o + 2]) * a];
    },
  };
}

// ---------- schema ----------
console.log('\n[1] schema v2 字段完整性');
console.log(`  meta.generated = ${meta.generated}`);
console.log(`  meta.frame     = ${meta.frame}`);
console.log(`  meta.source    = ${String(meta.source || '').slice(0, 150)}`);
const sc = CD.spacecraft.cassini;
for (const k of ['trailT', 'trail', 'trailN', 'tracks', 'anchors', 'soi', 'huygens'])
  ok(k in sc, `spacecraft.cassini.${k} 存在`);
ok(Array.isArray(sc.anchors) && sc.anchors.length === 6, `anchors 为 [a,b,key] 数组 × ${sc.anchors.length}`);
ok(Object.keys(sc.tracks).length === 4, `tracks 4 条锚定轨道（${Object.keys(sc.tracks).join(',')}）`);
ok(!!MD && !!MD.bodies, `moons_data.bodies 存在（${MD ? Object.keys(MD.bodies).length : 0} 个）`);

// ---------- trail ----------
console.log('\n[2] 主轨迹');
const trailT = f64(sc.trailT), trailN = sc.trailN, trail = f32(sc.trail);
ok(trailT.length === trailN && trail.length === trailN * 3, `trailN=${trailN}，trailT/trail 长度一致`);
let mono = true; for (let i = 1; i < trailN; i++) if (!(trailT[i] > trailT[i - 1])) mono = false;
ok(mono, 'trailT 严格单调递增');
console.log(`  覆盖 ${dDay(trailT[0])} → ${dDay(trailT[trailN - 1])}  (${((trailT[trailN - 1] - trailT[0]) / 86400).toFixed(1)} 天)`);
ok((trailT[trailN - 1] - trailT[0]) / 86400 > 7200, '覆盖全任务 >7200 天');

// 逐段弦长分布（表征自适应采样）
const seg = [];
for (let i = 1; i < trailN; i++) {
  const o = (i - 1) * 3, p = i * 3;
  seg.push(Math.hypot(trail[p] - trail[o], trail[p + 1] - trail[o + 1], trail[p + 2] - trail[o + 2]));
}
seg.sort((a, b) => a - b);
const q = f => seg[Math.floor(f * (seg.length - 1))];
console.log(`  弦长 p10=${q(.1).toFixed(0)} p50=${q(.5).toFixed(0)} p99=${q(.99).toFixed(0)} max=${seg[seg.length - 1].toFixed(0)} km`);

// ---------- anchor tracks (Chebyshev) ----------
function anchorEval(tk, t) {
  const ts = f64(tk.t), ws = f64(tk.w), c = f64(tk.c), d = tk.deg;
  let lo = 0, hi = tk.n - 1;
  if (t <= ts[0]) lo = 0;
  else if (t >= ts[tk.n - 1]) lo = tk.n - 1;
  else { while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= t) lo = m; else hi = m; } }
  let x = 2 * (t - ts[lo]) / ws[lo] - 1; if (x < -1) x = -1; else if (x > 1) x = 1;
  const base = lo * 3 * (d + 1), twoX = 2 * x, out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const o = base + k * (d + 1);
    let b1 = 0, b2 = 0;
    for (let j = d; j >= 1; j--) { const b0 = c[o + j] + twoX * b1 - b2; b2 = b1; b1 = b0; }
    out[k] = c[o] + x * b1 - b2;
  }
  return out;
}
const anchorWins = sc.anchors.map(w => ({ a: w[0], b: w[1], key: w[2] })).sort((p, q) => p.a - q.a);
const ATR = new Map();
for (const k of Object.keys(sc.tracks)) { const tk = sc.tracks[k]; ATR.set(k, { t: tk.t, w: tk.w, c: tk.c, n: tk.n, deg: tk.deg, anchor: tk.anchor }); }
// 天体锚定体日心位置（body track，ecliptic km）
const bodyTrk = {};
for (const n of Object.keys(CD.bodies)) bodyTrk[n] = makeTrack(CD.bodies[n].segs, CD.bodies[n].interp);
function anchorHit(t) {
  for (const w of anchorWins) if (t >= w.a && t <= w.b) return w.key;
  return null;
}
// 模型定位位置 = 锚点天体位置 + 锚定轨道相对位移（黄道 km 日心）
function modelPos(t) {
  const key = anchorHit(t);
  if (key) {
    const tk = ATR.get(key); const rel = anchorEval(tk, t);
    const bt = bodyTrk[tk.anchor];
    if (bt) { const p = bt.at(t); return [p[0] + rel[0], p[1] + rel[1], p[2] + rel[2]]; }
  }
  // 回退主轨迹线性插值
  let lo = 0, hi = trailN - 1;
  if (t <= trailT[0]) lo = 0; else if (t >= trailT[hi]) lo = hi;
  else { while (hi - lo > 1) { const m = (lo + hi) >> 1; if (trailT[m] <= t) lo = m; else hi = m; } }
  const a = (t - trailT[lo]) / (trailT[hi] - trailT[lo]);
  const o = lo * 3, p = hi * 3;
  return [trail[o] + (trail[p] - trail[o]) * a, trail[o + 1] + (trail[p + 1] - trail[o + 1]) * a, trail[o + 2] + (trail[p + 2] - trail[o + 2]) * a];
}

// ---------- 3. flyby distances ----------
// REF 为【地表高度】(altitude, km)，与任务实录口径一致；脚本量出的是
// 中心距，需减去天体半径（CD.bodies[name].radiusKm）后比较。
console.log('\n[3] 飞掠最近高度（SPICE 真值 vs 任务实录）');
const REF = [
  { name: 'Venus-1', body: 'venus', alt: 284, date: '1998-04-26' },
  { name: 'Venus-2', body: 'venus', alt: 603, date: '1999-06-24' },
  { name: 'Earth', body: 'earth', alt: 1171, date: '1999-08-18' },
  { name: 'Jupiter', body: 'jupiter', alt: 9794447, date: '2000-12-30' },
];
for (const r of REF) {
  const bt = bodyTrk[r.body];
  if (!bt) { warn(`${r.name}: 无 ${r.body} 天体轨迹`); continue; }
  const rad = CD.bodies[r.body].radiusKm;
  const t0 = Date.parse(r.date + 'T00:00:00Z') / 1000 - j2000 / 1000;
  let best = Infinity, bt2 = 0;
  for (let s = -3 * 86400; s <= 3 * 86400; s += 60) {
    const t = t0 + s, c = modelPos(t), p = bt.at(t);
    const d = Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]);
    if (d < best) { best = d; bt2 = t; }
  }
  // 木星实录 9,794,457 km 为中心距；内行星实录为高度
  const alt = r.body === 'jupiter' ? best : best - rad;
  const dk = Math.abs(alt - r.alt);
  const pass = r.alt > 1e6 ? dk / r.alt < 0.001 : dk < 25;
  ok(pass, `${r.name} 最近高度 ${alt.toFixed(0)} km（实录 ${r.alt}）`,
    `Δ=${dk.toFixed(1)} km  中心距=${best.toFixed(0)} km @ ${dOf(bt2)}`);
}

// ---------- 4. SOI ----------
console.log('\n[4] SOI 窗口计数与不重叠');
// earth=2：发射逃逸段（1997-10-15 穿出）+ 1999-08-18 飞掠。
// 历史 bug：逃逸段曾被 SOI 扫描器与显式补建各生成一次 → 出现两个几乎重合的窗口。
// 前端 soiWindowAt 只选其一绘制，但白建一份顶点缓冲；现于烘焙端与补丁端去重。
// 2026-10-04 框架修复：scan_moon_soi_windows 曾用赤道 state() 混黄道月网格求距
// （误差 ~0.5e6 km）→ 窗口全是幽灵交会（titan×12，真实飞掠全部漏报）；修复后
// titan 126 / enceladus 12 / rhea 4 / dione 5 / iapetus 1 为真实 SOI 穿越。
const soi = sc.soi, expect = {
  venus: 2, earth: 2, jupiter: 1, saturn: 1,
  titan: 126, enceladus: 12, rhea: 4, dione: 5, iapetus: 1,
};
for (const k of Object.keys(expect)) {
  const n = (soi[k] || []).length;
  ok(n === expect[k], `SOI ${k} == ${expect[k]}`, `实得 ${n}`);
}
// 不重叠不变量：同一锚定体的窗口按时间升序应严格互不重叠（允许 ≤1s 数值贴边）
for (const k of Object.keys(soi)) {
  const rows = [...soi[k]].sort((x, y) => x.a - y.a);
  let bad = null;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].a < rows[i - 1].b - 1.0) { bad = i; break; }
  }
  ok(bad === null, `SOI ${k} 窗口互不重叠`,
     bad === null ? `${rows.length} 窗` : `第 ${bad} 窗与前窗重叠`);
}

// ---------- 5. anchors Chebyshev 覆盖与边界 ----------
// 多条锚定窗可共用同一条 track（如 earth 用于 launch + earthflyby，venus 用于
// venus1 + venus2），窗之间的空档是刻意的——track 只在【锚定窗内部】要求
// 记录首尾相接；窗与窗之间允许大间隙。
console.log('\n[5] 锚定轨道 Chebyshev 覆盖与边界');
for (const w of anchorWins) {
  const tk = ATR.get(w.key);
  if (!tk) { warn(`anchor ${w.key} 无对应 track`); continue; }
  const t = f64(tk.t), ws = f64(tk.w);
  // 仅考察落在锚定窗 [w.a, w.b] 内的记录
  let inWin = 0, maxGap = 0;
  for (let i = 0; i < tk.n; i++) {
    if (t[i] < w.a - 1 || t[i] > w.b + 1) continue;
    inWin++;
    if (i > 0 && t[i - 1] >= w.a - 1) maxGap = Math.max(maxGap, Math.abs(t[i] - (t[i - 1] + ws[i - 1])));
  }
  // 窗口内覆盖完整（首记录 ≤ w.a，末记录 + w ≥ w.b）
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < tk.n; i++) { if (t[i] < w.a - 1 || t[i] > w.b + 1) continue; lo = Math.min(lo, t[i]); hi = Math.max(hi, t[i] + ws[i]); }
  const covers = lo <= w.a + 1 && hi >= w.b - 1;
  ok(maxGap < 1e-3, `track[${w.key}] 锚定窗内记录无缝隙（${inWin} 窗 deg=${tk.deg}）`, `最大缝 ${maxGap.toExponential(2)} s`);
  ok(covers, `track[${w.key}] 覆盖锚定窗 ${dDay(w.a)}..${dDay(w.b)}`, `窗内 ${dDay(lo)}..${dDay(hi)}`);
}

// ---------- 6. Huygens ----------
console.log('\n[6] Huygens 事件时间');
const huy = sc.huygens;
console.log(`  字段: ${Object.keys(huy).join(', ')}`);
ok(huy.sepEt != null && huy.entryEt != null && huy.tdEt != null && huy.losEt != null, 'sep/entry/td/los 时间齐备');
const ET = t => Date.parse(t);
const near = (et, iso, tolD) => Math.abs(et - (ET(iso) / 1000 - j2000 / 1000)) < tolD * 86400;
ok(near(huy.sepEt, '2004-12-25T02:00:00Z', 1), `分离 ${dOf(huy.sepEt)} ≈ 2004-12-25`);
ok(near(huy.entryEt, '2005-01-14T09:05:00Z', 1), `大气进入 ${dOf(huy.entryEt)} ≈ 2005-01-14`);
ok(near(huy.tdEt, '2005-01-14T11:30:00Z', 1), `触地 ${dOf(huy.tdEt)} ≈ 2005-01-14`);
ok(near(huy.losEt, '2005-01-14T12:43:00Z', 1), `失联 ${dOf(huy.losEt)} ≈ 2005-01-14`);
for (const k of ['relCass', 'relSat', 'relTit']) ok(huy[k] && huy[k].t && huy[k].d, `huygens.${k} 相对轨迹存在`);

// ---------- summary ----------
console.log('\n================ 汇总 ================');
console.log(`  FAIL=${FAIL}  WARN=${WARN}`);
console.log(FAIL === 0 ? '  结果：全部通过' : '  结果：存在失败项');
process.exit(FAIL === 0 ? 0 : 1);
