/* scene.js — Solar system scene (true scale + floating origin + real ephemeris)
 * Data frame: ecliptic J2000 heliocentric, km (moons: parent-centered).
 * three.js mapping: three.x = x, three.y = z, three.z = -y (right-handed, +Y = ecliptic north).
 * Precision: double on CPU, meshes positioned relative to camera (floating origin);
 * trail vertices re-based every frame; inside a planet's sphere of influence
 * (Venus/Earth/Jupiter/Saturn) an additional planet-relative trail is shown
 * (NASA Eyes behavior) — the intersection of the two trails IS Cassini's actual
 * rendered position (SOI arcs are baked against the runtime-interpolated planet
 * track, so anchor + relative point reproduces the heliocentric trail exactly).
 */
(function () {
  'use strict';

  /* item 1（真实光照后处理链）前置补丁：本版 three 渲染到 RT 时输出编码强制
   * 线性（outputEncoding 只对画布生效），太阳 bloom 的 rtSun 便拿不到与画布
   * 一致的显示空间值。把编码 chunk 换成硬编码 LinearTosRGB——画布路径（
   * outputEncoding=sRGB）逐位不变，RT 路径从恒等变为与画布相同的编码。
   * 深度/阴影材质（depth/distance RGBA）不以该 chunk 收尾，不受影响；
   * 自定义 ShaderMaterial 不含该 chunk，同样不受影响。须在首个材质程序
   * 编译前执行（模块加载即生效）。 */
  THREE.ShaderChunk.encodings_fragment = 'gl_FragColor = LinearTosRGB( gl_FragColor );';

  const DATA = window.CASSINI_DATA;
  // 卫星细网格（data/moons_data.js，运行时 Catmull-Rom 插值）并入天体表
  if (window.MOONS_DATA) {
    for (const k in window.MOONS_DATA.bodies) DATA.bodies[k] = window.MOONS_DATA.bodies[k];
  }
  const TEXDATA = window.TEXTURE_DATA || {};
  const J2000Ms = DATA.meta.j2000Ms;
  const OBL_E = 23.4392911 * Math.PI / 180;
  const D2R = Math.PI / 180;
  const TAU = Math.PI * 2;

  // ---------- utils ----------
  function b64ToFloat32(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  }
  function b64ToFloat64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float64Array(bytes.buffer);
  }
  function eclToThree(v) { return [v[0], v[2], -v[1]]; }
  function texLoader() {
    const l = new THREE.TextureLoader();
    l.setCrossOrigin('anonymous');
    return l;
  }
  function lowerBound(arr, t) {
    let lo = 0, hi = arr.length - 1;
    if (t <= arr[0]) return 0;
    if (t > arr[hi]) return hi;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arr[mid] <= t) lo = mid; else hi = mid; }
    return lo;
  }
  /* 首个 arr[i] >= t 的下标（bisect_left） */
  function idxGte(arr, t) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // ---------- motion tracks ----------
  // interp='cr'：Catmull-Rom 三次插值（卫星细网格）。与烘焙端 moon_cr 复刻
  // 逐位一致（f32 顶点 + f64 算术、相同公式与边界钳制），是卫星 SOI 相对
  // 轨迹 "anchor + rel ≡ 日心轨迹顶点" 零偏差的前提。
  function makeTrack(segsRaw, interp) {
    if (!segsRaw || !segsRaw.length) {
      return { segs: [], min: -Infinity, max: Infinity, at(t, out) { out[0] = 0; out[1] = 0; out[2] = 0; return out; } };
    }
    const useCR = interp === 'cr';
    const useCRP = interp === 'crp';
    const segs = segsRaw.map(s => ({
      t0: s.t0, dt: s.dt, n: s.n, xyz: b64ToFloat32(s.d), cr: useCR, crp: useCRP,
    })).sort((a, b) => b.dt - a.dt);
    const last = segs[segs.length - 1];
    return {
      segs,
      min: last.t0,
      max: last.t0 + last.dt * (last.n - 1),
      at(t, out) {
        let seg = null;
        for (const s of segs) {
          const end = s.t0 + s.dt * (s.n - 1);
          if (t >= s.t0 && t <= end) { seg = s; break; }
        }
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
        if (seg.cr || seg.crp) {
          const s = f - i;
          const i0 = i > 0 ? i - 1 : 0;
          const i3 = i + 2 <= seg.n - 1 ? i + 2 : seg.n - 1;
          const o0 = i0 * 3, o1 = i * 3, o2 = (i + 1) * 3, o3 = i3 * 3;
          for (let k = 0; k < 3; k++) {
            let a0 = seg.xyz[o0 + k], a1 = seg.xyz[o1 + k], a2 = seg.xyz[o2 + k], a3 = seg.xyz[o3 + k];
            if (seg.crp) {
              // 行星变体：端点区间用镜像外推切线（a0=2a1−a2 / a3=2a2−a1）。标准钳制
              // （a0=a1 / a3=a2）使端点切线只有半弦速——地球段首区间恰好覆盖发射
              // 逃逸段，t=起+67s 处即产生 5,294 km 的欠速偏差。卫星不得改用：烘焙端
              // moon_cr 与本函数钳制版逐位一致（卫星 SOI 零偏差前提）。
              if (i === 0) a0 = 2 * a1 - a2;
              if (i === seg.n - 2) a3 = 2 * a2 - a1;
            }
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
      },
    };
  }

  // ---------- Cassini trail data ----------
  const sc = DATA.spacecraft.cassini;
  const trailT = b64ToFloat64(sc.trailT);
  const trailN = sc.trailN;
  const trailThree = (function () {
    const xyz = b64ToFloat32(sc.trail);
    const a = new Float64Array(trailN * 3);
    for (let i = 0; i < trailN; i++) {
      const w = eclToThree([xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]]);
      a[i * 3] = w[0]; a[i * 3 + 1] = w[1]; a[i * 3 + 2] = w[2];
    }
    return a;
  })();

  /* —— f32 量化噪声平滑（LOESS 式局部加权回归，装载期一次）——
   * 主轨迹顶点为 f32 日心 km：土星距离（~1.4e9 km）处 float32 ULP≈128 km，
   * 顶点携带 σ≈30 km 的白噪声——60 s 节拍段二阶差分中位 64 km（真实曲率
   * 信号 <1 km），近掠段弦长仅数百 km 时锯齿角可达 20°+。放大播放时新顶点
   * 持续进入绘制区间，轨迹末端随之抖动（即"放大运行时轨迹抖动"）。
   * 窗口 = ±M 顶点（首末边界收缩），权重 = 时间三角核 (1−τ²)²：对节拍突变
   * 与自适应疏密稳健（均匀网格 SG 权重跨节拍窗口会产生 Runge 振荡，实测
   * 单点位移可达数十万 km）。基 [1,τ,τ²,τ³]，法方程对称正定 → Cholesky
   * 免主元；退化窗口（对角 ≤1e-11）按嵌套模型降阶 3→2→1，仍退化保持原值。
   * 实测（tools/prototype_smooth.py，v1 数据）：60 s 段二阶差分 64 → 1.5 km
   * 中位，3600 s 段真实曲率（二阶差分 ~130 km）保留，位移中位 ~28 km、
   * p99 ~90 km。trailT 不动，绘制区间 / SOI 窗口 rel / huygens relCass 耦合
   * 等全部下游推导自动一致（同源平滑顶点）。 */
  function smoothTrailNoise() {
    const M = 10;
    const src = trailThree.slice();
    const p = new Float64Array(7);            // p[k] = Σ w·τ^k, k=0..6
    const q = new Float64Array(16);           // q[k*4+c] = Σ w·τ^k·coord_c, k=0..3（嵌套降阶共用）
    const L = new Float64Array(16);           // Cholesky 下三角（≤4×4）
    const y = new Float64Array(12);           // 前代/回代解（3 右端）
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
        q[0] += w0 * src[g];     q[1] += w0 * src[g + 1]; q[2] += w0 * src[g + 2];
        q[4] += w1 * src[g];     q[5] += w1 * src[g + 1]; q[6] += w1 * src[g + 2];
        q[8] += w2 * src[g];     q[9] += w2 * src[g + 1]; q[10] += w2 * src[g + 2];
        q[12] += w3 * src[g];    q[13] += w3 * src[g + 1]; q[14] += w3 * src[g + 2];
      }
      // 基 [1,τ,τ²,τ³]：阶 D 的法方程 = (D+1)² SPD Gram，Cholesky 逐阶尝试
      let done = false;
      for (let D = 4; D >= 1 && !done; D--) {
        // L = cholesky(S)，S[r][c] = p[r+c]
        let ok = true;
        for (let r = 0; r < D && ok; r++) {
          for (let c = 0; c <= r; c++) {
            let s = p[r + c];
            for (let k = 0; k < c; k++) s -= L[r * 4 + k] * L[c * 4 + k];
            if (r === c) {
              if (s <= 1e-11) { ok = false; break; }
              L[r * 4 + c] = Math.sqrt(s);
            } else {
              L[r * 4 + c] = s / L[c * 4 + c];
            }
          }
        }
        if (!ok) continue;
        // 前代 L·y = rhs，回代 Lᵀ·c = y；c[0] = 常数额 = 平滑位置
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
        trailThree[o] = y[0];
        trailThree[o + 1] = y[1];
        trailThree[o + 2] = y[2];
        done = true;
      }
    }
  }
  smoothTrailNoise();

  /* —— 微步顶点塌缩（装载期一次，索引保持）——
   * 烘焙端把多套细网格（SOI 60/600 s、近拱 240 s、Huygens 60 s）、粗网格
   * （3600 s）与迭代细分中点 union 后，会出现「与相邻顶点时间几乎重合
   * （Δt 0.002–5 s）但空间上偏离邻段数 km~134 km」的顶点（实测 3603 处）。
   * 这类顶点连线后形成一段近零长度、近零时间的横移短线，光栅化后就是肉眼
   * 可见的「折线 / 台阶」——即用户反馈的发射段与土星段肘形缺口
   * （如 i=433：Δt=0.21 s、侧偏 1.17 km → 16.5° 折角；经 smoothTrailNoise
   * 的局部三次拟合还会放大到 92.7°）。
   *
   * 塌缩几何（不改 trailT / trailN，下游 idxNow / rel / huygens 索引全不变）：
   * 对每个微步顶点 i，取其前后第一个「时间分离 ≥ MIN_DT」的锚顶点 L、R，把 i
   * 按时间线性插值投到 L→R 弦上 → 短线退化为共线。
   *
   * 安全性论证（为何搬动不引入可见误差）：
   *   搬移量上限判据 = max(1·ULP(world), TRAIL_TOL)，其中 ULP = |world|·2⁻²⁴·2
   *   为 f32 顶点的量化步长、TRAIL_TOL = 30 km 为烘焙端弦差容限。
   *   - 近场（|world| < 1.26e8 km → ULP < 30 km）：判据 = 30 km = 轨迹自身
   *     保真预算，搬动后误差不超过邻弦既有误差，必然不可见（发射段实测搬移
   *     中位 3.1 km / 最大 8.3 km）。
   *   - 远场（土星段 |world| ≈ 1.5e9 km → ULP ≈ 358 km）：判据 = ULP，即误差
   *     < f32 表示精度——无论如何都不可表示、屏上不可见。
   *   实测：3603 处全部满足（最大搬移 133.9 km，位于土星段，< 该处 ULP）；
   *   发射段折角 16.5°/17.0° → 4.2°；全局 p99 20.9° → 14.3°；真实物理
   *   特征（如 i≈48856 的 103.3° 深空转向）完全保留。 */
  (function collapseMicroSteps() {
    const MIN_DT = 5.0;         // 判定微步的时间阈值（s）
    const TRAIL_TOL = 30.0;     // km，与烘焙端一致
    const ULP_F = Math.pow(2, -23) * 2;   // f32 相对量化步长（ULP/|x|）
    // 预计算每个顶点的前后锚（时间间隔 ≥ MIN_DT 的邻居）
    const prevAnchor = new Int32Array(trailN);
    const nextAnchor = new Int32Array(trailN);
    {
      let last = 0;
      for (let i = 0; i < trailN; i++) {
        if (i > 0 && trailT[i] - trailT[i - 1] >= MIN_DT) last = i - 1;
        prevAnchor[i] = last;
      }
      last = trailN - 1;
      for (let i = trailN - 1; i >= 0; i--) {
        if (i < trailN - 1 && trailT[i + 1] - trailT[i] >= MIN_DT) last = i + 1;
        nextAnchor[i] = last;
      }
    }
    let nFix = 0, maxMove = 0;
    for (let i = 1; i < trailN - 1; i++) {
      const dPrev = trailT[i] - trailT[i - 1];
      const dNext = trailT[i + 1] - trailT[i];
      if (dPrev >= MIN_DT && dNext >= MIN_DT) continue;   // 两侧都分离 → 正常顶点
      const L = prevAnchor[i], R = nextAnchor[i];
      if (L >= i || R <= i || R <= L) continue;
      const span = trailT[R] - trailT[L];
      if (!(span > 0)) continue;
      const a = (trailT[i] - trailT[L]) / span;
      const lo = L * 3, hi = R * 3, o = i * 3;
      const nx = trailThree[lo] + (trailThree[hi] - trailThree[lo]) * a;
      const ny = trailThree[lo + 1] + (trailThree[hi + 1] - trailThree[lo + 1]) * a;
      const nz = trailThree[lo + 2] + (trailThree[hi + 2] - trailThree[lo + 2]) * a;
      const dx = trailThree[o] - nx, dy = trailThree[o + 1] - ny, dz = trailThree[o + 2] - nz;
      const mv = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (mv <= 1e-4) continue;                            // 已在弦上，无需搬动
      const rad = Math.sqrt(trailThree[o] * trailThree[o]
        + trailThree[o + 1] * trailThree[o + 1]
        + trailThree[o + 2] * trailThree[o + 2]);
      const lim = Math.max(rad * ULP_F, TRAIL_TOL);
      if (mv <= lim) {
        trailThree[o] = nx; trailThree[o + 1] = ny; trailThree[o + 2] = nz;
        nFix++; if (mv > maxMove) maxMove = mv;
      }
    }
    if (nFix) console.info(`[trail] collapseMicroSteps: 塌缩 ${nFix} 顶点（最大搬移 ${maxMove.toFixed(2)} km）`);
  })();

  // ---------- 锚定轨道（schema v2 tracks/anchors：模型定位 ≤1 km） ----------
  // track = {t f64[n窗], w f64[n窗], c f64[n窗×3×(deg+1)], deg, anchor}；
  // 每窗口 [t_i, t_i+w_i] 位置 = 切比雪夫（相对锚定体，黄道 km），窗口互不重叠。
  // anchors = [[a, b, key], ...]：t∈[a,b] 时模型定位走锚定轨道（与天体历表同
  // 内核派生、f64 全程求值），窗口外回退主轨迹插值（线渲染精度）。
  const anchorWins = (sc.anchors || [])
    .map((w) => ({ a: w[0], b: w[1], key: w[2] }))
    .sort((p, q) => p.a - q.a);
  const anchorTracks = new Map();
  for (const tkKey of Object.keys(sc.tracks || {})) {
    const tk = sc.tracks[tkKey];
    anchorTracks.set(tkKey, {
      t: b64ToFloat64(tk.t), w: b64ToFloat64(tk.w), c: b64ToFloat64(tk.c),
      n: tk.n, deg: tk.deg, anchor: tk.anchor,
    });
  }
  const _anchRel = [0, 0, 0];
  const _anchBody = [0, 0, 0];
  const _anchParent = [0, 0, 0];   // frameAnchorAt 父体专用暂存——不可复用 _anchBody：
                                   // 调用方（writeTailLine/cassiniPosAt）常以 _anchBody
                                   // 作 out 传入，若父体也写入 _anchBody 会先覆盖掉
                                   // entry.track 的结果再自加 → 卫星锚返回 2×父体，
                                   // 卫星相对尾迹整体错位（Ta 接缝 14,960 km 的根因）

  function anchorEvalAt(tk, t, out) {
    // Clénshaw 递推（与烘焙端 np.chebval 同约定）；窗口二分（时间有序不重叠）
    const ts = tk.t, ws = tk.w, c = tk.c, d = tk.deg;
    let lo = 0, hi = tk.n - 1;
    if (t <= ts[0]) { lo = 0; }
    else if (t >= ts[tk.n - 1]) { lo = tk.n - 1; }
    else {
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; }
    }
    let x = 2 * (t - ts[lo]) / ws[lo] - 1;
    if (x < -1) x = -1; else if (x > 1) x = 1;
    const base = lo * 3 * (d + 1), twoX = 2 * x;
    for (let k = 0; k < 3; k++) {
      const o = base + k * (d + 1);
      let b1 = 0, b2 = 0;
      for (let j = d; j >= 1; j--) {
        const b0 = c[o + j] + twoX * b1 - b2;
        b2 = b1; b1 = b0;
      }
      out[k] = c[o] + x * b1 - b2;
    }
    return out;
  }

  /* 锚定体（含父体链）在时刻 t 的黄道位置（km）——相对轨迹帧变换用。
   * 必须逐点按采样时刻求值，不能复用 registry 的当前帧 world。 */
  function frameAnchorAt(entry, t, out) {
    entry.track.at(t, out);
    if (entry.parent) {
      const p = registry.get(entry.parent);
      if (p && p.track) {
        p.track.at(t, _anchParent);
        out[0] += _anchParent[0]; out[1] += _anchParent[1]; out[2] += _anchParent[2];
      }
    }
    return out;
  }

  /* 主轨迹折线插值（与渲染顶点同一 f64 来源，逐位一致） */
  function mainTrailAt(t, out) {
    let lo = 0, hi = trailN - 1;
    if (t <= trailT[0]) { lo = 0; hi = 1; }
    else if (t >= trailT[trailN - 1]) { lo = trailN - 2; hi = trailN - 1; }
    else {
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (trailT[mid] <= t) lo = mid; else hi = mid; }
    }
    const a = (t - trailT[lo]) / (trailT[hi] - trailT[lo] || 1);
    const o = lo * 3, o2 = hi * 3;
    out[0] = trailThree[o] + (trailThree[o2] - trailThree[o]) * a;
    out[1] = trailThree[o + 1] + (trailThree[o2 + 1] - trailThree[o + 1]) * a;
    out[2] = trailThree[o + 2] + (trailThree[o2 + 2] - trailThree[o + 2]) * a;
    return out;
  }

  /* 锚定轨道窗口边缘融合宽度（s）：锚定路径（真历表 + rel cheb）与渲染折线
   * （f32 顶点）存在 ±10~20 km 的量化层差，在窗口进入/离开时刻表现为尾迹
   * 末端 ~30 km 的横向阶跃折角（发射段 t=起+60s 处即用户反馈的残折）。
   * 边缘 BLEND 秒内按 smoothstep 混回主轨迹折线（边缘处逐位贴合），中段
   * 保持锚定轨道的亚顶点平滑。 */
  const ANCHOR_BLEND = 1800.0;
  const _polyP = [0, 0, 0];

  function cassiniPosAt(t, out) {
    // 锚定轨道优先（模型定位精度）；未命中窗口 → 主轨迹线性插值
    for (let i = 0; i < anchorWins.length; i++) {
      const w = anchorWins[i];
      if (t >= w.a && t <= w.b) {
        const tk = anchorTracks.get(w.key);
        const body = tk && registry.get(tk.anchor);
        if (tk && body && body.track) {
          anchorEvalAt(tk, t, _anchRel);
          const v = eclToThree(_anchRel);
          // 锚定体位置按【采样时刻 t】求值（frameAnchorAt），而非 registry 的
          // 当前帧 world：动态尾迹以 t 之前的时刻重采样，用当前帧位置会引入
          // body.world(t_now) − body.world(t_i) 的时变平移（发射段地球 960 s
          // 位移约 2.9 万 km），使尾迹相对 flown/full 折出近直角。
          frameAnchorAt(body, t, _anchBody);
          const b = eclToThree(_anchBody);
          out[0] = b[0] + v[0];
          out[1] = b[1] + v[1];
          out[2] = b[2] + v[2];
          const edge = Math.min(t - w.a, w.b - t);
          if (edge < ANCHOR_BLEND) {
            const u = edge / ANCHOR_BLEND;
            const uu = u * u * (3 - 2 * u);
            mainTrailAt(t, _polyP);
            out[0] = _polyP[0] + (out[0] - _polyP[0]) * uu;
            out[1] = _polyP[1] + (out[1] - _polyP[1]) * uu;
            out[2] = _polyP[2] + (out[2] - _polyP[2]) * uu;
          }
          return out;
        }
      }
    }
    return mainTrailAt(t, out);
  }
  function trailIndexAt(t) {
    let lo = 0, hi = trailN - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (trailT[mid] <= t) lo = mid; else hi = mid; }
    return lo;
  }

  // ---------- SOI planet-relative trails (baked, item 3) ----------
  // soi[name] = [win...]；win = {a, b}（时间域端点，烘焙端给出）或旧版
  // {t, d, n} 行数据（兼容：只取其时间端点）。窗口几何 = 主轨迹顶点的子区间
  // [i0, i0+n)：烘焙端保证窗口内 merged 点即相对轨迹（rel = merged − planet32），
  // 直接用世界系 f64 主轨迹顶点渲染可免除旧 f32 相对坐标在土星距离下的
  // ~60 m 量化偏差（放大到最大时相对轨迹与模型脱开的原因），且"相对轨迹 ∩
  // 日心轨迹 = Cassini 实际位置"恒精确成立。
  const soiRaw = sc.soi || {};
  const soiPlanets = new Map();  // name -> { entry, wins: [{a, b, times, i0, n, full, flown, colAttr}] }
  // 真实引力影响球半径 km —— 与烘焙端 SOI_RADII / MOON_SOI / 窗口边界逐值一致：
  // 进入显示 → 相对轨迹淡入；脱离 → 淡出自动隐藏（窗口全程覆盖 k>0 区间）。
  // 卫星为 Laplace SOI：a·(μ_m/μ_sat)^(2/5)，供二级相对轨迹（item 3）。
  const SOI_SHOW = {
    venus: 6.169e5, earth: 9.247e5, jupiter: 4.82e7, saturn: 5.45e7,
    titan: 4.33e4, enceladus: 4.9e2, rhea: 3.68e3, dione: 1.95e3,
    tethys: 1.21e3, iapetus: 2.25e4, mimas: 2.49e2, moon: 6.61e4,
  };

  function soiWindowAt(sp, t) {
    let best = null, bestDt = Infinity;
    for (const w of sp.wins) {
      if (t >= w.a && t <= w.b) {
        const dt = (w.b - w.a) / Math.max(1, w.n - 1);
        if (dt < bestDt) { bestDt = dt; best = w; }
      }
    }
    return best;
  }

  // ---------- bodies ----------
  const BODIES = [
    { name: 'sun', radius: 696000, tex: 'proc:sun', emissive: true, label: 'Sun' },
    { name: 'mercury', radius: 2439.7, tex: 'mercury', label: 'Mercury', flatten: 0.0009 },
    { name: 'venus', radius: 6051.8, tex: 'venus', label: 'Venus', glow: '#e8d8a8', atmo: { color: 0xe8d8a0, intensity: 0.55, power: 2.6 } },
    { name: 'earth', radius: 6371, tex: 'earth', label: 'Earth', clouds: true, glow: '#6fa8ff',
      // NASA Eyes AtmosphereComponent 参数：色 (0.841,1.047,1.5) HDR 蓝、日落 (1,.5,0)×1.2；
      // halo = 盘外大气辉光壳；夜面城市灯光 earthNight（NASA Eyes 夜贴图）；海洋镜面见 Phong 材质。
      // power 3.4 让蓝晕铺进盘面内侧 + wash 昼面常数薄雾（整体淡蓝、NASA Eyes
      // 观感）——只靠 rim 会留下饱和深蓝的海洋中部
      atmo: { color: [0.841, 1.047, 1.5], intensity: 0.62, power: 3.4, wash: 0.12,
              sunset: { color: [1.0, 0.5, 0.0], intensity: 1.2 },
              // 城市灯光压到真实观感：夜贴图城市核心接近纯白，1.25 会把夜面
              // 照成成片亮斑——从太空看城市只是暗弱的琥珀色光点簇
              night: { tex: 'earthNight', intensity: 0.5 },
              halo: { color: [0.42, 0.66, 1.0], intensity: 0.9 } },
      flatten: 0.0034 },
    { name: 'mars', radius: 3389.5, tex: 'mars', label: 'Mars', atmo: { color: 0xc08060, intensity: 0.3, power: 3.2 }, flatten: 0.0059 },
    { name: 'jupiter', radius: 69911, tex: 'jupiter', label: 'Jupiter', glow: '#d8c0a0', rings: true,
      // 真实扁率：(赤道 71492 − 极 66854) / 71492 ≈ 0.0649——快速自转的
      // 气态巨行星为扁椭球，压极轴、赤道半径不变
      flatten: 0.0649 },
    { name: 'saturn', radius: 58232, tex: 'saturn', label: 'Saturn', rings: true, glow: '#e8d8a8',
      // 大气散射（Grand Finale 坠入段放大到模型大小时可见）：暖金边缘光 + 盘外
      // 辉光壳——卡西尼实拍土星 limb 为奶油金霾，强度/宽度取 Venus 与 Titan 之间
      atmo: { color: 0xd8b878, intensity: 0.5, power: 2.6, wash: 0.04,
              halo: { color: 0xf0e2b6, intensity: 0.85 } },
      // 扁率 0.098 = (60268−54364)/60268——行星之最；环仍在赤道面，不受 Y 压缩影响
      flatten: 0.0980 },
    { name: 'uranus', radius: 25362, tex: 'uranus', label: 'Uranus', rings: true, flatten: 0.0229 },
    { name: 'neptune', radius: 24622, tex: 'neptune', label: 'Neptune', rings: true, flatten: 0.0171 },
    // 卫星扁率 = (a−c)/a，三轴 limb 拟合取 Thomas (2010, Icarus 208)；金星/太阳 f≈0 不设
    { name: 'moon', radius: 1737.4, tex: 'moon', label: 'Moon', flatten: 0.0012 },
    { name: 'titan', radius: 2574.7, tex: 'titan', label: 'Titan',
      // 泰坦 = 太阳系最浓的卫星大气（地表气压 1.45 atm）：盘缘橙金 rim +
      // 盘外辉光壳。真实泰坦 limb 为不透明橙霾、可见厚度数倍于类地行星
      // （Huygens 探空：雾霾层顶 ~500 km ≈ 1.2R）——halo 衰减尺度放慢
      // （spread），光晕更厚更饱和；壳缘窗口仍精确归零无硬边
      atmo: { color: 0xd89550, intensity: 0.65, power: 2.4,
              halo: { color: 0xf0a860, intensity: 1.0, spread: 2.2 } },
      flatten: 0.0011 },
    { name: 'enceladus', radius: 252.1, tex: 'enceladus', label: 'Enceladus', flatten: 0.228 },
    // Iapetus：NASA Cassini ISS 真实镶嵌（替换有误的程序化贴图）；texOffset 把暗区
    // （Cassini Regio）质心对齐到轨道前导半球——潮汐锁定下本地 +X（u=0.5）指向
    // Saturn，顺行卫星前导方向 = 本地 +Z = u 0.25；原镶嵌暗区质心 u≈0.2523
    // Iapetus：早期快速自转减速遗留的永久变形，(746−712)/746 ≈ 0.046
    { name: 'iapetus', radius: 734.5, tex: 'iapetus', texOffset: 0.0023, label: 'Iapetus', flatten: 0.046 },
    // 土星内卫星：NASA Eyes color 立方面重投影（tools/build_textures.py 烘焙）
    { name: 'rhea', radius: 763.8, tex: 'rhea', label: 'Rhea', flatten: 0.0013 },
    { name: 'dione', radius: 561.4, tex: 'dione', label: 'Dione', flatten: 0.003 },
    { name: 'tethys', radius: 531.1, tex: 'tethys', label: 'Tethys', flatten: 0.048 },
    { name: 'mimas', radius: 198.2, tex: 'mimas', label: 'Mimas', flatten: 0.083 },
  ];

  // 轴倾角 [tilt°, node°]（tiltGroup 定向，欧拉序 YXZ：先绕 X 倾斜、再绕 Y 转到
  // 节点方向）。取值 = IAU 北极（RA/Dec）转到黄道 J2000 系后的极轴：
  //   tilt = 极轴与黄道北夹角，node = atan2(极轴 three.x, 极轴 three.z)。
  // 此前用默认 XYZ 欧拉序且把倾斜放在 rotation.z 上——绕 Y 的 node 旋转不改变
  // +Y 轴自身、倾倒方向恒为 three +Z（黄经 -90°），土星环面因此与卫星实际
  // 轨道面（IAU 极轴，黄经 79.6°）差约 170° 方位角，视觉上环与卫星轨道
  // 完全不共面。现值使环面与卫星历表轨道面共面（逐星拟合偏差 ≤0.06°）。
  // SPIN：真实自转（IAU）——period 为恒星自转周期（秒，负 = 逆行），
  // w0 = J2000 时刻本初子午线西经（°）。供渲染与"朝向/自转状态"面板。
  const TILT = {
    sun: [7.25, 75.77], mercury: [7.03, 48.26], venus: [1.24, 120.19], earth: [23.44, 0],
    mars: [26.71, 82.91], jupiter: [2.22, -22.18], saturn: [28.05, 169.53],
    uranus: [82.28, -12.35], neptune: [28.49, 48.79], moon: [0, 0],
    titan: [0, 0], enceladus: [0, 0], iapetus: [0, 0], rhea: [0, 0],
    dione: [0, 0], tethys: [0, 0], mimas: [0, 0],
  };
  // 地球云层相对地表的漂移角速度（单位 = 地表自转角速度的倍数）。
  // 正值 = 云层比地表转得快（相对东漂）；负值 = 相对西漂。
  // 当前 -0.25：差速量级与之前相同（每恒星日相对地表 90°），方向已反转为向西；
  // 云层绝对角速度仍与地表同向，为地表的 0.75 倍。想调快慢/方向改这一个数即可。
  const EARTH_CLOUD_DRIFT = -0.25;
  const SPIN = {
    sun: { period: 2192832, w0: 84.176, tilt: 7.25, retro: false, note: '差旋 25.4 日（赤道）' },
    mercury: { period: 5067031, w0: 329.75, tilt: 0.03, retro: false },
    venus: { period: -20997360, w0: 160.2, tilt: 177.36, retro: true },
    earth: { period: 86164.1, w0: 190.147, tilt: 23.44, retro: false },
    mars: { period: 88642.66, w0: 176.63, tilt: 25.19, retro: false },
    jupiter: { period: 35730, w0: 284.95, tilt: 3.13, retro: false },
    saturn: { period: 38052, w0: 38.9, tilt: 26.73, retro: false, note: 'System III' },
    // IAU 极轴即右手极（W 随时间增加），period 取正；"逆行"仅为显示标注
    // （自转轴倾过 90° 的经典说法）
    uranus: { period: 62063, w0: 203.81, tilt: 97.77, retro: true, note: 'IAU 右手极' },
    neptune: { period: 57996, w0: 253.18, tilt: 28.32, retro: false },
    moon: { period: 2360591.5, w0: 38.32, tilt: 6.68, retro: false, lock: 'earth' },
    titan: { period: 1377648, w0: 0, tilt: 0, retro: false, lock: 'saturn' },
    enceladus: { period: 118386, w0: 0, tilt: 0, retro: false, lock: 'saturn' },
    iapetus: { period: 6853498, w0: 0, tilt: 0, retro: false, lock: 'saturn' },
    rhea: { period: 390373, w0: 0, tilt: 0, retro: false, lock: 'saturn' },
    dione: { period: 236470, w0: 0, tilt: 0, retro: false, lock: 'saturn' },
    tethys: { period: 163105, w0: 0, tilt: 0, retro: false, lock: 'saturn' },
    mimas: { period: 81425, w0: 0, tilt: 0, retro: false, lock: 'saturn' },
  };

  const registry = new Map();

  let renderer, scene, camera, labelsEl;
  let sunLight, ambient;
  let shipSunLight = null;   // 飞船专属平行光（真实光照模式承担直射光 + 自阴影）
  let realisticOn = false;   // 真实光照模式（主循环内掩食计算仅在此模式生效）
  // 直射光强度：两种模式恒定 —— 取原真实 3.0 / 普通 1.15 的平均（见 setRealisticLighting）
  const SUN_INTENSITY = 2.075;
  let skyMesh = null;
  let trailFullLine, trailFlownLine;   // heliocentric frame
  // 动态尾迹（3 张同布局，帧不同）：烘焙顶点节拍最长滞后一拍（巡航 6 h 节拍 ×
  // 30 km/s = 64.8 万 km 弦），旧单段 leader 直线桥接在回放中弦长锯齿 0→一整弦，
  // 且锚定轨道激活后弦相对真实路径的矢高差（土星段中位 37 km、极值 1,800 km）
  // 使轨迹末端绕飞船来回摆动。改为逐帧以 cassiniPosAt 重采样真实路径（与标记/
  // 模型/相机目标同一函数 → 末端与飞船零相对偏差）：起点 = 修剪后的烘焙末顶点
  // （同一时刻求值，逐位重合），末端延伸至下一烘焙顶点与 future 线无缝相接。
  // abs = 日心系；planet/moon = 一级/二级 SOI 相对系（随对应窗口线同步显隐）。
  let tailAbs, tailPlanet, tailMoon;
  const TAIL_VERTS = 16;               // 起点顶点 + 11 中间采样 + 当前位置 + 下一顶点 + 余量
  const TAIL_BASE = [1.0, 0.827, 0.498];
  const tailTimes = new Float64Array(TAIL_VERTS);   // 日心系采样时刻（f64）
  const tailPts = new Float64Array(TAIL_VERTS * 3); // 日心系采样位置（f64，three 轴）
  let tailCount = 0;                   // 本帧有效顶点数
  let tailIdxTail = 0;                 // 本帧尾迹衔接点（flown 修剪共用，updateRender 前段求值）
  const trailPosBuffer = new Float32Array(trailN * 3);
  let cassiniMarker, cassiniModel, cassiniStack, cassiniOrbiter, huygensMesh;

  const HUYGENS_SEP_ET = (Date.parse('2004-12-25T02:00:00Z') - J2000Ms) / 1000;

  const camWorld = { x: 0, y: 0, z: 0 };
  const tmpV = [0, 0, 0];

  // 轨迹显示选项（item 2）：future=未来轨迹开关；mode='recent'|'all' 近期/全部历史；
  // planetOrbits=行星/卫星轨道线；cassini=Cassini 日心轨迹（含 SOI 相对轨迹）；
  // huygens=Huygens 轨迹（绝对 + 一级/二级相对）
  const trailOptions = { future: true, mode: 'all', planetOrbits: true, cassini: true, huygens: true };
  const RECENT_SPAN = 365.25 * 86400;
  const RECENT_RAMP = RECENT_SPAN * 0.5;   // 近期轨迹在最后 RAMP 段平滑淡出至消失，而非截断

  // ---------- osculating orbit elements -> ellipse rebuild ----------
  function solveE(M, e) {
    if (e < 1) {
      M = ((M + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      if (e > 0.8) {
        let lo = -Math.PI, hi = Math.PI;
        const flo = lo - e * Math.sin(lo) - M;
        for (let i = 0; i < 64; i++) {
          const mid = 0.5 * (lo + hi);
          const f = mid - e * Math.sin(mid) - M;
          if ((f > 0) === (flo > 0)) lo = mid; else hi = mid;
        }
        return 0.5 * (lo + hi);
      }
      let E = M;
      for (let i = 0; i < 40; i++) {
        const f = E - e * Math.sin(E) - M;
        E -= f / (1 - e * Math.cos(E));
        if (Math.abs(f) < 1e-12) break;
      }
      return E;
    }
    // hyperbolic (pioneer convention: f = E - e*sinhE - M, monotonically decreasing)
    if (M < 0) {
      let lo = 0, hi = 1;
      while (hi - e * Math.sinh(hi) - M > 0) hi *= 2;
      for (let i = 0; i < 80; i++) {
        const mid = 0.5 * (lo + hi);
        if (mid - e * Math.sinh(mid) - M > 0) lo = mid; else hi = mid;
      }
      return 0.5 * (lo + hi);
    }
    let lo = -1, hi = 0;
    while (lo - e * Math.sinh(lo) - M < 0) lo *= 2;
    for (let i = 0; i < 80; i++) {
      const mid = 0.5 * (lo + hi);
      if (mid - e * Math.sinh(mid) - M > 0) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
  }
  function elemPosEcl(a, e, n, M0, qw, qx, qy, qz, M) {
    const E = solveE(M, e);
    let px, py;
    if (e < 1) {
      const b = a * Math.sqrt(1 - e * e);
      px = a * (Math.cos(E) - e); py = b * Math.sin(E);
    } else {
      px = a * (e - Math.cosh(E)); py = a * Math.sqrt(e * e - 1) * Math.sinh(E);
    }
    const tx = 2 * (qy * 0 - qz * py), ty = 2 * (qz * px - qx * 0), tz = 2 * (qx * py - qy * px);
    const vx = px + qw * tx + (qy * tz - qz * ty);
    const vy = py + qw * ty + (qz * tx - qx * tz);
    const vz = qw * tz + (qx * ty - qy * tx);
    const ce = Math.cos(OBL_E), se = Math.sin(OBL_E);
    return [vx, vy * ce + vz * se, -vy * se + vz * ce];
  }
  /* 根数关键帧选取：取 t 之前的最后一帧（而非最近帧）。各关键帧 M0 相互独立
   * 拟合、不连续（实测 Mimas 相邻帧位置可差 6.2 万 km、Rhea 47 万 km）——
   * 最近帧选取在时间推进中每半个帧距翻转一次，轨道线随之整条跳位（卫星
   * 轨迹抖动的根源）。固定取前一帧 + 与几何重建同帧的平移修正后，帧间严格
   * 连续，跳变只剩重建时刻的微小形状修正。 */
  function elemsKeyLo(entry, t) {
    const eT = entry.elems.eT;
    let lo = 0, hi = eT.length - 1;
    if (t <= eT[0]) return 0;
    if (t >= eT[hi]) return hi - 1;   // 末帧保留外推语义
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (eT[mid] <= t) lo = mid; else hi = mid; }
    return lo;
  }
  /* 相位中心化重建：顶点 N/2 精确落在当前平近点角 M(t) 上（消除固定相位网格
   * 在行星处的弦偏差——放大到行星大小时轨迹与模型严格重合的关键），再配合
   * 逐帧平移修正（实际历表位置 − 椭圆位置），交点零偏差。 */
  function rebuildOrbitLine(entry, t) {
    const els = entry.elems;
    if (!els || els.n < 2) return;
    const k = elemsKeyLo(entry, t);
    const o = k * 8;
    const a = els.eV[o], e = els.eV[o + 1], n = els.eV[o + 2], M0 = els.eV[o + 3];
    const qw = els.eV[o + 4], qx = els.eV[o + 5], qy = els.eV[o + 6], qz = els.eV[o + 7];
    const Mt = M0 + n * (t - els.eT[k]);
    entry._orbitMt = Mt;   // 顶点网格的相位锚点（applyOrbitFade 的年龄零点）
    entry._orbitK = k;     // 锚点所用关键帧（淡出端用同帧外推，避免跨关键帧 M 跳变）
    const attr = entry.orbitLineObj.geometry.attributes.position;
    const N = attr.count;
    for (let i = 0; i < N; i++) {
      const M = Mt + TAU * (i / N - 0.5);
      const v = elemPosEcl(a, e, n, M0, qw, qx, qy, qz, M);
      const w = eclToThree(v);
      attr.setXYZ(i, w[0], w[1], w[2]);
    }
    attr.needsUpdate = true;
    entry._orbitEpoch = t;
  }
  /* 当前历元椭圆上 M(t) 相位处的位置——与最后一次几何重建【同一关键帧】
   * 外推（entry._orbitK；未重建过时取前一帧）。逐帧平移修正 Δ = 实际历表位置
   * − 该帧椭圆位置因此帧间连续，不再随最近帧翻转跳变。 */
  function ellipsePosEcl(entry, t, out) {
    const els = entry.elems;
    if (!els || els.n < 2) return false;
    const k = entry._orbitK !== undefined ? entry._orbitK : elemsKeyLo(entry, t);
    const o = k * 8;
    const v = elemPosEcl(els.eV[o], els.eV[o + 1], els.eV[o + 2], els.eV[o + 3],
      els.eV[o + 4], els.eV[o + 5], els.eV[o + 6], els.eV[o + 7],
      els.eV[o + 3] + els.eV[o + 2] * (t - els.eT[k]));
    out[0] = v[0]; out[1] = v[1]; out[2] = v[2];
    return true;
  }

  /* —— 行星/卫星轨迹随时间淡出（彗尾式尾迹）——
   * 顶点按平近点角均布（rebuildOrbitLine 相位中心化，N/2 号顶点落在天体当前
   * M 上），而平近点角随时间均匀推进 → 各顶点「天体离开时长」与序号严格
   * 线性（单位：圈，0 = 天体当前位置）。逐顶点按年龄指数衰减：身后最亮，
   * 越早经过的越暗，越过半圈（对侧）后完全隐没。衰减时距取
   * 公转周期的固定比例，水星（88 天）与海王星（165 年）视觉节奏一致。
   * 两次重建之间天体沿顶点网格继续前行，用相位推进量 dph 平移年龄分布，
   * 亮头无需重建顶点位置即可始终贴住天体。dph 一律用「重建时关键帧」外推
   * 天体当前 M——各关键帧 M0 独立拟合、相互不连续（相邻帧可差数 rad），
   * 跨关键帧求差会让亮头跳位；同帧外推与网格严格同系、精确连续。 */
  const ORBIT_TAU_FRAC = 0.65;   // 衰减时距 = 0.10 × 公转周期：亮弧贴住天体身后 ~1/8 圈
  /* 对侧（age ≥ 0.5 圈）硬归零：指数尾在对侧仍余 ~1.5%，经 sRGB 输出伽马
   * 提亮后会留下一条隐约可见的「幽灵半椭圆」，稀释淡出观感；该亮度本身
   * 已低于可见阈值，硬切无可见跳变。 */
  const ORBIT_CUT = 1.0;
  function applyOrbitFade(entry, t) {
    const colAttr = entry.orbitColAttr;
    if (!colAttr || entry._orbitMt === undefined) return;
    const els = entry.elems;
    const ke = entry._orbitK;
    const o = ke * 8;
    const MtBody = els.eV[o + 3] + els.eV[o + 2] * (t - els.eT[ke]);
    let dph = (MtBody - entry._orbitMt) % TAU;   // 自上次网格重建起的相位推进
    if (dph < 0) dph += TAU;
    const N = colAttr.count, invN = 1 / N;
    const arr = colAttr.array;
    for (let i = 0; i < N; i++) {
      let age = dph / TAU + 0.5 - i * invN;
      age -= Math.floor(age);
      const f = age >= ORBIT_CUT ? 0 : Math.exp(-age / ORBIT_TAU_FRAC);
      const j = i * 3;
      arr[j] = f; arr[j + 1] = f; arr[j + 2] = f;
    }
    colAttr.needsUpdate = true;
  }

  /* —— 近距淡出 ——
   * 1) 航天器轨迹（Cassini/Huygens 各自独立触发）：模型屏占像素 1.5→6 px
   *    （亮点标记 → 模型交接区）smoothstep 淡出 —— 模型级特写时轨迹线穿过
   *    画面中心成为杂线，随模型出现而退场，拉远即恢复；
   * 2) 行星/卫星轨道线：该天体盘面屏占（直径/屏高）0.10→0.30 smoothstep
   *    淡出 —— 点击天体飞至 6R（盘面约 1/3 屏高）时恰好完全隐去，逐天体
   *    独立生效（贴近土星只隐土星轨道，卫星轨道不受影响）。 */
  const TRAIL_FADE_PX0 = 1.5, TRAIL_FADE_PX1 = 6.0;
  const ORBIT_FADE_F0 = 0.10, ORBIT_FADE_F1 = 0.30;
  let modelFade = 0;   // Cassini 模型级淡出因子（0=正常显示，1=完全隐藏），逐帧刷新
  function smooth01(x) {
    x = THREE.MathUtils.clamp(x, 0, 1);
    return x * x * (3 - 2 * x);
  }
  function modelFadeK(modelPx) {
    return smooth01((modelPx - TRAIL_FADE_PX0) / (TRAIL_FADE_PX1 - TRAIL_FADE_PX0));
  }

  function init(canvas, labelsContainer, onLabelClick) {
    labelsEl = labelsContainer;
    renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, logarithmicDepthBuffer: true,
    });
    // MSAA 抗锯齿：行星 limb / 环缘的 1px 轮廓锯齿在盘面暗带（环影、夜面）
    // 衬托下呈明显「拼接」感——开 MSAA 平滑几何边。像素比上限 2 不变，
    // 桌面级 GPU 填充率开销可接受
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.setSize(window.innerWidth, window.innerHeight);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1e-5, 1e13);
    scene.add(camera);

    // item 2：普通模式整体压暗——亮面 2.0→1.15（此前反照率×2 必然削顶过曝）、
    // 阴影环境光 0.8→0.10；亮面强度两种模式恒定（SUN_INTENSITY）
    sunLight = new THREE.PointLight(0xffffff, SUN_INTENSITY, 0, 0);
    scene.add(sunLight);
    ambient = new THREE.AmbientLight(0x28324a, 0.05);
    scene.add(ambient);
    registry.set('__sunLight', { light: sunLight, ambient });

    // —— 飞船自阴影（真实光照模式，item：实时遮挡关系）——
    // 太阳在飞船尺度（18 m）下即平行光：独立 DirectionalLight 承担飞船直射光，
    // 方向逐帧对准太阳，紧凑正交阴影相机（±14 m / 深度 2–8 cm）实时解算机体
    // 自遮挡（天线盘后、机身背阳面不反光）。行星侧材质注入「忽略平行光」补丁
    //（其平行光方向在行星处并不指向太阳）；普通模式 intensity=0 + 阴影贴图
    // 按需重绘 → 关闭真实光照零开销，模式切换仅改 uniform 不触发重编译。
    shipSunLight = new THREE.DirectionalLight(0xffffff, 0);
    shipSunLight.castShadow = true;
    shipSunLight.shadow.mapSize.set(1024, 1024);
    const scCam = shipSunLight.shadow.camera;
    scCam.near = 0.02; scCam.far = 0.08;           // 光源置于飞船向日侧 0.05 km 处
    scCam.left = -0.014; scCam.right = 0.014;      // ±14 m：覆盖 18 m 翼展 + 余量
    scCam.top = 0.014; scCam.bottom = -0.014;
    scCam.updateProjectionMatrix();
    shipSunLight.shadow.bias = -0.0002;
    shipSunLight.shadow.normalBias = 0.00006;      // ~2 texel（texel ≈ 2.7 cm）
    scene.add(shipSunLight);
    scene.add(shipSunLight.target);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;   // 手动节流：仅真实光照且模型可见时重绘

    buildSky();
    buildBodies(onLabelClick);
    buildCassini();
    buildTrail();
    buildSoi();

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      resizePost();
    });
  }

  /* realistic lighting mode (shadowed areas fully dark)
   * item 2：普通模式亮面 2.0→1.15（过曝修复）、阴影环境光 0.8→0.05。
   * item 3：环影/环的本影段不再需要按模式改 uniform——环影 shader 在
   * aomap_fragment 只移除直射光：普通模式剩环境光（与背阳面亮度天然一致）、
   * 真实光照模式环境光为 0（阴影全黑）。
   * 亮面两种模式恒定：直射光取原真实 3.0 / 普通 1.15 的平均 2.075，开关只
   * 改变暗面。真实模式额外熄灭飞船模型级补光（HemisphereLight 全局生效，
   * 泄漏到行星暗面）→ 暗面亮度严格为 0；普通模式暗面留环境光 + 补光。
   * 飞船直射光切换：普通模式由太阳点光承担（平行光 intensity=0 不参与），
   * 真实模式改由带自阴影的飞船平行光承担（船体材质点光贡献经 uPointOff
   * 归零）——强度与点光等值同向，外观无缝衔接，仅 uniform 切换无重编译。 */
  function setRealisticLighting(on) {
    if (!ambient) return;
    realisticOn = on;
    sunLight.intensity = SUN_INTENSITY;
    if (on) {
      ambient.intensity = 0.0;
      ambient.color.setHex(0x000000);
    } else {
      ambient.intensity = 0.05;
      ambient.color.setHex(0x28324a);
      if (window.CassiniModel) window.CassiniModel.setEclipse(1, 1);
    }
    if (window.CassiniModel) window.CassiniModel.setFillLight(!on);
    if (shipSunLight) {
      shipSunLight.intensity = on ? SUN_INTENSITY : 0;
      forceShadowRefresh = true;
    }
    // 行星反照光仅真实模式逐帧解算（材质注入项，关闭即置零，探测器套同归零）
    if (!on && window.CassiniModel) {
      window.CassiniModel.setShine(null, null, 0);
      window.CassiniModel.setProbeShine(null, null, 0);
    }
    if (window.CassiniModel) window.CassiniModel.setSunMode(on);
  }

  // ---------- sky sphere（低亮度真实天空球 + 恒星点云） ----------
  // 背景球只烘银河带微光；恒星改为真实三维点云（圆滑软点），避免烘焙纹理
  // 放大后的方块感与 equirect 极区挤压，任意视场下都是清晰的圆点。
  function bvToColor(bv) {
    if (bv < -0.1) return [0.72, 0.80, 1.00];
    if (bv < 0.25) return [0.90, 0.93, 1.00];
    if (bv < 0.55) return [1.00, 0.97, 0.90];
    if (bv < 0.95) return [1.00, 0.87, 0.72];
    if (bv < 1.45) return [1.00, 0.78, 0.58];
    return [1.00, 0.70, 0.52];
  }
  const SKY_R = 4e8;
  function buildSky() {
    const cat = window.STAR_CATALOG;
    const W = 3072, H = 1536;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#010208';
    ctx.fillRect(0, 0, W, H);
    // equirect 投影：three 球面 uv → (u = atan2(z,-x)/2π, v = acos(y)/π)
    const project = (x, y, z) => {
      const theta = Math.acos(Math.max(-1, Math.min(1, y)));
      let u = Math.atan2(z, -x) / TAU; if (u < 0) u += 1;
      return [u * W, (theta / Math.PI) * H];
    };
    // 银河带弥散微光（真实银道几何，低亮度软斑——仅极淡痕迹，不凸显银河）
    if (cat && cat.bandN) {
      const bxyz = b64ToFloat32(cat.bandXyz);
      const bb = b64ToFloat32(cat.bandB);
      const sp = glowSpriteRGB(157, 180, 216);
      const S = 30;
      for (let i = 0; i < cat.bandN; i++) {
        const [px, py] = project(bxyz[i * 3], bxyz[i * 3 + 1], bxyz[i * 3 + 2]);
        const a = bb[i] * 0.012;
        if (a < 0.001) continue;
        ctx.globalAlpha = a;
        ctx.drawImage(sp, px - S / 2, py - S / 2, S, S);
        if (px < S) ctx.drawImage(sp, px + W - S / 2, py - S / 2, S, S);
        if (px > W - S) ctx.drawImage(sp, px - W - S / 2, py - S / 2, S, S);
      }
      ctx.globalAlpha = 1;
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    // 真实星空烘焙 → 飞船材质环境反射（cassini_model.js 贴图还原：金箔/铝件
    // 反射真实银河带，替代程序化假星空；envMap 在材质增强时经 PMREM 过滤）
    if (window.CassiniModel && window.CassiniModel.setEnvironment) {
      window.CassiniModel.setEnvironment(cv);
    }
    const mat = new THREE.MeshBasicMaterial({
      map: tex, side: THREE.BackSide, depthWrite: false, fog: false,
    });
    mat.toneMapped = false;
    skyMesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_R, 64, 32), mat);
    skyMesh.renderOrder = -10;
    skyMesh.frustumCulled = false;
    scene.add(skyMesh);
    buildSkyStars(cat);
  }
  /* 恒星点云：真实星表逐星一点（点大小/亮度随真实星等，色温随 B-V）。
   * 亮度映射参考 NASA/planetarium 惯例：流量比 F=10^(-0.4·mag)（Vega 归一，
   * 含负星等——天狼星等最亮星显著更亮），感知压缩后适配屏幕动态范围。 */
  function buildSkyStars(cat) {
    if (!cat || !cat.n) return;
    const n = cat.n;
    const xyz = b64ToFloat32(cat.xyz);
    const mags = b64ToFloat32(cat.mag);
    const bvs = b64ToFloat32(cat.bv);
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    let w = 0;
    const put = (x, y, z, r, g, b, s) => {
      pos[w * 3] = x * SKY_R; pos[w * 3 + 1] = y * SKY_R; pos[w * 3 + 2] = z * SKY_R;
      col[w * 3] = r; col[w * 3 + 1] = g; col[w * 3 + 2] = b;
      size[w] = s; w++;
    };
    for (let i = 0; i < cat.n; i++) {
      const mag = mags[i];
      const flux = Math.pow(10, -0.4 * mag);              // 真实流量比（Vega 归一）
      let I = 0.12 + 0.95 * Math.pow(flux, 0.34);         // 感知压缩：mag≈6.5 隐约可辨，亮星显著
      if (I > 1.55) I = 1.55;
      const s = Math.min(5.5, 1.7 + Math.pow(flux, 0.30) * 1.8);
      const c = bvToColor(bvs[i]);
      put(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2], c[0] * I, c[1] * I, c[2] * I, s);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uPixelRatio: { value: renderer.getPixelRatio() } },
      vertexShader: `
        attribute vec3 aColor;
        attribute float aSize;
        uniform float uPixelRatio;
        varying vec3 vColor;
        void main() {
          vColor = aColor;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uPixelRatio;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          vec2 pc = gl_PointCoord - 0.5;
          float d2 = dot(pc, pc) * 4.0;    // 0 圆心 → 1 圆缘
          if (d2 > 1.0) discard;
          // 实心圆核（小尺寸点仍清晰可见）+ 高斯软晕，边缘精确归零
          float disc = 1.0 - smoothstep(0.30, 0.95, d2);
          float halo = exp(-d2 * 5.5) - exp(-5.5);
          float fall = 0.75 * disc + 0.45 * halo;
          gl_FragColor = vec4(max(vColor, 0.0) * max(fall, 0.0), 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      // transparent:false 使其归入不透明队列按 renderOrder 先于行星绘制，
      // 行星随后覆盖星点（星不会被画到行星上方）；深度读写均关闭避免干扰对数深度。
      transparent: false,
      depthWrite: false,
      depthTest: false,
    });
    const points = new THREE.Points(geo, mat);
    points.renderOrder = -9;   // 背景球(-10)之后、行星(0)之前
    points.frustumCulled = false;
    scene.add(points);
  }
  function rgbCss(c) {
    return 'rgb(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ')';
  }
  /* 高斯软斑 sprite（天空球烘焙用，rgba 渐变避免硬边方块） */
  function glowSpriteRGB(r, g, b) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g1 = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g1.addColorStop(0, `rgba(${r},${g},${b},1)`);
    g1.addColorStop(0.25, `rgba(${r},${g},${b},0.42)`);
    g1.addColorStop(0.6, `rgba(${r},${g},${b},0.10)`);
    g1.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, 64, 64);
    return c;
  }

  /* 太阳光晕壳层：按“视线到日心的瞄准距离 b”（日面半径归一）计算径向衰减。
   * 球面几何在任意视距下稳定（无广告牌近裁剪切边），日面圆盘自然遮挡中心亮核。
   *
   * 剖面为严格各向同性——只随 b 变化，与方位角/世界坐标无关，因此各视距下
   * 都是一圈均匀晕环，不存在旧版角向冕流造成的明暗扇区。
   *
   * 剖面为「日缘锚定的指数和」（s = b−1，日缘外距离），衰减全程指数：
   *   inner（2.6R 壳）——色球亮环 1.15·exp(−9s) + 内冕 0.55·exp(−2.6s)：
   *     白核（叠加值 >1 的饱和区）在 s≈0.13R 内就降到 1 以下 → 亮球与光球层
   *     基本同大，不出现旧版白核外扩到 2.1R 的「内部亮球」；
   *   outer（9R 壳）——外冕 0.30·exp(−s·0.38)：单一长指数，柔和弥散到 ~8R。
   *
   * 幅度标定在**原始帧缓冲空间**：ShaderMaterial 无 encodings_fragment（输出
   * 不做线性→sRGB 换算），叠加结果即屏幕值，饱和阈值为 1.0。日缘总量
   * 1.70+0.30=2.00 → 贴缘一圈明显的白环；s≈0.13 处已 <1 → 白核≈日面。
   * 指数在两壳壳缘处已衰减到 ~1e-2 以下，win 窗口（1−x⁶）只负责最后归零，
   * 无同心接缝；旧版幂律 x^-1.5 在 7R 壳内衰减慢、观感近似线性渐变，已弃用。
   * 含 logdepthbuf chunk：与对数深度缓冲的圆盘/行星正确做深度判定。 */
  function sunGlowShellMaterial(opt) {
    const profile = opt.mode === 'outer'
      ? `float x = clamp(b / uEdge, 0.0, 1.0);
         float s = max(b - 1.0, 0.0);
         // 外冕：单一长指数（τ≈2.6R），柔和弥散
         float g = 0.30 * exp(-s * 0.38);`
      : `float x = clamp(b / uEdge, 0.0, 1.0);
         float s = max(b - 1.0, 0.0);
         // 色球亮环（τ≈0.11R，白核止于日缘附近）+ 内冕（τ≈0.38R）
         float g = 1.15 * exp(-s * 9.0) + 0.55 * exp(-s * 2.6);`;
    return new THREE.ShaderMaterial({
      uniforms: {
        uR: { value: opt.rSun },
        uI: { value: opt.intensity },
        uColor: { value: new THREE.Color(opt.color) },
        uFade: { value: 1.0 },
        uEdge: { value: opt.shell },
      },
      vertexShader: `
        varying vec3 vW; varying vec3 vSunC;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main() {
          vW = (modelMatrix * vec4(position, 1.0)).xyz;
          vSunC = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `
        uniform float uR; uniform float uI; uniform vec3 uColor; uniform float uFade;
        uniform float uEdge;
        varying vec3 vW; varying vec3 vSunC;
        #include <common>
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          vec3 D = normalize(vW - cameraPosition);
          vec3 oc = vSunC - cameraPosition;
          float tP = dot(oc, D);
          float b = length(oc - D * tP) / uR;   // 瞄准距离（日面半径归一）
          ${profile}
          // 壳缘窗口：只做最后归零，高次幂在 x<0.9 处几乎不改变指数剖面
          float win = 1.0 - pow(x, 6.0);
          gl_FragColor = vec4(uColor * max(g * win * uFade, 0.0), 1.0);
        }`,
      side: opt.side,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
  }

  /* 行星大气辉光壳（NASA Eyes 同款盘外光晕 + 大气内视地平雾带）：加色壳层。
   * 外视（相机远于大气）：光强按「瞄准距离 b」（视线到星心最近距 / 该方向
   * 星体椭球半径）剖面化——盘缘 b=1 最亮、向外指数衰减，壳缘窗口归零无硬边。
   * 内视（Grand Finale 坠入段，相机贴近/进入大气）：指数剖面会退化成满天天纱，
   * 改按「视线穿过大气层（星表→壳顶）的前向弦长」发光——地平线方向弦长最长
   * 成亮带、天顶方向趋于零星空通透，即真实大气散射观感；星表以下（坠入段
   * 末端）俯视仍是深厚雾霾、仰视留出天空，两种剖面按相机高度平滑交接。
   * 扁椭球（土星 f=0.098 等）：b/弦长按视线方向椭球半径归一（r(nrm) =
   * a / √(nh² + nv²/(1−f)²)，nv = nrm·极轴），壳网格同扁率压 Y——光晕与星表
   * 间距全向恒定，极区不悬浮。昼侧亮、夜侧暗（太阳在世界原点，无需逐帧
   * uniform）。含 logdepthbuf chunk：对数深度缓冲下与行星盘面正确做深度判定。 */
  function atmoHaloShellMaterial(opt) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uR: { value: opt.rBody },
        uI: { value: opt.intensity },
        uColor: { value: Array.isArray(opt.color)
          ? new THREE.Color(opt.color[0], opt.color[1], opt.color[2])
          : new THREE.Color(opt.color) },
        uEdge: { value: opt.shell },
        uFlat: { value: opt.flat || 0 },
        uPolar: { value: opt.polar || new THREE.Vector3(0, 1, 0) },
        uSunPos: { value: new THREE.Vector3() },
        // 外视 limb 霾的双指数衰减尺度（1/R）：spread > 1 放慢衰减——浓霾
        // 天体（泰坦）光晕更厚更饱和，壳缘窗口仍归零
        uK1: { value: 200.0 / (opt.spread || 1) },
        uK2: { value: 70.0 / (opt.spread || 1) },
        // 近侧环遮挡衰减（有环行星接线，见 buildBodies；无环 uRingOut=-1 恒不命中）
        uRingMap: { value: BLACK_TEX },
        uRingIn: { value: 1.0 },
        uRingOut: { value: -1.0 },
      },
      vertexShader: `
        varying vec3 vW; varying vec3 vBodyC;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main() {
          vW = (modelMatrix * vec4(position, 1.0)).xyz;
          vBodyC = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `
        uniform float uR; uniform float uI; uniform vec3 uColor;
        uniform float uEdge; uniform float uFlat; uniform vec3 uPolar;
        uniform vec3 uSunPos; uniform float uK1; uniform float uK2;
        uniform sampler2D uRingMap; uniform float uRingIn; uniform float uRingOut;
        varying vec3 vW; varying vec3 vBodyC;
        #include <common>
        #include <logdepthbuf_pars_fragment>
        float sphR(vec3 n, float ic) {          // 椭球沿方向 n 的半径
          float nv = clamp(dot(n, uPolar), -1.0, 1.0);
          return uR / sqrt((1.0 - nv * nv) + nv * nv * ic * ic);
        }
        void main() {
          #include <logdepthbuf_fragment>
          vec3 D = normalize(vW - cameraPosition);
          vec3 oc = vBodyC - cameraPosition;
          float dCam = max(length(oc), 1e-8);
          float tP = dot(oc, D);
          vec3 Pv = oc - D * tP;                       // 最近点向量
          float rc = max(length(Pv), 1e-8);
          vec3 nrm = Pv / rc;                           // 最近点方向
          float ic = 1.0 / (1.0 - uFlat);
          float rDir = sphR(nrm, ic);
          float dN = dCam / sphR(oc / dCam, ic);        // 相机高度（星表=1）
          float b = rc / rDir;                          // 瞄准距离（星表=1）
          float s = max(b - 1.0, 0.0);
          // 外视剖面：真实 limb 霾是薄层（可见厚度 ~1–2% 行星半径），取 0.5% /
          // 1.4%R 两个指数衰减尺度（uK1/uK2，浓霾天体经 spread 放慢）；旧
          // 8.0/2.0 的尺度在 4.5% 壳内几乎不衰减，整段被 win 窗口硬切，观感
          // 过厚过亮。窗口起点必须是 1.0——取 uEdge*0.55 会在峰值处先行衰减 40 倍
          float outG = smoothstep(1.03, 1.20, dN);
          float gOut = (0.85 * exp(-s * uK1) + 0.30 * exp(-s * uK2)) * outG;
          float win = 1.0 - smoothstep(1.0, uEdge, b);
          // 内视地平雾带：视线前方穿过大气层（星表→壳顶）的前向弦长 × 指数密度
          // （标高 uH≈0.012R）——地平线切向弦长最长且贴近星表（亮带），视线
          // 抬高后弦段中点高度上升、密度骤降，天空快速转黑，贴近真实观感
          float rEdge = uEdge * rDir;
          float xOut = sqrt(max(rEdge * rEdge - rc * rc, 0.0));
          float xIn  = sqrt(max(rDir  * rDir  - rc * rc, 0.0));
          float sCam = sqrt(max(dCam * dCam - rc * rc, 0.0));
          float tCam = dot(D, normalize(oc)) > 0.0 ? sCam : -sCam; // 最近点在前为正
          // 前向弦段 = 视线与大气环带 [rDir, rEdge] 交集且 t ≥ 0：
          //   星表外（含大气内）：[max(tCam − xIn, 0), tCam + xOut]；
          //   星表内（坠入穿模）：[tCam + xIn, tCam + xOut]——视线先穿出星表
          //   才进入大气。旧式对星表内相机仍取 tCam − xIn（负值 → 段起点 0），
          //   整条穿行星路径被计入弦长且弦段中点 rMid 深入星体 → 密度项
          //   exp(+80) 量级爆炸 → 加色壳失去盘面遮挡后整屏泛白
          float tA = dCam < rDir ? tCam + xIn : max(tCam - xIn, 0.0);
          float tB = tCam + xOut;
          float chordSeg = max(tB - tA, 0.0);
          float rMid = sqrt(rc * rc + (tCam - 0.5 * (tA + tB)) * (tCam - 0.5 * (tA + tB)));
          // 密度项钳底于星表密度：rMid 落入星体内部时（理论上该方向已被不透明
          // 盘面遮挡）不再指数放大，任何深度/剔除竞态下都不会爆白
          float chord = chordSeg / rEdge * exp(-(max(rMid / rDir, 1.0) - 1.0) / 0.006);
          // 星表以下（坠入穿模）内视剖面整体淡出：地表之下没有天空，不应残留
          // 大气雾带
          float inG = (1.0 - smoothstep(1.06, 1.26, dN)) * smoothstep(0.995, 1.0, dN);
          // 内视增益（8）配标高 0.006R（~350 km，介于真实 ~80 km 与观感之间）：
          // 贴轮廓掠射线的 rMid 贴近星表、密度项≈1，弦长 0.3R——增益过大时
          // 整条地平带饱和成白墙；标高减半把亮带收紧到轮廓附近，天空只剩
          // 「稍微染色」（ShaderMaterial 无 encodings_fragment，输出为原始线性值）
          float g = uI * (gOut * win + inG * 8.0 * chord);
          // 昼夜调制：片段在屏面上相对盘心的方向 = -nrm（nrm 指向中心，即从
          // 盘缘指向盘心）——昼侧亮弧必须落在太阳一侧。场景为相机相对系，
          // 太阳位姿逐帧注入；散射有 wrap（夜侧留 0.42 底），避免晨昏断崖
          float day = clamp(-dot(nrm, normalize(uSunPos - vBodyC)) * 1.1 + 0.42, 0.0, 1.0);
          // 近侧环按真实 alpha 衰减辉光：环物质（内缘 ≥1.11R）恒在壳（1.045R）
          // 之外，逐视线顺序必为【近侧环 → 大气弦 → 远侧环】——环平面穿越点
          // 参数 tR 落在壳远壁 tX 之前即近侧环，采样环径向 alpha 乘 (1−α)；
          // 远侧环不衰减（亮弧本就霾罩其上）。环平面法线复用 uPolar（行星
          // 赤道面法线，与环面同）。旧的「环写深度 + 壳按深度剔除」机制下
          // 深度是二值的——透明环片段（卡西尼缝、木星环稀疏尘埃）也会把亮弧
          // 整段剔黑，故改为解析衰减：α=0 无影响、半透明按比例透光
          float ringTrans = 1.0;
          float denomR = dot(D, uPolar);
          if (abs(denomR) > 1e-6) {
            float tR = dot(vBodyC - cameraPosition, uPolar) / denomR;
            vec3 occ = cameraPosition - vBodyC;
            float bD = dot(occ, D);
            float shellR = uR * uEdge;
            float disc = bD * bD - (dot(occ, occ) - shellR * shellR);
            // 壳远壁（取 +sqrt：内视坠入时近壁在身后，穿越点仍正确遮挡）
            float tX = disc > 0.0 ? -bD + sqrt(disc) : -1.0;
            if (tR > 0.0 && tR < tX) {
              float rr = length(cameraPosition + D * tR - vBodyC);
              if (rr > uRingIn && rr < uRingOut) {
                float uu = (rr - uRingIn) / (uRingOut - uRingIn);
                ringTrans = 1.0 - texture2D(uRingMap, vec2(uu, 0.5)).a;
              }
            }
          }
          gl_FragColor = vec4(uColor * max(g * day, 0.0) * ringTrans, 1.0);
        }`,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
  }

  /* 标记纹理用 16px 小图：几像素的 sprite 采样稀疏，64px 大图的白色亮核
   * 会被完全跳过（峰值只有 ~0.93），小图才能让最小档位的标记保持全亮核心。 */
  function markerTexture() {
    const N = 16;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N * 0.47);
    g.addColorStop(0, 'rgba(255,225,160,1)');
    g.addColorStop(0.25, 'rgba(255,211,127,0.9)');
    g.addColorStop(0.5, 'rgba(255,211,127,0.25)');
    g.addColorStop(1, 'rgba(255,211,127,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(N / 2, N / 2, N * 0.47, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(N / 2, N / 2, N * 0.09, 0, Math.PI * 2); ctx.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;      // 禁用 mipmap，避免亮核被 mip 平均压暗
    tex.generateMipmaps = false;
    return tex;
  }

  /* 紧凑亮点纹理：实心亮核 + 窄光晕（远距标记：Cassini / Sun，弱发光小亮点） */
  function dotTexture() {
    const N = 16;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N * 0.47);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,240,200,1)');
    g.addColorStop(0.42, 'rgba(255,214,130,0.5)');
    g.addColorStop(1, 'rgba(255,214,130,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(N / 2, N / 2, N * 0.47, 0, Math.PI * 2); ctx.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;      // 同上：小 sprite 保持亮核清晰
    tex.generateMipmaps = false;
    return tex;
  }

  function loadTex(name, aniso) {
    const url = TEXDATA[name];
    if (!url) return null;
    // 加载页进度（js/loader.js）：纹理解码细条按张计程
    if (window.CassiniLoader) window.CassiniLoader.texStart(name);
    const tex = texLoader().load(url, () => {
      if (window.CassiniLoader) window.CassiniLoader.texDone(name);
    });
    tex.encoding = THREE.sRGBEncoding;
    if (aniso) tex.anisotropy = aniso;
    return tex;
  }

  /* 大气边缘光（item 5）：菲涅尔边缘光直接注入行星表面材质。
   * 不再使用独立外壳网格——旧外壳是独立 ShaderMaterial 且未含 logdepthbuf
   * chunk，在 logarithmicDepthBuffer 下深度判定与行星表面不一致，会在圆面上
   * 错误叠加出硬边大气罩；并入表面后与表面光照同一管线，昼夜相位天然一致。
   * 可选扩展（NASA Eyes 同款显示效果，参数取自其 app.js AtmosphereComponent）：
   *   sunset { color, intensity } — 晨昏线日落色（地球 (1,.5,0)×1.2）
   *   night  { tex, intensity }   — 夜面城市灯光贴图，按太阳高度角淡入 */
  const BLACK_TEX = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  BLACK_TEX.needsUpdate = true;

  /* _ringShadowF 契约：本函数在 fragment 全局域声明（默认 1.0），土星环影
   * 注入（buildBodies 内，链式于本函数之后）在其 aomap 块中按环 alpha 改写，
   * 供下方 dithering 加色同步遮暗——环影挡住的是整根大气柱，雾带（rim/wash）
   * 在光照管线之后加色，不受 reflectedLight 乘法影响，须显式乘环影因子。
   * 无环影天体（地球/金星/火星/土卫六）恒为 1.0，行为不变。 */
  function applyAtmoRim(mat, def) {
    const col = (c) => Array.isArray(c) ? new THREE.Color(c[0], c[1], c[2]) : new THREE.Color(c);
    mat.userData.atmoU = {
      uAtmoColor: { value: col(def.color) },
      uAtmoIntensity: { value: def.intensity },
      uAtmoPower: { value: def.power },
      uSunDirView: { value: new THREE.Vector3(0, 0, 1) },
      uNightMap: { value: def.night ? loadTex(def.night.tex) : BLACK_TEX },
      uNightIntensity: { value: def.night ? def.night.intensity : 0 },
      uSunsetColor: { value: col(def.sunset ? def.sunset.color : 0) },
      uSunsetIntensity: { value: def.sunset ? def.sunset.intensity : 0 },
      uAtmoWash: { value: def.wash || 0 },
    };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, mat.userData.atmoU);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>',
          '#include <common>\nvarying vec3 vAtmoN;\nvarying vec3 vAtmoV;')
        .replace('#include <begin_vertex>', `
          #include <begin_vertex>
          vAtmoN = normalize(normalMatrix * normal);
          vec4 atmoMv = modelViewMatrix * vec4(position, 1.0);
          vAtmoV = normalize(-atmoMv.xyz);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>',
          '#include <common>\nfloat _ringShadowF = 1.0;\nvarying vec3 vAtmoN;\nvarying vec3 vAtmoV;\nuniform vec3 uAtmoColor;\nuniform vec3 uSunDirView;\nuniform float uAtmoIntensity;\nuniform float uAtmoPower;\nuniform float uAtmoWash;\nuniform sampler2D uNightMap;\nuniform float uNightIntensity;\nuniform vec3 uSunsetColor;\nuniform float uSunsetIntensity;')
        .replace('#include <dithering_fragment>', `
          #include <dithering_fragment>
          {
            vec3 N = normalize(vAtmoN), V = normalize(vAtmoV);
            vec3 S = normalize(uSunDirView);
            float nds = dot(N, S);
            float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), uAtmoPower);
            float day = clamp(nds * 1.4 + 0.25, 0.0, 1.0);
            // 夜面城市灯光：越过晨昏线（法线背向太阳）淡入
            float nightF = 1.0 - smoothstep(-0.14, 0.06, nds);
            gl_FragColor.rgb += texture2D(uNightMap, vUv).rgb * (uNightIntensity * nightF);
            // 边缘光昼侧着大气色，晨昏线附近混入日落色
            float sunset = uSunsetIntensity * pow(clamp(1.0 - abs(nds), 0.0, 1.0), 3.5);
            vec3 atmo = mix(uAtmoColor, uSunsetColor, clamp(sunset, 0.0, 1.0));
            // wash：昼面常数薄雾——把整盘往大气色抬（淡蓝观感）；rim 只够到盘缘
            // 环影暗带上的雾柱同被环遮挡：加色须乘 _ringShadowF（见函数头契约）
            gl_FragColor.rgb += atmo * ((rim * uAtmoIntensity + uAtmoWash) * day) * _ringShadowF;
          }`);
    };
    mat.customProgramCacheKey = () => 'atmo-rim';
  }

  /* 行星侧材质「忽略平行光」：飞船自阴影的平行光只应作用于飞船本体——
   * 该光方向按飞船-太阳连线设定，在行星处并不指向太阳，须在行星/云层/环
   * 材质内将平行光直射贡献归零（点光不受影响）。注意 onBeforeCompile 拿到
   * 的是未展开 #include 的原始模板——光循环体在 lights_fragment_begin
   * chunk 内部，直接替换 light-info 语句是静默 no-op；故加载期从
   * ShaderChunk 取 chunk 全文注入归零语句，编译时整体替换 include 指令
   * （lib vendored r147，锚点串唯一）。普通模式平行光 intensity=0 双保险。
   * tag 用于区分补丁链变体（onBeforeCompile 闭包的 toString 无法区分捕获
   * 的 prev，缺失会导致 program 缓存错配）。 */
  const LF_BEGIN_NODIR = (() => {
    const chunk = THREE.ShaderChunk.lights_fragment_begin;
    const out = chunk.replace(
      'getDirectionalLightInfo( directionalLight, geometry, directLight );',
      'getDirectionalLightInfo( directionalLight, geometry, directLight );\n\t\t\tdirectLight.color = vec3( 0.0 );');
    if (out === chunk) console.warn('excludeDirLight: lights_fragment_begin 锚点未命中');
    return out;
  })();

  function excludeDirLight(mat, tag) {
    const prevCompile = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, r) => {
      if (prevCompile) prevCompile(shader, r);
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_begin>', LF_BEGIN_NODIR);
    };
    const prevKey = mat.customProgramCacheKey;
    mat.customProgramCacheKey = () =>
      (prevKey ? prevKey.call(mat) : '') + '+nodir' + (tag || '');
  }

  /* 高光软肩（item 1「Tone mapping」的定向实现）：行星表面/云层/环的直射亮面
   * 在 SUN_INTENSITY=2.075 下 HDR 到 ~1.45–1.9，8-bit 输出硬削顶成白板
   * （实测 WebKit：木星向阳面 11–16% 像素 min(rgb)≥250、土星亮区 43–58% 压平
   * 在 240–252；bloom 开/关逐位一致，与 bloom 无关——`tools/debug_overexp.js`）。
   * 在 sRGB 编码之后（显示空间）注入高光软肩：膝点 0.78 以上指数压缩、渐近
   * 1.0——削顶区恢复层次、亮面从「炽白」回落到「明亮」；暗部/中间调（显示值
   * ≤0.78）逐位不变。**两模式全局生效**（2026-10-05 用户确认：普通模式同样
   * 过曝，「保持和打开真实光照时一样」——削顶是数据丢失，归 bug 修复类，不随
   * 模式门控）。注入点选 dithering_fragment 锚点：
   * 对带大气 rim 的材质，prev 已消费该锚点但其模板内仍含 include 指令，replace
   * 仍命中且位于 rim 块之前——rim 的加色不参与压肩（大气辉光本属加色语义）。
   * tag 防 program 缓存错配（同 excludeDirLight 契约）。 */
  const shoulderMats = [];
  const SHOULDER_GLSL = `
          {
            float _m = max(gl_FragColor.r, max(gl_FragColor.g, gl_FragColor.b));
            if (uShoulder > 0.5 && _m > 0.78) {
              float _f = 0.78 + 0.22 * (1.0 - exp(-(_m - 0.78) / 0.22));
              gl_FragColor.rgb *= _f / _m;
            }
          }`;
  function applySoftShoulder(mat, tag) {
    if (!mat.userData.shoulderU) mat.userData.shoulderU = { value: 1 };
    shoulderMats.push(mat.userData.shoulderU);
    const prevCompile = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, r) => {
      if (prevCompile) prevCompile(shader, r);
      shader.uniforms.uShoulder = mat.userData.shoulderU;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uShoulder;')
        .replace('#include <dithering_fragment>', SHOULDER_GLSL + '\n#include <dithering_fragment>');
    };
    const prevKey = mat.customProgramCacheKey;
    mat.customProgramCacheKey = () =>
      (prevKey ? prevKey.call(mat) : '') + '+shoulder' + (tag || '');
  }

  /* —— 晨昏线半影（item 6，仅真实光照）——
   * 物理图像：行星表面照度 = cos(入射角) × 日面可见比例。有限日面（角半径
   * θs，行星处 ~1e-3 rad）只让明暗界线在 |dotNL| ≲ θs 内再模糊一点，而
   * Lambert 余弦坡本身横跨 90° 入射弧——dotNL 0→0.35 的暗尾（感知上的暮色
   * 漫泛区）才是「晨昏线发糊」的主因。本项给太阳点光直射乘日面可见因子
   * P = smoothstep(-uPenW, uPenW, dotNL)：dotNL > uPenW 区域逐位不变，
   * < -uPenW 严格归零，中间暗尾平滑截断 → 明暗界线贴紧几何晨昏线。
   * uPenW 取 0.35（实测标定，见 .workbuddy/tools/probe_terminator.js）：
   * 物理 θs（行星处 7e-4 ~ 4.7e-3 rad）远小于 8-bit 可辨阈——按真值实现带宽
   * < 0.1 px，A/B 截图逐位零差（且亚像素硬边反而引发着色闪烁，MSAA 只平滑
   * 几何边、不平滑着色渐变）；0.35 时暮色带（dotNL 0.05~0.35）压深 10~16%、
   * 亮缘（>0.5）逐位不变，晨昏线明暗界线明显贴紧几何晨昏线。风格化宽度，
   * 近似真实影像中「暗部 S 曲线 + 地表散射吃掉暮色」的观感；不做逐日距
   * 解算（各行星 θs 全部远低于下限）。
   * 门禁：效果类 → uPenOn 仅真实光照置 1/0（updateRender 逐帧刷新，
   * uSatShade 同款；uPenOn=0 时 mix 回 1.0，off 路径逐位回退）。
   * 注入：链在 excludeDirLight 之后（行星直射只剩太阳点光），此时 fragment
   * 内 '#include <lights_fragment_begin>' 已被 prev 展开为 LF_BEGIN_NODIR
   * 全文——直接以该文本串为锚替换为附加半影行的 LF_BEGIN_PEN；仅点光块
   * 乘因子（平行光块在行星材质内已归零）。tag 同 excludeDirLight 契约
   * （program 缓存防错配）。作用对象 = 全部非 emissive 天体（行星+卫星）
   * 表面与云层；环材质着色含自身晨昏语义、大气 rim/wash 自带 smoothstep
   * 昼夜权重，均不参与。 */
  const PEN_W = 0.35;
  const LF_BEGIN_PEN = (() => {
    const out = LF_BEGIN_NODIR.replace(
      'getPointLightInfo( pointLight, geometry, directLight );',
      'getPointLightInfo( pointLight, geometry, directLight );\n\t\t\tdirectLight.color *= mix( 1.0, smoothstep( - uPenW, uPenW, dot( geometry.normal, directLight.direction ) ), uPenOn );');
    if (out === LF_BEGIN_NODIR) console.warn('applyPenumbra: point light 锚点未命中');
    return out;
  })();
  function applyPenumbra(mat, tag, penU) {
    if (!penU) penU = {
      uPenOn: { value: realisticOn ? 1 : 0 },
      uPenW: { value: PEN_W },
    };
    mat.userData.penU = penU;
    const prevCompile = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, r) => {
      if (prevCompile) prevCompile(shader, r);
      const fs = shader.fragmentShader.replace(LF_BEGIN_NODIR, LF_BEGIN_PEN);
      if (fs === shader.fragmentShader) console.warn('applyPenumbra: LF_BEGIN_NODIR 锚点未命中', tag);
      shader.uniforms.uPenOn = penU.uPenOn;
      shader.uniforms.uPenW = penU.uPenW;
      shader.fragmentShader = 'uniform float uPenOn;\nuniform float uPenW;\n' + fs;
    };
    const prevKey = mat.customProgramCacheKey;
    mat.customProgramCacheKey = () =>
      (prevKey ? prevKey.call(mat) : '') + '+pen' + (tag || '');
  }

  /* —— 卫星凌日投影（item 3）——
   * 卫星经过太阳与行星之间时，在母行星表面/云层投下影斑：逐片元对「片元→太阳」
   * 射线做与每颗卫星（正球近似，半径 = 赤道半径）的最近距判定，命中则本影遮挡
   * 直射光。球-球解析：toS = satPos − vWPos，t = dot(toS, ld)（须 0 < t < distS，
   * 卫星位于片元与太阳之间），最近距 d = |toS − ld·t|。本影/半影半径逐帧按物理
   * 几何计算（updateRender 填 uSatUm/uSatPm）：太阳角半径 θs = R☉/日卫距，影平面
   * 距卫星 L（卫星→行星心沿影轴投影）→ 本影 r_u = R_m − L·θs、半影外缘
   * r_p = R_m + L·θs。titan 凌日土星实测几何：r_u ≈ 1980 km ≈ 0.77R_m（比卫星
   * 本体小）、半影环宽 2Lθs ≈ 1190 km——旧版固定 0.96–1.06R 既高估本影又把半影
   * 压窄 ~5 倍（旧注释把带宽错推成 ∝R_m，实际 ∝L）。本影不乘零：uShFloor =
   * SAT_SH_FLOOR 残余直射，近似真实「环反照光 + 大气侧向散射」底亮（Cassini 影像
   * 影斑中心约为周围云顶的 10–25%，云纹可辨）。r_u ≤ 0 为伪本影（环食，中心
   * 实际仍亮），钳 0.12R 保底——环食亮度偏暗，已知近似。作用对象 =
   * reflectedLight.directDiffuse：
   * excludeDirLight 后行星直射只剩太阳点光（ambient 走 indirectDiffuse 不受影响；
   * 注入点 aomap_fragment 之后，与土星环影补丁串联时两者均为 directDiffuse 乘法，
   * 交换律下顺序无关）。坐标系：全场景浮动原点——vWPos（modelMatrix 变换）与
   * 卫星 group.position 同为场景系，太阳 = −camWorld，相对量一致（updateRender
   * 「卫星凌日投影 uniform」段逐帧更新）。门禁：属「效果」，uSatShade 仅真实光照
   * 置 1/0（uForwS 同款，realisticOn 初始化兜底）。已知近似：dithering 阶的大气
   * rim/wash 加色不乘影因子（环影的 _ringShadowF 契约未扩展）——影斑位于盘面
   * 内部、rim 趋零，wash 为均匀薄雾，误差远低于感知阈。varying vWPos：土星环影
   * 补丁已注入同名 varying（同款 modelMatrix·position 赋值）时直接复用，防重复
   * 声明编译错误。tag 同 excludeDirLight 契约（program 缓存防错配）。 */
  const SAT_MAX = 8;
  // 本影残余亮度（真实光照下）：环反照光 + 大气侧向散射的底亮近似，Cassini
  // 影像实测影斑中心 ≈ 周围云顶的 10–25%
  const SAT_SH_FLOOR = 0.15;
  const _satAx = new THREE.Vector3();
  const _satRel = new THREE.Vector3();
  function applySatTransit(mat, tag) {
    const satU = {
      uSunPos: { value: new THREE.Vector3() },
      uSatPos: { value: Array.from({ length: SAT_MAX }, () => new THREE.Vector3()) },
      uSatR: { value: new Float32Array(SAT_MAX) },
      uSatUm: { value: new Float32Array(SAT_MAX) },
      uSatPm: { value: new Float32Array(SAT_MAX) },
      uSatN: { value: 0 },
      uSatShade: { value: realisticOn ? 1 : 0 },
      uShFloor: { value: SAT_SH_FLOOR },
    };
    mat.userData.satU = satU;
    const prevCompile = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, r) => {
      if (prevCompile) prevCompile(shader, r);
      Object.assign(shader.uniforms, satU);
      const reuseVWPos = shader.fragmentShader.includes('varying vec3 vWPos');
      // uSunPos / vWPos 可能已被链上前序补丁声明（土星环影前缀注入同名 uniform /
      // varying，语义一致——太阳场景系位置、modelMatrix·position 片元世界位），
      // 条件防重定义编译错误
      const reuseSunU = shader.fragmentShader.includes('uniform vec3 uSunPos');
      if (!reuseVWPos) {
        shader.vertexShader = 'varying vec3 vWPos;\n' + shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n vWPos = (modelMatrix * vec4(position, 1.0)).xyz;');
      }
      shader.fragmentShader =
        (reuseSunU ? '' : 'uniform vec3 uSunPos;\n') +
        'uniform vec3 uSatPos[' + SAT_MAX + '];\nuniform float uSatR[' + SAT_MAX + '];\nuniform float uSatUm[' + SAT_MAX + '];\nuniform float uSatPm[' + SAT_MAX + '];\nuniform int uSatN;\nuniform float uSatShade;\nuniform float uShFloor;\n' +
        (reuseVWPos ? '' : 'varying vec3 vWPos;\n') +
        shader.fragmentShader.replace('#include <aomap_fragment>', `#include <aomap_fragment>
        {
          if (uSatShade > 0.5 && uSatN > 0) {
            vec3 _sd = uSunPos - vWPos;
            float _ds = length(_sd);
            vec3 _ld = _sd / _ds;
            float _sh = 1.0;
            for (int i = 0; i < ${SAT_MAX}; i++) {
              if (i >= uSatN) break;
              vec3 _to = uSatPos[i] - vWPos;
              float _t = dot(_to, _ld);
              if (_t > 0.0 && _t < _ds) {
                float _d = length(_to - _ld * _t);
                _sh = min(_sh, mix(uShFloor, 1.0, smoothstep(uSatUm[i], uSatPm[i], _d)));
              }
            }
            reflectedLight.directDiffuse *= _sh;
          }
        }`);
    };
    const prevKey = mat.customProgramCacheKey;
    mat.customProgramCacheKey = () =>
      (prevKey ? prevKey.call(mat) : '') + '+sattransit' + (tag || '');
  }

  /* —— 轨迹线解析环遮挡（轨迹 vs 土星环显示层级）——
   * 环材质 depthWrite 必须关（开深度会在透明环片段上剔黑大气辉光壳，
   * 见 buildRingSystem 注释），因此轨迹线的深度测试对环无效——加色轨迹线
   * 画在环后面仍全亮透出，视觉上线「压在环上面」（Grand Finale 密集金线
   * 叠满环面，2026-10-05 用户报告）。
   * 修复走辉光壳 ringTrans 同款解析法：线 fragment 对「相机→片元」射线与
   * 各环平面求交，穿越点比片元更近且落在环带内时按环径向 alpha 衰减——
   * α=0 不影响、半透明按比例透光，二值深度缺陷不存在。全部轨迹线材质
   * （行星/卫星轨道线、主尾迹、已飞尾迹、Huygens 三尾、SOI 窗口线）统一
   * 注入；配套把线对象 renderOrder 提到环（0）之后：保证环先画、线后画，
   * 衰减只来自本注入（否则环若后绘会按 alpha 再压一次， behind 线双重变暗、
   * in-front 线被误压）。
   * 共享 uniforms（ringOccU）由 buildRingSystem 静态填充内外半径/贴图，
   * updateRender 逐帧填行星心（相机相对系）与极轴；无环行星不占槽。 */
  const RINGOCC_MAX = 4;
  const ringOccU = {
    uROccC: { value: Array.from({ length: RINGOCC_MAX }, () => new THREE.Vector3()) },
    uROccN: { value: Array.from({ length: RINGOCC_MAX }, () => new THREE.Vector3()) },
    uROccIn: { value: new Float32Array(RINGOCC_MAX) },
    uROccOut: { value: new Float32Array(RINGOCC_MAX) },
    uROccM0: { value: BLACK_TEX }, uROccM1: { value: BLACK_TEX },
    uROccM2: { value: BLACK_TEX }, uROccM3: { value: BLACK_TEX },
    uROccCnt: { value: 0 },
  };
  const ringOccList = [];   // { entry, slot }——updateRender 逐帧刷新 C/N
  function applyLineRingOcc(mat) {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
      if (prev) prev(shader, renderer);
      Object.assign(shader.uniforms, ringOccU);
      const reuseVWPos = shader.vertexShader.includes('varying vec3 vWPos');
      if (!reuseVWPos) {
        shader.vertexShader = 'varying vec3 vWPos;\n' + shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n vWPos = (modelMatrix * vec4(position, 1.0)).xyz;');
      }
      shader.fragmentShader =
        'uniform vec3 uROccC[' + RINGOCC_MAX + '];\nuniform vec3 uROccN[' + RINGOCC_MAX + '];\n' +
        'uniform float uROccIn[' + RINGOCC_MAX + '];\nuniform float uROccOut[' + RINGOCC_MAX + '];\n' +
        'uniform sampler2D uROccM0;\nuniform sampler2D uROccM1;\nuniform sampler2D uROccM2;\nuniform sampler2D uROccM3;\nuniform int uROccCnt;\n' +
        (reuseVWPos ? '' : 'varying vec3 vWPos;\n') +
        shader.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
        {
          vec3 _rd = vWPos - cameraPosition;
          float _len = length(_rd);
          if (_len > 1e-9) {
            _rd /= _len;
            float _tr = 1.0;
            for (int k = 0; k < ${RINGOCC_MAX}; k++) {
              if (k >= uROccCnt) break;
              float _den = dot(_rd, uROccN[k]);
              if (abs(_den) > 1e-6) {
                float _t = dot(uROccC[k] - cameraPosition, uROccN[k]) / _den;
                if (_t > 0.0 && _t < _len) {          // 环平面穿越点比片元更近 → 环在前
                  float _r = length(cameraPosition + _rd * _t - uROccC[k]);
                  if (_r > uROccIn[k] && _r < uROccOut[k]) {
                    float _uu = (_r - uROccIn[k]) / (uROccOut[k] - uROccIn[k]);
                    float _a = k == 0 ? texture2D(uROccM0, vec2(_uu, 0.5)).a
                             : k == 1 ? texture2D(uROccM1, vec2(_uu, 0.5)).a
                             : k == 2 ? texture2D(uROccM2, vec2(_uu, 0.5)).a
                             : texture2D(uROccM3, vec2(_uu, 0.5)).a;
                    /* 环纹理 alpha 是「美观半透明」（B 环 0.87-0.95、A 环 0.35-0.57、
                     * C 环 0.05-0.16），直接作透过率会让环后线只剩 40-60% 亮度，
                     * 亮带上残影明显 = 「线压在环上」（2026-10-06 用户复报）。
                     * 改光学深度模型：τ = −ln(1−α)（纹理原设计即自上而下混合，
                     * 垂直穿透 T=1−α 与现状一致），斜穿光程 ∝ 1/|sin⟨射线,环面⟩|
                     * ——低仰角视角下 B/A 环趋于不透明（真实冰环行为），C 环保持
                     * 半透明。下限 0.05 防掠射除零。 */
                    float _tau = -log(max(1.0 - _a, 1e-4));
                    float _sl = max(abs(dot(_rd, uROccN[k])), 0.05);
                    _tr *= clamp(exp(-_tau / _sl), 0.0, 1.0);
                  }
                }
              }
            }
            gl_FragColor.rgb *= _tr;                  // 显示空间衰减（软肩/环 alpha 同域）
          }
        }`);
    };
    const pk = mat.customProgramCacheKey;
    // cacheKey 必须逐材质唯一：r147 的 program 缓存按 key 全局共享，相同 key 的
    // 后续材质不会执行 onBeforeCompile，materialProperties.uniforms 里就没有
    // uROccC 系列注入 uniform——逐帧更新的环心/极轴永远传不到 GPU（遮挡失效，
    // 2026-10-06 GPU 直读实证）。唯一 key → 每材质各自编译 → 各自持 live 引用。
    mat.customProgramCacheKey = () => (pk ? pk.call(mat) : '') + '+ringocc_' + mat.uuid;
  }

  /* —— 气态行星环参数 ——
   * 内外半径（km）与纹理：土星/天王星用 NASA Eyes 官方环径向条带
   * （sprites/saturn_rings_top.png、uranus_rings.png，u=0 内缘），半径取其
   * RingsComponent 设定值；木星环尘埃极淡、海王星 Adams 弧段方位需与真实
   * 经度对齐——两者保留程序化径向纹理（js/textures.js，alpha 按真实光深）。 */
  const RINGS = {
    jupiter: { inner: 92000, outer: 226000, tex: 'proc:ringJupiter' },
    saturn:  { inner: 74270.58, outer: 140478.92, tex: 'saturnRing' },
    uranus:  { inner: 26840, outer: 103000, tex: 'uranusRing' },
    neptune: { inner: 40000, outer: 64000, tex: 'proc:ringNeptune' },
  };

  function buildRingSystem(entry, tiltGroup, def, rdef, aniso) {
    const inner = rdef.inner, outer = rdef.outer;
    const rg = new THREE.RingGeometry(inner, outer, 256, 1);
    const uv = rg.attributes.uv;
    const pos = rg.attributes.position;
    for (let i = 0; i < uv.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      const az = Math.atan2(pos.getY(i), pos.getX(i)) / TAU + 0.5;  // 方位角 → v（海王星 Adams 弧段）
      uv.setXY(i, (r - inner) / (outer - inner), az);
    }
    let rt;
    if (rdef.tex.startsWith('proc:')) {
      rt = window.ProcTextures.get(THREE, rdef.tex.replace('proc:', ''), { anisotropy: aniso });
    } else {
      rt = loadTex(rdef.tex, aniso);
    }
    const rm = new THREE.MeshLambertMaterial({
      map: rt, side: THREE.DoubleSide, transparent: true,
      // depthWrite 必须关：深度是二值的，透明环片段（卡西尼缝等 alpha≈0 处）
      // 也写深度，后绘的大气辉光壳被整体剔除，在亮弧上切出黑缝（木星/土星
      // 近拱截图可见）。环-大气层级改由辉光壳着色器按近侧环真实 alpha 解析
      // 衰减（见 atmoHaloShellMaterial）——半透明按比例透光、全透明不影响
      depthWrite: false, alphaTest: 0.01,
    });
    rm.userData.uniforms = {
      uSunPos: { value: new THREE.Vector3() },
      uPlanetPos: { value: new THREE.Vector3() },
      uPlanetR: { value: def.radius },
      uSunAngR: { value: 0 },   // 太阳角半径（行星处，逐帧）：本影收缩/半影宽度
      // 前向散射强度（逆光透射亮度上限，视觉标定）：属「效果」仅真实光照
      // 模式启用，逐帧按 realisticOn 置 0.85/0；本影遮断是几何修正不随模式
      uForwS: { value: 0 },
    };
    // 行星本影内的环段（item 3）：aomap_fragment 只乘直射光——
    // 普通模式剩环境光（与行星背阳面亮度一致），真实光照模式全黑。
    // 前向散射（卡西尼「土星背光」观感）：真实环的厘米级冰粒会透射阳光，
    // 逆光（视线与太阳方向同向）时环通体透亮。物理上透射亮度 ∝ 相位函数
    //（视线-太阳对齐度，前向强峰）× 光学厚度权重——纯透过率 (1−α) 在环缝
    // 处无物质发光为伪，取 α·(1−α)·4（缝处零、中等厚度峰值、最厚 B 环难
    // 穿透回落），色偏暖（透射穿过尘埃的橙棕色调）。受行星本影同款遮断：
    // 环段入影则无光可透，复用下方 sh 因子。前向散射属「效果」仅在真实光照
    // 模式启用（uForwS 逐帧置 0/0.85），本影遮断为几何修正、两模式均生效。
    // 相机制不变量：map/vUv 采样与
    // 漫反射同源，cameraPosition 为内置 uniform；DoubleSide 两侧同享。
    rm.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, rm.userData.uniforms);
      shader.vertexShader = 'varying vec3 vWorldPos;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;');
      shader.fragmentShader = 'uniform vec3 uSunPos;\nuniform vec3 uPlanetPos;\nuniform float uPlanetR;\nuniform float uSunAngR;\nuniform float uForwS;\nvarying vec3 vWorldPos;\n' +
        shader.fragmentShader.replace('#include <aomap_fragment>',
          `#include <aomap_fragment>
          {
            vec3 Ldir = normalize(vWorldPos - uSunPos);
            vec3 toP = uPlanetPos - uSunPos;
            float tP = dot(toP, Ldir);
            float dFrag = length(vWorldPos - uSunPos);
            float sh = 1.0;
            if (tP > 0.0 && tP < dFrag) {
              float closest = length(toP - Ldir * tP);
              // 本影半径 R−dP·rs 随距离收缩、半影外缘 R+dP·rs——dP 是片段沿
              // 光线越过行星中心的距离（dFrag−tP），不是日→片距 tP：半影宽度
              // 从行星起算（环处 ~110 km）；误用 tP（~日地距离量级）会把半影
              // 撑到数十万 km，整片背阳环糊成半黑。下限 0.002R 防亚像素闪烁
              float dP = max(dFrag - tP, 0.0);
              float penW = max(dP * uSunAngR, uPlanetR * 0.002);
              sh = smoothstep(uPlanetR - penW, uPlanetR + penW, closest);
              reflectedLight.directDiffuse *= sh;
            }
            vec3 Vdir = normalize(vWorldPos - cameraPosition);
            float cosP = dot(Vdir, -Ldir);   // 逆光度：视线与「面元→太阳」同向 ≈ 1
            if (cosP > 0.0) {
              vec4 texel = texture2D(map, vUv);
              float ta = texel.a * (1.0 - texel.a) * 4.0;
              reflectedLight.directDiffuse += vec3(1.0, 0.78, 0.55) *
                (ta * pow(cosP, 8.0) * uForwS * sh);
            }
          }`);
    };
    excludeDirLight(rm, 'ring');   // 环面同样忽略飞船平行光（本影判定只针对太阳点光）
    applySoftShoulder(rm, 'ring'); // 环亮弧同受直射光削顶，一并压肩
    const ring = new THREE.Mesh(rg, rm);
    ring.rotation.x = Math.PI / 2;
    tiltGroup.add(ring);
    entry.ringMesh = ring;
    entry.ringTexture = rt;
    // 轨迹线解析环遮挡（见 applyLineRingOcc）：静态参数按槽位注册
    {
      const slot = ringOccList.length;
      if (slot < RINGOCC_MAX) {
        ringOccU.uROccIn.value[slot] = inner;
        ringOccU.uROccOut.value[slot] = outer;
        ringOccU['uROccM' + slot].value = rt;
        ringOccU.uROccCnt.value = slot + 1;
        ringOccList.push({ entry, slot });
      }
    }
  }

  function buildBodies(onLabelClick) {
    const aniso = renderer.capabilities.getMaxAnisotropy();
    for (const def of BODIES) {
      const entry = {
        name: def.name,
        radius: def.radius,
        label: def.label,
        // 行星历表默认 Catmull-Rom：6h/24h 线性插值的弧高差达 355 km（地球），
        // 使锚定轨道（earthLin + rel cheb）相对主轨迹持续漂移、且在窗口进入时刻
        // （t=轨道起点+60s）产生 ~30 km 的横向跳变——放大回放时表现为轨迹末端
        // 折曲/标记抖动。CR 弧高差 <1e-4 km，卫星链路已同款（interp='cr'）。
        track: DATA.bodies[def.name] ? makeTrack(DATA.bodies[def.name].segs, DATA.bodies[def.name].interp || 'crp') : null,
        orbitLine: DATA.bodies[def.name] ? DATA.bodies[def.name].o : null,
        parent: DATA.bodies[def.name] ? DATA.bodies[def.name].parent || null : null,
        world: [0, 0, 0],
      };
      const rawElems = DATA.bodies[def.name] && DATA.bodies[def.name].elems;
      if (rawElems && rawElems.n) {
        entry.elems = {
          eT: b64ToFloat64(rawElems.eT),
          eV: b64ToFloat32(rawElems.eV),
          n: rawElems.n,
        };
      }
      const group = new THREE.Group();
      group.userData.n = def.name;
      const tiltGroup = new THREE.Group();
      const tilt = TILT[def.name] || [0, 0];
      tiltGroup.rotation.order = 'YXZ';   // 与 TILT 表约定一致（见其注释）
      tiltGroup.rotation.x = THREE.MathUtils.degToRad(tilt[0]);
      tiltGroup.rotation.y = THREE.MathUtils.degToRad(tilt[1] || 0);
      tiltGroup.updateMatrixWorld(true);
      group.add(tiltGroup);

      const segs = def.name === 'sun' ? 48 : (def.radius > 2000 ? 48 : 24);
      const geo = new THREE.SphereGeometry(1, segs * 2, segs);
      let tex = null;
      if (!def.tex.startsWith('proc:')) {
        tex = loadTex(def.tex, aniso);
        if (tex && def.texOffset) {
          // equirect 经度偏移（Iapetus：暗区质心 → 轨道前导半球）
          tex.wrapS = THREE.RepeatWrapping;
          tex.offset.x = def.texOffset;
          tex.needsUpdate = true;
        }
      } else {
        tex = window.ProcTextures.get(THREE, def.tex.replace('proc:', ''), { anisotropy: aniso });
        if (def.name === 'sun') tex.encoding = THREE.sRGBEncoding;  // 与烘焙贴图同管线的正确色彩
      }
      let mat;
      if (def.emissive) {
        mat = new THREE.MeshBasicMaterial({ map: tex });
        // 贴图亮度基础上整体提亮（>1 乘子压向饱和，亮黄盘面→炽白黄）
        mat.color.setRGB(1.45, 1.32, 1.05);
        if (def.name === 'sun') {
          // 盘缘增亮（参考图日缘偏白）：菲涅尔项注入，几何平滑无环状边界
          mat.onBeforeCompile = (shader) => {
            shader.vertexShader = shader.vertexShader
              .replace('#include <common>',
                '#include <common>\nvarying vec3 vSunN;\nvarying vec3 vSunV;')
              .replace('#include <begin_vertex>', `
                #include <begin_vertex>
                vSunN = normalize(normalMatrix * normal);
                vec4 sunMv = modelViewMatrix * vec4(position, 1.0);
                vSunV = normalize(-sunMv.xyz);`);
            shader.fragmentShader = shader.fragmentShader
              .replace('#include <common>',
                '#include <common>\nvarying vec3 vSunN;\nvarying vec3 vSunV;')
              .replace('#include <dithering_fragment>', `
                #include <dithering_fragment>
                {
                  float sunFres = pow(1.0 - clamp(dot(normalize(vSunN), normalize(vSunV)), 0.0, 1.0), 3.0);
                  gl_FragColor.rgb += vec3(0.75, 0.64, 0.34) * sunFres;
                }`);
          };
        }
      } else if (def.name === 'earth') {
        // NASA Eyes 同款：Phong + 海洋镜面贴图（specular 白=海面反光，黑=陆地）
        const spec = loadTex('earthSpecular', aniso);
        mat = new THREE.MeshPhongMaterial({
          map: tex, specularMap: spec,
          // 海洋镜面压到 ~3% 反光 + 窄高光（shininess 180）：只留日下点一点
          // 极淡耀斑，背光视角不再出现成片白斑
          specular: new THREE.Color(0x060a10), shininess: 180,
        });
        applyAtmoRim(mat, def.atmo);
        entry.atmoMat = mat;
      } else {
        mat = new THREE.MeshLambertMaterial({ map: tex });
        // 大气边缘光并入表面材质（地球/金星/火星/土卫六；不再使用独立大气壳）
        if (def.atmo) {
          applyAtmoRim(mat, def.atmo);
          entry.atmoMat = mat;
        }
      }
      const mesh = new THREE.Mesh(geo, mat);
      // flatten：扁椭球（木星等气态巨行星）——Y 压极轴，赤道半径 = def.radius
      const fl = def.flatten || 0;
      mesh.scale.set(def.radius, def.radius * (1 - fl), def.radius);
      mesh.layers.enable(2);   // bloom 掩膜遮挡通道（renderPost：不透明天体写深度挡泛光）
      tiltGroup.add(mesh);

      if (def.clouds) {
        // 独立云层球：真实 NASA 云量贴图（白云 + alpha 通道），与地表贴图分离；
        // 复用表面分段球保证轮廓一致。真实比例：地球云层厚 1–10 km，取云顶
        // 10 km（R⊕=6371 km，仅 +0.16%）；同分段球面平行、法向间距恒定，
        // 对数深度缓冲下不会与地表深度冲突
        const ct = loadTex('earthClouds', aniso);
        const cm = new THREE.MeshLambertMaterial({ map: ct, transparent: true, opacity: 0.9, depthWrite: false });
        const clouds = new THREE.Mesh(geo, cm);
        // 云层壳随扁率同压 Y 轴，极区与地表仍保持 ~10 km 间距
        clouds.scale.set(def.radius + 10, (def.radius + 10) * (1 - fl), def.radius + 10);
        tiltGroup.add(clouds);
        entry.clouds = clouds;
      }

      if (def.name === 'sun') {
        // 双层光晕壳：内壳 = 色球/内冕均匀亮晕（2.6R，盘缘增亮在日面材质内做）；
        // 外壳 = 外冕弥散长晕（9R）。剖面严格各向同性（只随瞄准距离 b 变化），
        // 壳缘窗口只做最后归零 → 各视距下均匀晕环，无角向明暗扇区与同心接缝；
        // 相机临近时 uFade 淡出（阈值见逐帧更新，随各自壳半径）
        const glowInner = new THREE.Mesh(
          new THREE.SphereGeometry(1, 48, 24),
          sunGlowShellMaterial({
            rSun: def.radius, mode: 'inner', shell: 2.6,
            intensity: 1.0, color: 0xfff2c6, side: THREE.BackSide,
          }));
        glowInner.scale.setScalar(def.radius * 2.6);
        glowInner.renderOrder = 1;
        glowInner.layers.enable(1);   // 太阳 bloom 掩膜通道（见 renderPost）
        group.add(glowInner);
        const glowOuter = new THREE.Mesh(
          new THREE.SphereGeometry(1, 64, 32),
          sunGlowShellMaterial({
            rSun: def.radius, mode: 'outer', shell: 9.0,
            intensity: 1.0, color: 0xfff6d8, side: THREE.BackSide,
          }));
        glowOuter.scale.setScalar(def.radius * 9.0);
        glowOuter.renderOrder = 1;
        glowOuter.layers.enable(1);
        group.add(glowOuter);
        entry.glowShell = glowInner;
        entry.glowShellOuter = glowOuter;
        // 日面圆盘同样进入掩膜通道（bloom 源 = 屏幕上所见太阳本体 + 光晕壳）
        mesh.layers.enable(1);
      }

      // 大气辉光壳（NASA Eyes 盘外光晕，壳高 = 大气层高度 1.045R）：旧行星光晕
      // 是 4.2R 广告牌高斯贴片，晕圈高出大气数倍且近距有切边——统一改为与行星
      // 同扁率的薄壳（光晕高度即大气高度，极区不悬浮），def.glow 转为壳色来源
      const haloDef = def.atmo && def.atmo.halo;
      if (haloDef || def.glow) {
        const shell = 1.045;
        const halo = new THREE.Mesh(
          new THREE.SphereGeometry(1, 64, 32),
          atmoHaloShellMaterial({
            rBody: def.radius, shell,
            color: haloDef ? haloDef.color : def.glow,
            intensity: haloDef ? haloDef.intensity : 0.95,
            flat: fl,
            polar: new THREE.Vector3(0, 1, 0).applyQuaternion(tiltGroup.quaternion).normalize(),
          }));
        halo.scale.set(def.radius * shell, def.radius * shell * (1 - fl), def.radius * shell);
        // 渲染顺序置于环（renderOrder 0）之后、标记（3+）之前：亮弧加色叠印
        // 在远侧环上（霾罩），近侧环的遮挡不靠深度——由着色器按视线近侧环
        // 穿越点的真实 alpha 衰减（见 fragmentShader 内 ringTrans 注释），
        // 透明环片段不再剔黑大气。盘内弧段仍由行星不透明深度剔除，坠入段内
        // 视（BackSide 远半球内表面）不受影响
        halo.renderOrder = 1;
        tiltGroup.add(halo);
        entry.haloShell = halo;
      }

      // —— 行星环系统（item 4：木/土/天/海四颗气态行星，真实半径与真实透明度）——
      const rdef = RINGS[def.name];
      if (rdef) buildRingSystem(entry, tiltGroup, def, rdef, aniso);

      // 辉光壳接环纹理：近侧环遮挡衰减需要环径向 alpha（u=0 内缘，与环材质
      // 和盘面环影同映射）；无环行星保持 uRingOut=-1 恒不命中
      if (entry.haloShell && entry.ringTexture) {
        const hu = entry.haloShell.material.uniforms;
        hu.uRingMap.value = entry.ringTexture;
        hu.uRingIn.value = rdef.inner;
        hu.uRingOut.value = rdef.outer;
      }

      if (def.name === 'saturn' && entry.ringTexture) {
        // 盘面环影（采样真实环 alpha）；环面法线 = tiltGroup +Y。
        // 注入 aomap_fragment：只乘 reflectedLight.directDiffuse——阴影=移除直射光，
        // 普通模式剩环境光 → 环影亮度与背阳面一致（item 3）；真实光照模式环境光
        // 为 0 → 本影全黑。depth 恒为 1.0（阴影移除全部直射光）。
        tiltGroup.updateMatrixWorld(true);
        tiltGroup.quaternion.setFromEuler(tiltGroup.rotation);
        const ringN = new THREE.Vector3(0, 1, 0).applyQuaternion(tiltGroup.quaternion).normalize();
        const sR = RINGS.saturn;
        const shU = {
          uSunPos: { value: new THREE.Vector3() },
          uPlanetPos: { value: new THREE.Vector3() },
          uRingN: { value: ringN },
          uRingMap: { value: entry.ringTexture },
          uInner: { value: sR.inner },
          uOuter: { value: sR.outer },
          uPlanetR: { value: def.radius },
          uRingShadowDepth: { value: 1.0 },
        };
        // 链式补丁： Saturn 现带大气边缘光（applyAtmoRim 已占 onBeforeCompile /
        // customProgramCacheKey），须先执行前序注入再叠加环影，缓存键同步串联
        const prevCompile = mat.onBeforeCompile;
        const prevCacheKey = mat.customProgramCacheKey;
        mat.onBeforeCompile = (shader, r) => {
          if (prevCompile) prevCompile(shader, r);
          Object.assign(shader.uniforms, shU);
          shader.vertexShader = 'varying vec3 vWPos;\n' + shader.vertexShader.replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\n vWPos = (modelMatrix * vec4(position, 1.0)).xyz;');
          shader.fragmentShader =
            'uniform vec3 uSunPos;\nuniform vec3 uPlanetPos;\nuniform vec3 uRingN;\nuniform sampler2D uRingMap;\nuniform float uInner;\nuniform float uOuter;\nuniform float uPlanetR;\nuniform float uRingShadowDepth;\nvarying vec3 vWPos;\n' +
            shader.fragmentShader.replace('#include <aomap_fragment>',
              `#include <aomap_fragment>
              {
                vec3 Ldir = normalize(uSunPos - vWPos);
                float denom = dot(Ldir, uRingN);
                if (abs(denom) > 1e-5) {
                  float tt = dot(uPlanetPos - vWPos, uRingN) / denom;
                  if (tt > 0.0) {
                    vec3 oc = uPlanetPos - vWPos;
                    float tProj = dot(oc, Ldir);
                    float d2 = dot(oc, oc) - tProj * tProj;
                    bool planetBlocks = (tProj > 0.0) && (d2 < uPlanetR * uPlanetR);
                    if (!planetBlocks && tt < length(uSunPos - vWPos)) {
                      vec3 hit = vWPos + Ldir * tt;
                      float rr = length(hit - uPlanetPos);
                      if (rr > uInner && rr < uOuter) {
                        float uu = (rr - uInner) / (uOuter - uInner);
                        float aa = texture2D(uRingMap, vec2(uu, 0.5)).a;
                        // 因子提为全局 _ringShadowF（applyAtmoRim 声明）：dithering
                        // 阶段的大气 rim/wash 加色按同因子遮暗
                        _ringShadowF = 1.0 - aa * uRingShadowDepth;
                        reflectedLight.directDiffuse *= _ringShadowF;
                      }
                    }
                  }
                }
              }`);
        };
        mat.userData.shadowU = shU;
        // 补丁链变体标记（防 program 缓存错配）
        mat.customProgramCacheKey = () =>
          (prevCacheKey ? prevCacheKey.call(mat) : '') + '+saturn-ringshadow';
      }

      entry.mesh = mesh;
      entry.tiltGroup = tiltGroup;
      // 扁椭球遮挡参数：极轴（世界系，= tiltGroup +Y）与扁率——viewOccluded 的
      // 射线-椭球判定用（正球判定会让土星 f=0.098 的极区方向提前 ~10% 遮挡）
      tiltGroup.quaternion.setFromEuler(tiltGroup.rotation);
      entry.flat = fl;
      entry.polarN = new THREE.Vector3(0, 1, 0).applyQuaternion(tiltGroup.quaternion).normalize();
      entry.group = group;
      if (!def.emissive) entry.surfMat = mat;   // 近距曝光补偿（见 updateRender 循环）
      if (!def.emissive) {
        excludeDirLight(mat);                             // 行星表面：忽略飞船平行光
        applySoftShoulder(mat, 'surf');                   // 高光软肩（削顶修复，仅真实光照）
        // item 6 晨昏线半影：同一 penU 共享给表面/云层（updateRender 只刷一份）
        const penU = { uPenOn: { value: realisticOn ? 1 : 0 }, uPenW: { value: PEN_W } };
        entry.penU = penU;
        applyPenumbra(mat, 'surf', penU);
        if (entry.clouds) {
          excludeDirLight(entry.clouds.material);
          applySoftShoulder(entry.clouds.material, 'cloud');
          applyPenumbra(entry.clouds.material, 'cloud', penU);
        }
      }
      scene.add(group);

      if (entry.orbitLine) {
        const arr = b64ToFloat32(entry.orbitLine);
        const pts = new Float32Array(arr.length);
        for (let i = 0; i < arr.length; i += 3) {
          const w = eclToThree([arr[i], arr[i + 1], arr[i + 2]]);
          pts[i] = w[0]; pts[i + 1] = w[1]; pts[i + 2] = w[2];
        }
        const og = new THREE.BufferGeometry();
        og.setAttribute('position', new THREE.BufferAttribute(pts, 3).setUsage(THREE.DynamicDrawUsage));
        // 顶点色承载随时间淡出（材质色 × 顶点灰度）
        const orbitColAttr = new THREE.BufferAttribute(new Float32Array(arr.length), 3)
          .setUsage(THREE.DynamicDrawUsage);
        og.setAttribute('color', orbitColAttr);
        const isMoon = !!entry.parent;
        // 加色混合：轨道线是 UI 叠加层，允许叠在太阳光晕上但不允许压暗它
        //（Normal 混合的深蓝线叠画在太阳点上会把核心「啃」成斑驳蓝灰——
        // 用户报告的「太阳靠近土星大气突然变暗」实为漂入轨道线带，2026-10-05）；
        // 淡出经顶点色趋向黑，加色下即自然隐没，且不会在亮环上留下暗痕。
        const om = new THREE.LineBasicMaterial({
          color: isMoon ? 0x5a7096 : 0x46587a, vertexColors: true,
          transparent: true, opacity: isMoon ? 0.58 : 0.72,
          blending: THREE.AdditiveBlending, depthWrite: false,
        });
        applyLineRingOcc(om);          // 线在环后按环 alpha 衰减（层级修复）
        const line = new THREE.LineLoop(og, om);
        line.frustumCulled = false;
        line.renderOrder = 0.5;        // 环(0)之后绘制，衰减唯一（见 applyLineRingOcc）
        entry.orbitLineObj = line;
        entry.orbitColAttr = orbitColAttr;
        entry.orbitBaseOp = om.opacity;   // 近距淡出以基础透明度为基准（见 updateRender）
        scene.add(line);
      }

      const el = document.createElement('div');
      el.className = 'label';
      el.textContent = def.label;
      el.addEventListener('click', (e) => { e.stopPropagation(); onLabelClick(def.name); });
      labelsEl.appendChild(el);
      entry.labelEl = el;

      // 缩小视角时的亮点标记（天体盘面 <3.5px 时出现）：太阳比行星更大更亮
      const isSun = def.name === 'sun';
      const mm = new THREE.SpriteMaterial({
        map: isSun ? dotTexture() : markerTexture(), transparent: true,
        depthWrite: false, depthTest: !isSun,
        sizeAttenuation: true, opacity: isSun ? 1 : 0.85,
        blending: isSun ? THREE.AdditiveBlending : THREE.NormalBlending,
        color: isSun ? 0xffffff : 0xdce9ff,
      });
      if (isSun) mm.color.setRGB(1.45, 1.32, 1.0);   // 过亮暖白：太阳标记显著亮于行星
      const mini = new THREE.Sprite(mm);
      mini.renderOrder = isSun ? 4 : 3;
      scene.add(mini);
      entry.miniMarker = mini;
      entry.miniParams = isSun
        ? { size: 8, op0: 1.0, op1: 1.0 }
        : { size: 2.6, op0: 0.75, op1: 1.0 };

      registry.set(def.name, entry);
    }

    // —— 卫星凌日投影（item 3）：卫星按母行星分组，母行星表面/云层材质注入影判定 ——
    // 仅 earth（moon）与 saturn（titan/enceladus/iapetus/rhea/dione/tethys/mimas）
    // 有卫星；其余行星 uSatN=0 不注入（省 program 变体）。
    for (const [name, entry] of registry) {
      if (name === '__sunLight' || !entry.parent) continue;
      const p = registry.get(entry.parent);
      if (!p) continue;
      (p.satMoons || (p.satMoons = [])).push(entry);
    }
    for (const [, p] of registry) {
      if (p.satMoons && p.surfMat) {
        applySatTransit(p.surfMat, 'surf');
        if (p.clouds) applySatTransit(p.clouds.material, 'cloud');
        // updateRender 逐帧更新入口:表面/云层共用同一组 satU(applySatTransit
        // 以 mat.userData.satU 存储;同一行星两材质各持一份,取表面的作为代表——
        // 每帧同时刷新两者)
        p.satU = p.surfMat.userData.satU;
        p.satUCloud = p.clouds ? p.clouds.material.userData.satU : null;
      }
    }
  }

  // ---------- Cassini marker + detailed model（NASA 官方 GLB 模型：装载见 js/cassini_model.js） ----------
  /* 单位 = km（GLB 米制、1/1000 缩放）。机体坐标：+Z = HGA 指向轴（对地球），
   * +X = RTG 桁架方向。全尺寸（磁强计双杆跨距）≈ 17.98 m。 */
  const MODEL_SPAN = 0.0180;  // km
  function buildCassini() {
    const sm = new THREE.SpriteMaterial({
      map: dotTexture(), transparent: true, depthTest: false,
      sizeAttenuation: true,
    });
    cassiniMarker = new THREE.Sprite(sm);
    cassiniMarker.center.set(0.5, 0.5);
    cassiniMarker.renderOrder = 10;
    scene.add(cassiniMarker);

    const model = new THREE.Group();
    model.name = 'cassiniModel';
    cassiniModel = model;
    scene.add(model);

    // NASA 官方 GLB（异步装载）：分离前显示完整组合体 stack，2004-12-25 分离后切换为
    // 轨道器 orbiter（without-Huygens）；Huygens（probe）转入独立轨迹（js/huygens.js）
    window.CassiniModel.load((parts) => {
      cassiniStack = parts.stack;
      cassiniOrbiter = parts.orbiter;
      huygensMesh = parts.probe;
      if (cassiniStack) model.add(cassiniStack);
      if (cassiniOrbiter) model.add(cassiniOrbiter);
      if (huygensMesh) {
        scene.add(huygensMesh);
        huygensMesh.visible = false;
        window.HuygensVis.init({
          scene, registry, eclToThree, cassiniPosAt, dotTexture, viewOccluded, modelFadeK,
          applyLineRingOcc,
          trailOpts: () => trailOptions,
          // 分离前组合体姿态（Cassini 体轴 → 惯性系）：探测器按真实结构挂点
          // 定位到组合体上需要与母船同姿态，随真实姿态回放逐帧更新
          cassiniQuatAt: () => _attQ,
        }, huygensMesh);
      }
    });
  }

  // ---------- trails ----------
  function buildTrail() {
    const sharedAttr = new THREE.BufferAttribute(trailPosBuffer, 3).setUsage(THREE.DynamicDrawUsage);
    const gFull = new THREE.BufferGeometry();
    gFull.setAttribute('position', sharedAttr);
    trailFullLine = new THREE.Line(gFull, new THREE.LineBasicMaterial({
      color: 0x6f96c8, transparent: true, opacity: 0.34, depthWrite: false,
      blending: THREE.AdditiveBlending,   // 同轨道线：不压暗太阳光晕（见 buildOrbit 注释）
    }));
    applyLineRingOcc(trailFullLine.material);
    trailFullLine.frustumCulled = false;
    trailFullLine.renderOrder = 0.5;      // 环(0)之后，线在环后按 alpha 衰减
    scene.add(trailFullLine);
    const gFlown = new THREE.BufferGeometry();
    gFlown.setAttribute('position', sharedAttr);
    const colArr = new Float32Array(trailN * 3);
    gFlown.setAttribute('color', new THREE.BufferAttribute(colArr, 3).setUsage(THREE.DynamicDrawUsage));
    trailFlownLine = new THREE.Line(gFlown, new THREE.LineBasicMaterial({
      color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false,
    }));
    applyLineRingOcc(trailFlownLine.material);
    trailFlownLine.frustumCulled = false;
    trailFlownLine.renderOrder = 0.5;
    scene.add(trailFlownLine);

    const gLead = new THREE.BufferGeometry();
    gLead.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TAIL_VERTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
    gLead.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TAIL_VERTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
    tailAbs = new THREE.Line(gLead, new THREE.LineBasicMaterial({
      color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false,
    }));
    applyLineRingOcc(tailAbs.material);
    tailAbs.frustumCulled = false;
    tailAbs.renderOrder = 0.5;
    scene.add(tailAbs);
    // 一级/二级 SOI 相对系尾迹：帧变换在 updateTrailTail 内逐帧求值（行星当前位置
    // − 历表轨迹），顶点色与 abs 尾迹同批次写入；透明度随对应窗口线同步（updateSoiTrails）
    const mkTail = () => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TAIL_VERTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TAIL_VERTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({
        color: 0xffffff, vertexColors: true, transparent: true, opacity: 0, depthWrite: false,
      }));
      applyLineRingOcc(line.material);
      line.frustumCulled = false;
      line.renderOrder = 0.5;
      line.visible = false;
      scene.add(line);
      return line;
    };
    tailPlanet = mkTail();
    tailMoon = mkTail();
  }

  /* SOI 相对轨迹几何构建：窗口 = 主轨迹时间域子区间，顶点 = 行星锚定世界坐标
   * planet_ref + rel(t_i)（rel = merged − 行星/卫星历表位置，f64 预计算于 w.rel）。
   * 相对轨迹随行星当前位置整体平移（NASA Eyes 语义），与日心轨迹仅在飞船处
   * 相交；缓冲在浮动原点下按需重建（updateSoiTrails），精度与主轨迹一致。 */
  function buildSoi() {
    for (const name of Object.keys(soiRaw)) {
      const entry = registry.get(name);
      const winsRaw = soiRaw[name];
      if (!entry || !winsRaw || !winsRaw.length) continue;
      const parentEntry = entry.parent ? registry.get(entry.parent) : null;
      if (entry.parent && !parentEntry) continue;
      const wins = [];
      for (const wr of winsRaw) {
        let a, b;
        if (wr && wr.a !== undefined) { a = wr.a; b = wr.b; }
        else if (wr && wr.t !== undefined) {          // 旧版行数据：仅取时间端点
          const t = b64ToFloat64(wr.t);
          a = t[0]; b = t[t.length - 1];
        } else continue;
        // 窗口内轨迹顶点区间 [i0, i0+n)
        let i0 = Math.min(idxGte(trailT, a - 1.0), trailN - 2);
        let i1 = idxGte(trailT, b + 1.0) - 1;         // 最后一个 t <= b 的顶点
        i1 = Math.max(i1, i0 + 1);
        let n = i1 - i0 + 1;
        // rel(t_i)：优先用烘焙端 f64 直算的相对几何（去锚小量，f32 无损）。
        // 回退路径（旧数据）：rel = trailThree(f32 日心) − 锚定体日心，
        // 会继承 f32 日心坐标量化误差（土星段 ULP 128 km → 相对轨迹 ±111 km 错位）。
        let rel, rel0 = null;
        if (wr && wr.rel && wr.i0 !== undefined && wr.n && wr.rel0) {
          i0 = wr.i0; n = wr.n;
          rel = b64ToFloat32(wr.rel);
          rel0 = b64ToFloat64(wr.rel0);          // 窗口锚点（f64，3 个数）
        } else {
          rel = new Float64Array(n * 3);
          for (let i = 0; i < n; i++) {
            const ti = trailT[i0 + i];
            entry.track.at(ti, tmpV);
            let ax = tmpV[0], ay = tmpV[1], az = tmpV[2];
            if (parentEntry) {
              parentEntry.track.at(ti, tmpV);
              ax += tmpV[0]; ay += tmpV[1]; az += tmpV[2];
            }
            const g = (i0 + i) * 3;
            rel[i * 3] = trailThree[g] - ax;
            rel[i * 3 + 1] = trailThree[g + 1] - az;    // ecl→three: y=z, z=-y
            rel[i * 3 + 2] = trailThree[g + 2] + ay;
          }
        }
        const pos = new Float32Array(n * 3);
        const gFull = new THREE.BufferGeometry();
        gFull.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
        const full = new THREE.Line(gFull, new THREE.LineBasicMaterial({
          color: 0x8fb0d8, transparent: true, opacity: 0, depthWrite: false,
          blending: THREE.AdditiveBlending,   // 同轨道线：不压暗太阳光晕
        }));
        applyLineRingOcc(full.material);
        full.frustumCulled = false; full.visible = false;
        full.renderOrder = 0.5;
        scene.add(full);
        const gFlown = new THREE.BufferGeometry();
        gFlown.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
        const colAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
        gFlown.setAttribute('color', colAttr);
        const flown = new THREE.Line(gFlown, new THREE.LineBasicMaterial({
          color: 0xffffff, vertexColors: true, transparent: true, opacity: 0, depthWrite: false,
        }));
        applyLineRingOcc(flown.material);
        flown.frustumCulled = false; flown.visible = false;
        flown.renderOrder = 0.5;
        scene.add(flown);
        wins.push({
          a, b, i0, n, times: trailT.subarray(i0, i1 + 1), rel, rel0, full, flown, colAttr,
          built: false, pRef: { x: 0, y: 0, z: 0 },
        });
      }
      if (wins.length) soiPlanets.set(name, { entry, wins });
    }
  }

  /* 窗口缓冲构建（**一次性**，与相机、行星位置均无关）：
   *   buf_i = rel_i − rel0        （f32；−rel0 后 |buf| ≤ 窗口内飞船偏移跨度，
   *                                土星窗 ULP ≤ ~0.4 km，卫星窗 ~1e-3 km）
   * 渲染世界坐标由对象位置逐帧在 f64 中给出：
   *   line.position = 锚定体当前 + rel0 − camWorld
   *   ⇒ 渲染位置 ≡ 锚定体当前 + rel_i（相对系语义）− cam，与缩放级别无关。
   *
   * 旧实现把 camWorld 当缓冲原点（buf = planet_ref + rel − camWorld）：
   * 远视角 |buf| 达 1e9..1e10 km → f32 ULP 64..700 km，且阈值触发下远视角
   * 每帧都满足重建条件、每帧以新相机原点重写 38 万顶点 → 量化台阶逐帧跳变，
   * 整条相对轨迹相对行星/主轨迹可见错位（用户反馈「远视角滑动视角时轨迹错位」）。
   * 新设计缓冲不含相机量 → 永不重建，该缺陷在结构上不可能发生。 */
  function buildSoiWindow(w) {
    const arr = w.full.geometry.attributes.position.array;
    for (let i = 0; i < w.n * 3; i++) arr[i] = w.rel[i];
    // full/flown 两个 BufferAttribute 包裹同一数组但各自持有独立 GPU 缓冲，
    // 必须双双标记上传——否则 flown 永远渲染全零缓冲（轨迹不可见）
    w.full.geometry.attributes.position.needsUpdate = true;
    w.flown.geometry.attributes.position.needsUpdate = true;
    w.built = true;
  }

  /* re-base heliocentric trail vertices to a floating origin.
   * 顶点缓冲 = world − origin（f32，world 为 f64）；线对象位置 = origin − cam
   * 逐帧在 f64 中精确补偿——渲染位置恒等于 world − cam，与重定基准频率无关
   * （此前不补偿：相机每移动 thr 之内轨迹整体随镜头"滑动"，最大缩放时
   * thr ≪ 帧间位移使补偿线每帧重写 30 万顶点 + 3.7MB 上传，正是最大缩放
   * 抖动源；过节制后轨迹又滞后于视差，近处顶点以最大 thr 抖动）。
   * 重定基准仅服务于 f32 精度：origin 漂移 bound 内，近处顶点值的 f32 量化
   * 误差折算角 ≤ ~1px（bound = min(2000·dEff, 5e5 km)），远处顶点误差角
   * 恒 ~1e-7 rad 不可见。暂停/拖拽/最大缩放时相机相对 origin 不再变化，
   * 完全免重写。 */
  const trailOrigin = { x: 0, y: 0, z: 0 };
  function rebaseTrail() {
    const ox = trailOrigin.x - camWorld.x;
    const oy = trailOrigin.y - camWorld.y;
    const oz = trailOrigin.z - camWorld.z;
    trailFullLine.position.set(ox, oy, oz);
    trailFlownLine.position.set(ox, oy, oz);
    // 动态尾迹与主轨迹共用同一浮动原点（顶点缓冲 = [世界 − trailOrigin]，
    // 见 writeTailLine）。位置必须逐帧同步——否则远视角下尾迹以 f32 绝对
    // 坐标抖动（量化步长可达数十 km），而主轨迹稳定，两者相对抖动明显。
    tailAbs.position.set(ox, oy, oz);
    tailPlanet.position.set(ox, oy, oz);
    tailMoon.position.set(ox, oy, oz);
    // SOI 窗口线的位置由 updateSoiTrails 逐帧设置（行星锚定 + 浮动原点补偿）
    const dx = camWorld.x - trailOrigin.x;
    const dy = camWorld.y - trailOrigin.y;
    const dz = camWorld.z - trailOrigin.z;
    const dEff = (window.CassiniCamera && window.CassiniCamera.state)
      ? window.CassiniCamera.state.sDist : 4.2e6;
    const bound = Math.min(Math.max(dEff * 2000, 1e3), 5e5);
    if (dx * dx + dy * dy + dz * dz < bound * bound) return;
    trailOrigin.x = camWorld.x;
    trailOrigin.y = camWorld.y;
    trailOrigin.z = camWorld.z;
    // 原点已跳变：主轨迹缓冲重写，尾迹缓冲由 updateTrailTail 逐帧重写（同基准）
    const arr = trailPosBuffer;
    for (let i = 0; i < trailN * 3; i += 3) {
      arr[i] = trailThree[i] - camWorld.x;
      arr[i + 1] = trailThree[i + 1] - camWorld.y;
      arr[i + 2] = trailThree[i + 2] - camWorld.z;
    }
    trailFullLine.geometry.attributes.position.needsUpdate = true;
    trailFlownLine.geometry.attributes.position.needsUpdate = true;
    // SOI 窗口缓冲为锚定体相对量（rel − rel0），与相机/行星位置无关 → 永不重建
  }

  /* 动态尾迹逐帧更新（在 updateSoiTrails 之后调用，可读 soiState 与活动窗口）：
   * 以 cassiniPosAt（与标记/模型/相机目标同一位置函数）重采样 [衔接点, t]，
   * 末端延伸至下一烘焙顶点与 future 线衔接——尾迹与飞船零相对偏差。三张尾迹
   * 各自独立时间网格：abs 从 trailT[idxTail] 起；一级/二级相对系从
   * max(trailT[idxTail], win.a) 起（窗口前不画，且起点与窗口线首顶点逐位一致）。
   * 相对系帧变换 = 锚定体当前位置 − 历表轨迹(t_i)（与窗口线同一锚定语义）；
   * 颜色与 flown 线同式年龄淡出；延伸段远端按所属 future 线颜色补偿，色界融入渐变。 */
  /* 动态尾迹逐帧更新（在 updateSoiTrails 之后调用，可读 soiState 与活动窗口）：
   * 以 cassiniPosAt（与标记/模型/相机目标同一位置函数）重采样 [衔接点, t]，
   * 末端终止于【当前时刻 t 本身】（即标记处）——past/tail 全段金色，future 线
   * 自 t 起为蓝色，颜色在飞船处硬切换，中间无过渡段。三张尾迹各自独立时间
   * 网格：abs 从 trailT[idxTail] 起；一级/二级相对系从 max(trailT[idxTail], win.a)
   * 起。相对系帧变换 = 锚定体在【各自采样时刻】的位置（见 frameAnchorAt）——
   * 用当前帧位置会引入时变平移使尾迹折曲。 */
  const _tailP = [0, 0, 0];
  function updateTrailTail(t, cassTrail, trailK) {
    const show = cassTrail && trailK > 0.01;
    const recent = trailOptions.mode === 'recent';
    // —— abs（日心系）：网格起点 = 修剪后的烘焙末顶点，终点 = 当前时刻 ——
    // 亮度分层全部在 updateSoiTrails 完成（SOI 内压暗不隐藏）；此处始终重采样，
    // 可见性交给透明度门限。
    let n = 0;
    if (show) {
      const tTail = trailT[tailIdxTail];
      for (let j = 0; j <= 11; j++) {
        tailTimes[n] = tTail + (t - tTail) * (j / 11);
        cassiniPosAt(tailTimes[n], _tailP);
        tailPts[n * 3] = _tailP[0]; tailPts[n * 3 + 1] = _tailP[1]; tailPts[n * 3 + 2] = _tailP[2];
        n++;
      }
      tailAbs.visible = tailAbs.material.opacity > 0.01;
      if (tailAbs.visible) writeTailLine(tailAbs, 0, n, t, recent, null);
    } else {
      tailAbs.visible = false;
    }
    tailCount = n;
    // —— 一级（行星 SOI）/ 二级（卫星 SOI）相对系 ——
    updateRelTail(tailPlanet, soiState.name, t, show);
    updateRelTail(tailMoon, soiState.moon, t, show);
  }

/* 尾迹线写出：times/位置已在共享数组 [i0, i1)，帧变换 frameBody 非空时按
 * 锚定体【该采样时刻】的位置 − 历表轨迹(t_i) 平移（frameBody.world 仅
 * 对当前帧 t 有效，故此处逐点按 tailTimes[i] 求值）；颜色 = flown 同式
 * 年龄淡出。tail 全段一律金色，与 future 线在飞船处硬切换——不做单顶点
 * 蓝色补偿（那会在末端形成一段金→蓝渐变，即"颜色过渡"）。
 *
 * 浮动原点：与主轨迹同为 [世界 − trailOrigin]，线对象 position = trailOrigin − cam
 * （由 rebaseTrail 逐帧设置）。**不可**直接写 [世界 − camWorld]：远视角下
 * |世界 − cam| 达 5e8 km，f32 量化步长 32 km，相机绕转时顶点逐帧在量化桶间
 * 跳变 → 尾迹相对主轨迹（量化基准被 bound 钳在 5e5 km，步长 0.03 km）持续
 * 抖动。统一基准后两者量化误差同阶，相对抖动消除。 */
function writeTailLine(line, i0, i1, t, recent, frameBody) {
  const arr = line.geometry.attributes.position.array;
  const col = line.geometry.attributes.color.array;
  const o = trailOrigin;
  for (let i = i0; i < i1; i++) {
    const g = i * 3;
    let x = tailPts[g], y = tailPts[g + 1], z = tailPts[g + 2];
    if (frameBody) {
      // 相对轨迹帧变换：rel(t_i) = tailPts(t_i) − 锚定体世界位置(t_i)，
      // 再锚到锚定体【当前】世界位置。两项都须按各自时刻求值——
      // 用当前帧的 frameBody.world 代替 (t_i) 会引入时变平移（发射段
      // 地球 960 s 位移 ~2.9 万 km），使尾迹相对 flown/full 折出近直角。
      frameAnchorAt(frameBody, tailTimes[i], _anchBody);   // 体心 @ t_i
      const wPast = eclToThree(_anchBody);
      frameAnchorAt(frameBody, t, _anchBody);              // 体心 @ t_now
      const wNow = eclToThree(_anchBody);
      x += wNow[0] - wPast[0];
      y += wNow[1] - wPast[1];
      z += wNow[2] - wPast[2];
    }
    arr[g] = x - o.x;
    arr[g + 1] = y - o.y;
    arr[g + 2] = z - o.z;
    const age = t - tailTimes[i];
    const f = fadeFactor(age) * (recent ? recentFactor(age) : 1);
    col[g] = f * TAIL_BASE[0];
    col[g + 1] = f * TAIL_BASE[1];
    col[g + 2] = f * TAIL_BASE[2];
  }
  line.geometry.attributes.position.needsUpdate = true;
  line.geometry.attributes.color.needsUpdate = true;
  line.geometry.setDrawRange(i0, i1 - i0);
  line.visible = true;
}

  /* 一级/二级相对系尾迹：锚定体无活动窗口（k≈0 或 t 在窗口时间域外）时隐藏，
   * 与窗口线同步；网格起点 = max(trailT[idxTail], win.a)，与窗口 flown 修剪端衔接 */
  function updateRelTail(line, bodyName, t, show) {
    line.visible = false;
    if (!show || !bodyName || line.material.opacity <= 0.01) return;
    const sp = soiPlanets.get(bodyName);
    if (!sp) return;
    const win = soiWindowAt(sp, t);
    if (!win) return;
    const recent = trailOptions.mode === 'recent';
    const t0 = Math.max(trailT[tailIdxTail], win.a);
    let n = 0;
    for (let j = 0; j <= 11; j++) {
      const ti = t0 + (t - t0) * (j / 11);
      if (ti > win.b) break;
      tailTimes[n] = ti;
      cassiniPosAt(ti, _tailP);
      tailPts[n * 3] = _tailP[0]; tailPts[n * 3 + 1] = _tailP[1]; tailPts[n * 3 + 2] = _tailP[2];
      n++;
    }
    if (n < 2) return;
    // 尾迹终点 = 当前时刻 t（标记处）；future 线自窗口内下一烘焙顶点起画，
    // 颜色在飞船附近硬切换，无渐变过渡段。
    writeTailLine(line, 0, n, t, recent, sp.entry);
  }

  /* trail fades with age (vertex colors) */
  const FADE_TAU = 180 * 86400;
  const FADE_FLOOR = 0.05;
  const FADE_CUT = FADE_TAU * Math.log((1 - FADE_FLOOR) / 1e-3);  // 指数项 <0.1% 的年龄界
  function fadeFactor(age) {
    return FADE_FLOOR + (1 - FADE_FLOOR) * Math.exp(-Math.max(0, age) / FADE_TAU);
  }
  /* recent 模式：超出 RECENT_SPAN - RECENT_RAMP 的部分在剩余 RAMP 内 smoothstep 淡出至 0 */
  function recentFactor(age) {
    if (age <= RECENT_SPAN - RECENT_RAMP) return 1;
    const x = Math.min(1, (age - (RECENT_SPAN - RECENT_RAMP)) / RECENT_RAMP);
    return 1 - x * x * (3 - 2 * x);
  }
  function applyTrailFade(line, times, t, baseColor, count, start, always) {
    if (!line.geometry.attributes.color) return;
    start = start || 0;
    const cache = line.userData;
    const mode = trailOptions.mode;
    const nowW = performance.now();
    if (always) {
      // 相对轨迹窗口：墙钟 10 Hz 节流刷新（回放中颜色跟随更快，开销封顶）
      if (cache._lastFadeWall !== undefined && nowW - cache._lastFadeWall < 100 &&
          cache._lastFadeStart === start && cache._lastFadeMode === mode) return;
      cache._lastFadeWall = nowW;
    } else if (
        cache._lastFadeT !== undefined && Math.abs(t - cache._lastFadeT) < 600 &&
        cache._lastFadeStart === start && cache._lastFadeMode === mode) return;
    cache._lastFadeT = t;
    cache._lastFadeStart = start;
    cache._lastFadeMode = mode;
    const colAttr = line.geometry.attributes.color;
    const arr = colAttr.array;
    const n = Math.min(count, times.length);
    const recent = mode === 'recent';
    for (let i = start; i < n; i++) {
      const age = t - times[i];
      let f;
      if (age > FADE_CUT) {
        // 远古段指数项已归零：免 30 万次/帧的 exp，直接写常数（recent 模式为 0）
        f = recent ? 0 : FADE_FLOOR;
      } else {
        f = fadeFactor(age) * (recent ? recentFactor(age) : 1);
      }
      arr[i * 3] = f * baseColor[0];
      arr[i * 3 + 1] = f * baseColor[1];
      arr[i * 3 + 2] = f * baseColor[2];
    }
    colAttr.needsUpdate = true;
  }

  // ---------- per-frame ----------
  let _cassWorld = [0, 0, 0];
  let frameCount = 0;
  let forceOrbitRebuild = true;
  let lastShadowT = -1;          // 阴影贴图重绘节流：时刻变化 / 相机移动 / 强制时重绘
  let forceShadowRefresh = true; // 切换真实光照 / 首帧强制刷新
  const lastShadowLightPos = new THREE.Vector3(1e12, 0, 0); // 上次重绘时的光源位置（相机相对系）
  const soiState = { name: null, k: 0, moon: null, k2: 0, win: null };
  // 复用的模块级临时对象（避免每帧分配触发 GC 抖动）
  const _camQInv = new THREE.Quaternion();
  const _sd = new THREE.Vector3();
  const _kOf = new Map();

  function updatePositions(t) {
    for (const [name, entry] of registry) {
      if (name === '__sunLight') continue;
      if (!entry.track) continue;
      entry.track.at(t, tmpV);
      const w = eclToThree(tmpV);
      if (entry.parent) {
        const p = registry.get(entry.parent);
        entry.world[0] = p.world[0] + w[0];
        entry.world[1] = p.world[1] + w[1];
        entry.world[2] = p.world[2] + w[2];
      } else {
        entry.world[0] = w[0]; entry.world[1] = w[1]; entry.world[2] = w[2];
      }
    }
    cassiniPosAt(t, tmpV);
    _cassWorld[0] = tmpV[0]; _cassWorld[1] = tmpV[1]; _cassWorld[2] = tmpV[2];
    return { cassWorld: _cassWorld };
  }

  function updateRender(t) {
    const hPx = window.innerHeight;
    const projScale = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    // Cassini 模型屏占（像素）：驱动航天器轨迹模型级淡出 + 标记/模型交接
    const dCam = Math.hypot(
      _cassWorld[0] - camWorld.x,
      _cassWorld[1] - camWorld.y,
      _cassWorld[2] - camWorld.z);
    const modelPx = MODEL_SPAN / (projScale * Math.max(dCam, 1e-6)) * hPx;
    // 两台航天器任一进入模型特写 → 全部航天器轨迹一并淡出（惠更斯特写时
    // 卡西尼轨迹同样退场，反之亦然；惠更斯因子滞后一帧，过渡平滑不可感知）
    modelFade = Math.max(
      modelFadeK(modelPx),
      (window.HuygensVis && window.HuygensVis.modelFade) || 0);
    const trailK = 1 - modelFade;   // 航天器轨迹亮度乘子（模型特写时 → 0）
    for (const [name, entry] of registry) {
      if (name === '__sunLight') continue;
      entry.group.position.set(
        entry.world[0] - camWorld.x,
        entry.world[1] - camWorld.y,
        entry.world[2] - camWorld.z,
      );
    }
    registry.get('__sunLight').light.position.set(-camWorld.x, -camWorld.y, -camWorld.z);

    // ---- 环系统 uniform（四颗气态行星环的本影判定 + 土星盘面环影）----
    for (const [name, entry] of registry) {
      if (name === '__sunLight') continue;
      if (entry.ringMesh && entry.ringMesh.material.userData.uniforms) {
        const u = entry.ringMesh.material.userData.uniforms;
        u.uSunPos.value.set(-camWorld.x, -camWorld.y, -camWorld.z);
        u.uPlanetPos.value.copy(entry.group.position);
        // 太阳角半径（行星处）：半影宽度随日-行距离逐帧更新（环物质写深度，
        // 大气辉光壳后绘按深度剔除，见 buildRingSystem / halo 注释）
        const dPS = Math.hypot(
          entry.group.position.x + camWorld.x,
          entry.group.position.y + camWorld.y,
          entry.group.position.z + camWorld.z) || 1;
        u.uSunAngR.value = Math.asin(Math.min(1, SUN_RADIUS / dPS));
        u.uForwS.value = realisticOn ? 0.85 : 0;
      }
      if (entry.mesh && entry.mesh.material.userData && entry.mesh.material.userData.shadowU) {
        const u = entry.mesh.material.userData.shadowU;
        u.uSunPos.value.set(-camWorld.x, -camWorld.y, -camWorld.z);
        u.uPlanetPos.value.copy(entry.group.position);
      }
      // 晨昏线半影（item 6）：门禁随模式切换（效果类仅真实光照，uSatShade 同款）
      if (entry.penU) entry.penU.uPenOn.value = realisticOn ? 1 : 0;
      // 卫星凌日投影（item 3，见 applySatTransit 注释）：uSatShade 按门禁规则
      // 仅真实光照置 1/0；卫星场景系位置 = group.position（updatePositions 已更新）
      if (entry.satU) {
        const n = Math.min(entry.satMoons.length, SAT_MAX);
        for (const u of [entry.satU, entry.satUCloud]) {
          if (!u) continue;
          u.uSunPos.value.set(-camWorld.x, -camWorld.y, -camWorld.z);
          u.uSatShade.value = realisticOn ? 1 : 0;
          u.uSatN.value = n;
          for (let i = 0; i < n; i++) {
            const sm = entry.satMoons[i];
            u.uSatPos.value[i].copy(sm.group.position);
            u.uSatR.value[i] = sm.radius;
            // 物理影半径（km，见 applySatTransit 注释）：θs = R☉/日卫距，
            // L = 卫星→行星心沿影轴投影 → r_u = R − Lθs、r_p = R + Lθs
            _satAx.copy(sm.group.position).sub(u.uSunPos.value);
            const dSun = _satAx.length() || 1;
            _satAx.divideScalar(dSun);
            _satRel.copy(entry.group.position).sub(sm.group.position);
            const L = Math.max(0, _satRel.dot(_satAx));
            const th = SUN_RADIUS / dSun;
            const ru = Math.max(sm.radius * 0.12, sm.radius - L * th);
            const rp = Math.max(ru + sm.radius * 0.05, sm.radius + L * th);
            u.uSatUm.value[i] = ru;
            u.uSatPm.value[i] = rp;
          }
        }
      }
    }

    // ---- 大气边缘昼向 uniform（已并入表面材质）+ 辉光壳太阳位置 ----
    // 轨迹线解析环遮挡（applyLineRingOcc）：环平面圆心（相机相对系）与极轴逐帧刷新
    for (const ro of ringOccList) {
      ringOccU.uROccC.value[ro.slot].copy(ro.entry.group.position);
      ringOccU.uROccN.value[ro.slot].copy(ro.entry.polarN);
    }
    _camQInv.copy(camera.quaternion).invert();
    for (const [name, entry] of registry) {
      if (name === '__sunLight') continue;
      if (entry.atmoMat) {
        // 太阳（原点）→ 天体 方向，转到视图空间
        _sd.set(-entry.world[0], -entry.world[1], -entry.world[2]).applyQuaternion(_camQInv);
        entry.atmoMat.userData.atmoU.uSunDirView.value.copy(_sd);
      }
      if (entry.haloShell) {
        // 场景为相机相对系：太阳世界位姿 = -camWorld（辉光壳昼夜调制用）
        entry.haloShell.material.uniforms.uSunPos.value.set(-camWorld.x, -camWorld.y, -camWorld.z);
      }
    }

    // ---- 轨道线与行星严格重合（item 8）----
    // 逐帧平移修正 Δ = 实际历表位置 − 密切椭圆位置；聚焦天体每帧相位中心化
    // 重建（顶点落在行星上），其余每 15 天重建 + 平移修正。
    const focusName = (window.CassiniCamera && window.CassiniCamera.currentFocus()) || null;
    const _act = [0, 0, 0], _ell = [0, 0, 0];
    let orbIdx = 0;
    for (const [name, entry] of registry) {
      if (name === '__sunLight' || !entry.orbitLineObj || !entry.elems) continue;
      entry.orbitLineObj.visible = trailOptions.planetOrbits;
      if (!trailOptions.planetOrbits) { orbIdx++; continue; }
      // —— 近距淡出：该天体盘面屏占增大时其轨道线退场（飞至 6R 即完全隐去）——
      const dO = Math.hypot(
        entry.world[0] - camWorld.x,
        entry.world[1] - camWorld.y,
        entry.world[2] - camWorld.z);
      const fO = (2 * entry.radius / Math.max(dO, 1e-6)) / projScale;
      const okFade = smooth01((fO - ORBIT_FADE_F0) / (ORBIT_FADE_F1 - ORBIT_FADE_F0));
      entry.orbitLineObj.visible = okFade < 0.99;
      entry.orbitLineObj.material.opacity = entry.orbitBaseOp * (1 - okFade);
      entry.track.at(t, _act);
      if (!ellipsePosEcl(entry, t, _ell)) continue;
      const dx = _act[0] - _ell[0], dy = _act[1] - _ell[1], dz = _act[2] - _ell[2];
      const w = eclToThree([dx, dy, dz]);
      if (entry.parent) {
        const p = registry.get(entry.parent);
        entry.orbitLineObj.position.set(
          p.world[0] + w[0] - camWorld.x,
          p.world[1] + w[1] - camWorld.y,
          p.world[2] + w[2] - camWorld.z);
      } else {
        entry.orbitLineObj.position.set(
          w[0] - camWorld.x, w[1] - camWorld.y, w[2] - camWorld.z);
      }
      if (name === focusName || forceOrbitRebuild) {
        rebuildOrbitLine(entry, t);
      } else if (entry._orbitEpoch === undefined ||
          Math.abs(t - entry._orbitEpoch) >
            (entry.parent ? 86400 : 15 * 86400)) {
        // 大跨度跳转（>30 天）立即全量重建（17 条线 ~4k 次开普勒解 <2ms）；
        // 常规推进按 (frameCount+orbIdx) 错峰，每帧最多重建一条
        if (entry._orbitEpoch === undefined ||
            Math.abs(t - entry._orbitEpoch) > 30 * 86400 ||
            (frameCount + orbIdx) % 24 === 0) rebuildOrbitLine(entry, t);
      }
      if (trailOptions.planetOrbits) applyOrbitFade(entry, t);
      orbIdx++;
    }
    forceOrbitRebuild = false;

    // ---- 潮汐锁定 + 真实自转（item 9）----
    applySpin(t);

    // ---- 日心轨迹：重定基准 + 未来/近期显示（item 2）；cassini 总开关 ----
    rebaseTrail();
    const idxNow = trailIndexAt(t);
    const cassTrail = trailOptions.cassini;
    // 动态尾迹衔接点：span = 3 个局部节拍（clamp [900s, 64800s]）。三张 flown 线
    // 修剪到 idxTail，其后的末端段由动态尾迹接管（updateTrailTail，与标记/模型/
    // 相机目标同一位置函数逐帧重采样 → 尾迹与飞船零相对偏差，烘焙节拍的末端
    // 弦摆动与锚定轨道激活后的矢高差摆动从此消除）
    const cadence = idxNow > 0 ? Math.max(1, trailT[idxNow] - trailT[idxNow - 1]) : 900;
    const span = Math.min(Math.max(3 * cadence, 900), 64800);
    let idxTail = trailIndexAt(t - span);
    if (idxTail >= idxNow) idxTail = Math.max(0, idxNow - 1);
    tailIdxTail = idxTail;
    trailFullLine.visible = cassTrail && trailOptions.future && trailK > 0.01;
    if (trailFullLine.visible) {
      // 首弦 [idxNow → idxNow+1] 由尾迹延伸段接管（锚定轨道激活时按真实路径绘制），
      // future 线从 idxNow+1 起画，衔接点逐位重合
      trailFullLine.geometry.setDrawRange(idxNow + 1, Math.max(0, trailN - (idxNow + 1)));
    }
    const startIdx = trailOptions.mode === 'recent' ? lowerBound(trailT, t - RECENT_SPAN) : 0;
    const flownCount = idxTail + 1 - startIdx;
    trailFlownLine.visible = cassTrail && trailK > 0.01 && flownCount >= 2;
    if (trailFlownLine.visible) {
      trailFlownLine.geometry.setDrawRange(startIdx, flownCount);
      applyTrailFade(trailFlownLine, trailT, t, TAIL_BASE, idxTail + 1, startIdx);
    }

    // ---- SOI 相对行星轨迹（item 3）----
    updateSoiTrails(t);

    // ---- 行星本影掩食（item 6，仅真实光照模式）----
    // 点光不投射阴影 → 卡西尼/惠更斯进入行星本影后仍被照亮；按太阳/行星
    // 视角半径实时解算掩食因子并调制模型材质（0=全食，1=无食）
    if (realisticOn && window.CassiniModel) {
      let fC = eclipseFactor(_cassWorld);
      let fH = fC;
      let hw = null;
      if (window.HuygensVis) {
        hw = window.HuygensVis.tryWorldAt(t);
        if (hw) fH = eclipseFactor(hw);
      }
      window.CassiniModel.setEclipse(fC, fH);
      // 行星反照光：不受掩食因子直接调制——采样面元自带局地光照权重，
      // 飞船进入本影时看到的正是行星夜面，反照光随采样变暗自然熄灭。
      // item 7：掩食因子一并传入，本影内解算环照/大气边缘残差补项
      // （(1−f) 加权，f=1 无食时严格归零）。分离后的惠更斯位置一并传入：
      // 探测器按自身位置独立解算（未分离为 null，挂于组合体走轨道器那套
      // uniforms）
      updatePlanetShine(t >= HUYGENS_SEP_ET ? hw : null, fC, fH);
    }

    // ---- Cassini marker + model（真实尺寸缩放 + 真实姿态）----
    // hPx/projScale/dCam/modelPx 已在函数顶部计算（与轨迹淡出共用）
    const cassWorld = _cassWorld;
    cassiniMarker.position.set(cassWorld[0] - camWorld.x, cassWorld[1] - camWorld.y, cassWorld[2] - camWorld.z);
    cassiniModel.position.copy(cassiniMarker.position);
    cassiniModel.scale.setScalar(1);   // 始终真实大小：缩小视角时模型随之缩至真实尺寸
    cassiniModel.visible = modelPx > 1.1;
    // 光晕收敛由模型屏占驱动：模型即将出现（modelPx 2→6px）时保持大标记过渡，
    // 其余所有缩放级别一律收敛为 2.6px 行星档小亮点，任何中远距都无光晕
    let shrink = THREE.MathUtils.clamp((6 - modelPx) / 5.5, 0, 1);
    shrink = shrink * shrink * (3 - 2 * shrink);
    const markerPx = 10 - 7.4 * shrink;
    cassiniMarker.material.opacity = Math.max(0, Math.min(1, (6 - modelPx) / 4)) * (1 - 0.1 * shrink);
    const desired = projScale * dCam * (markerPx / hPx);   // 精确屏占 = markerPx（无 ×2 放大系数）
    cassiniMarker.scale.set(Math.max(desired, 0.02), Math.max(desired, 0.02), 1);
    // 遮挡剔除（同太阳标记）：Cassini 藏到行星盘面之后时隐藏亮点
    cassiniMarker.visible = cassiniMarker.material.opacity > 0.01 &&
      !viewOccluded(cassWorld[0], cassWorld[1], cassWorld[2], null);
    updateCassiniAttitude(cassWorld, t);
    // 分离（2004-12-25）：组合体 → 轨道器（without-Huygens）；Huygens 独立飞行（js/huygens.js）
    if (cassiniStack && cassiniOrbiter) {
      const sep = t >= HUYGENS_SEP_ET;
      cassiniStack.visible = !sep;
      cassiniOrbiter.visible = sep;
    }
    if (window.HuygensVis) window.HuygensVis.update(t, camWorld, projScale, hPx, modelFade, trailOrigin);

    // —— 飞船自阴影（真实光照模式）：平行光对准太阳 + 阴影贴图按需重绘 ——
    // 光源/目标均置于相机相对系（浮动原点），方向 = 飞船→太阳。阴影贴图内容
    // 只取决于姿态与太阳方向（相对量，随相机平移不变），但阴影采样矩阵
    // shadow.matrix 仅在重绘时按当时的相机相对坐标计算——暂停时相机一旦
    // 移动/缩放，浮点原点整体平移而矩阵仍映射旧坐标，阴影采样错位：小幅
    // 位移时全船深度比对失败误判入影（整船变黑），大幅位移时采样越出
    // 阴影锥（自阴影消失）。故除时刻变化外，光源相对位置变化（= 相机
    // 移动，阈值 1 cm，滤除数值抖动）也须重绘；视角静止时维持零重绘。
    // 模型不可见（屏占 <1.1px）或真实光照关闭时整条阴影管线休眠，零额外开销。
    // 锚点跟随可见者：阴影正交锥仅 ±14 m，只覆盖锚定体周边。探测器材质同样
    // 经 uPointOff 归零点光、完全依赖本平行光，而惠更斯分离（HUYGENS_SEP_ET）
    // 后独立飞行至数万 km 外——恒锚定卡西尼时探测器落在阴影锥外（r147 锥外
    // 片段返回全亮），自阴影静默失效。按当前可见模型重锚：分离前 probe 可见
    // 性恒 false，huygensMesh.visible 为真即已分离；两者同屏时优先卡西尼
    // （探测器远距优雅降级为无自阴影，与现状一致）。平行光方向全场统一，
    // 重锚仅平移阴影锥，太阳极远方向差可忽略；锚点跳变经 lastShadowLightPos
    // 阈值（1 cm²）自然触发阴影重绘，无需额外标记。
    if (realisticOn &&
        (cassiniModel.visible || (huygensMesh && huygensMesh.visible))) {
      let anchor = _cassWorld;
      if (!cassiniModel.visible && huygensMesh && huygensMesh.visible) {
        const hw = window.HuygensVis && window.HuygensVis.getWorld();
        if (hw) anchor = hw;   // 惯性系日心坐标（与 _cassWorld 同系，太阳位于原点）
      }
      const dS = Math.hypot(anchor[0], anchor[1], anchor[2]) || 1;
      const rx = anchor[0] - camWorld.x,
            ry = anchor[1] - camWorld.y,
            rz = anchor[2] - camWorld.z;
      const ux = -anchor[0] / dS, uy = -anchor[1] / dS, uz = -anchor[2] / dS;
      shipSunLight.position.set(rx + ux * 0.05, ry + uy * 0.05, rz + uz * 0.05);
      shipSunLight.target.position.set(rx, ry, rz);
      if (forceShadowRefresh || t !== lastShadowT ||
          shipSunLight.position.distanceToSquared(lastShadowLightPos) > 1e-10) {
        renderer.shadowMap.needsUpdate = true;   // 本帧渲染前重绘（渲染器内自动复位）
        lastShadowT = t;
        forceShadowRefresh = false;
        lastShadowLightPos.copy(shipSunLight.position);
      }
    }

    // 动态尾迹：轨迹末端实时跟随当前位置（在 updateSoiTrails 之后，需 soiState 与活动窗口）
    updateTrailTail(t, cassTrail, trailK);

    // glows fade when close; mini markers for sub-pixel bodies
    for (const [name, entry] of registry) {
      if (name === '__sunLight') continue;
      const d = Math.hypot(
        entry.world[0] - camWorld.x,
        entry.world[1] - camWorld.y,
        entry.world[2] - camWorld.z);
      // —— 近距曝光补偿 —— 行星盘面逼近满屏时按比例压暗表面/云层材质，
      // 抑制 Lambert 亮面削顶（直射光 2.075 × 浅色贴图 → 贴近亮行星满屏白板，
      // 条带细节尽失；旧 1.25R 下限即已出现）。屏占 <0.55 屏高完全不动作，
      // 远观亮度零变化；此后按 (0.55/full)^0.6 平滑压暗，下限 0.42。
      // 只调材质 color 乘子，不影响飞船/光晕/环，模拟眼与相机的曝光适应。
      if (entry.surfMat) {
        const full = (2 * entry.radius / Math.max(d, 1e-6)) / projScale;
        const dim = full > 0.55 ? Math.max(0.42, Math.pow(0.55 / full, 0.6)) : 1;
        entry.surfMat.color.setScalar(dim);
        if (entry.clouds) entry.clouds.material.color.setScalar(dim);
      }
      if (entry.glowShell) {
        // 相机进入光晕壳内时淡出，避免暖纱遮蔽星空（内外壳阈值随各自壳半径：
        // 内壳 2.6R 在 1.5R 起淡（原值即为此，壳半径未变故不动）；外壳 9R 的
        // 阈值 (d/r-1.9)/3.0 → 1.9R 起淡、4.9R 满亮，外冕长晕在中等视距即全亮）
        const r = entry.radius;
        entry.glowShell.material.uniforms.uFade.value =
          Math.min(1, Math.max(0, (d / r - 1.5) / 1.1));
        if (entry.glowShellOuter) {
          entry.glowShellOuter.material.uniforms.uFade.value =
            Math.min(1, Math.max(0, (d / r - 1.9) / 3.0));
        }
      }
      // 大气辉光壳无逐帧 uniform：外视/内视剖面按相机高度在 shader 内交接
      // （atmoHaloShellMaterial），近距地平雾带即坠入段的大气散射
      if (entry.miniMarker) {
        const mp = entry.miniParams;
        const angPx = (2 * entry.radius / Math.max(d, 1e-6)) / projScale * hPx;
        const f = mp.size * Math.max(0, Math.min(1, 1 - angPx / 3.5));
        if (f > 0.3) {
          const ws = projScale * d * (f / hPx);
          entry.miniMarker.position.set(
            entry.world[0] - camWorld.x,
            entry.world[1] - camWorld.y,
            entry.world[2] - camWorld.z);
          entry.miniMarker.scale.set(ws, ws, 1);
          entry.miniMarker.material.opacity = mp.op0 + (mp.op1 - mp.op0) * (f / mp.size);
          // 遮挡剔除：天体被更近行星挡住时亮点一并隐藏（太阳标记 depthTest:false）；
          // 无深度测试的标记再补飞船实体遮挡（太阳在飞船正后方时不得透过船体）
          entry.miniMarker.visible = !viewOccluded(
            entry.world[0], entry.world[1], entry.world[2], name) &&
            (entry.miniMarker.material.depthTest || !craftOccluded(
              entry.world[0], entry.world[1], entry.world[2]));
        } else {
          entry.miniMarker.visible = false;
        }
      }
    }

    frameCount++;
    return { cassWorld };
  }

  /* 真实自转 + 潮汐锁定（IAU 数据，SPIN 表） */
  const _q1 = new THREE.Quaternion();
  const _v1 = new THREE.Vector3();
  function applySpin(t) {
    for (const [name, entry] of registry) {
      if (name === '__sunLight') continue;
      const s = SPIN[name];
      if (!s || !entry.mesh) continue;
      if (s.lock && entry.parent) {
        const p = registry.get(entry.parent);
        if (p) {
          _v1.set(p.world[0] - entry.world[0], p.world[1] - entry.world[1], p.world[2] - entry.world[2]);
          entry.tiltGroup.getWorldQuaternion(_q1).invert();
          _v1.applyQuaternion(_q1);
          // SphereGeometry 的 equirect 中心（u=0.5 = 本初子午线/月球正面）在网格
          // 局部 +X 轴：rotation.y 须让 +X 指向母星。旧式 atan2(x,z) 指 +Z，
          // 正面恒偏 90°（月球朝向地球的是西侧月海而非正面中心）
          entry.mesh.rotation.y = Math.atan2(-_v1.z, _v1.x);
          continue;
        }
      }
      let ang = s.w0 * D2R + TAU * t / s.period;
      ang = ang % TAU;
      entry.mesh.rotation.y = ang;
    }
    // 地球云层：起始相位与地表一致（w0），角速度 = 地表 × (1 + 漂移倍率)，
    // 漂移倍率为负 → 云系相对地表向西移动（信风方向），量级不变、方向与东漂相反
    const earth = registry.get('earth');
    if (earth && earth.clouds) {
      const se = SPIN.earth;
      earth.clouds.rotation.y = (se.w0 * D2R + TAU * t / se.period * (1 + EARTH_CLOUD_DRIFT)) % TAU;
    }
  }

  /* 行星本影掩食因子（item 6）：0 = 全食（本影），1 = 无食。
   * 由卡西尼处太阳与行星的视角半径、角距解算：θ ≤ rp−rs 全食、
   * θ ≥ rp+rs 无食，其间线性软过渡（半影）。对全部天体取最暗值。 */
  const SUN_RADIUS = 696000;
  function eclipseFactor(w) {
    const dC = Math.hypot(w[0], w[1], w[2]);
    if (dC <= SUN_RADIUS) return 0;
    const rs = Math.asin(SUN_RADIUS / dC);
    let f = 1;
    for (const [name, e] of registry) {
      if (name === '__sunLight' || name === 'sun' || !e.radius) continue;
      const px = e.world[0], py = e.world[1], pz = e.world[2];
      const t = (px * w[0] + py * w[1] + pz * w[2]) / dC;   // 行星中心在日→天体射线上的投影距
      if (t <= 0 || t >= dC) continue;                      // 行星须位于太阳与天体之间
      const dx = px - w[0], dy = py - w[1], dz = pz - w[2];
      const dPl = Math.hypot(dx, dy, dz);
      if (dPl < e.radius) return 0;                          // 已撞入行星本体
      const rp = Math.asin(Math.min(1, e.radius / dPl));
      const cosT = (-w[0] * dx - w[1] * dy - w[2] * dz) / (dC * dPl);
      const th = Math.acos(Math.max(-1, Math.min(1, cosT)));
      const ff = (th - (rp - rs)) / (2 * rs);
      if (ff < f) f = ff <= 0 ? 0 : Math.min(1, ff);
      if (f === 0) return 0;
    }
    return f;
  }

  /* —— 行星反照光（真实光照模式）：近距行星反射的太阳光照明飞船 ——
   * 物理量级 E_shine/E_sun ≈ α_g × (R/d)² × k：几何反照率 × 行星盘立体角占比
   * (R/d)² × 相位亮度 k = (1+cosα)/2。α 为行星侧相位角（日-行星-飞船）：d≪AU
   * 时它与飞船处日-行星张角互补，取错会使明暗反相；飞船在向日面上空 α→0
   * 见全相 k→1，行星位于飞船与太阳之间（飞船在夜面上空）α→180° k→0 只见
   * 夜面，与 eclipseFactor 本影判定自洽。逐帧取贡献最大
   * 的天体：Grand Finale 近土点 d≈1.06R 时 (R/d)²≈0.9，土照可达直射阳光四成；
   * 卫星飞掠（Enceladus 25 km 掠过等）同一模型自动生效。
   * 照明经 CassiniModel.setShine 注入飞船材质（包裹漫射 + 金属镜面）而非场景
   * 光源——场景光会泄漏到行星材质，材质注入与模型级补光（injectFill）同一
   * 惯例只进飞船。包裹宽度 w = sin(行星角半径) = R/d：行星是扩展光源，张角
   * 越大光越软（w→1 占满天空退化为半球环境光，w→0 远距退化为平行光），物理
   * 照明截止角 90°+γ 处精确归零。方向按相机四元数转入视图空间（同大气
   * uSunDirView 惯例）。色调与亮度随位置实时解算：按飞船天底点（偏向日面，
   * 相位越亏越贴向日下点——亮面才是反照光的实际来源）采样行星表面贴图本色，
   * 地球海洋→深蓝偏暗、大陆→土黄/绿，气态巨行星随纬度取云带色；行星阴影区
   * （夜面）面元按局地光照加权趋零，反照光随之减弱；贴图未就绪/缺失回退
   * SHINE_TINT 静态色。 */
  const SHINE_ALBEDO = {
    saturn: 0.47, jupiter: 0.52, earth: 0.37, venus: 0.67, mars: 0.25,
    mercury: 0.14, moon: 0.14, neptune: 0.41, uranus: 0.48, titan: 0.22,
    enceladus: 1.2, rhea: 0.65, dione: 0.55, tethys: 0.8, mimas: 0.6, iapetus: 0.30,
  };
  const SHINE_TINT = {
    saturn: [1.0, 0.92, 0.74], jupiter: [1.0, 0.93, 0.80],
    earth: [0.72, 0.82, 1.0], venus: [1.0, 0.95, 0.82], mars: [1.0, 0.83, 0.65],
    titan: [1.0, 0.82, 0.55],
  };
  /* —— item 7 暗面土照：本影内暗面残差反照光 ——
   * 原模型在飞船进入行星本影时反照光按相位 k→0 熄灭（看到的是行星夜面），
   * 飞船暗面严格全黑。物理上本影内仍有两路真实光源：①环照——土星环大部分
   * 位于本影之外（本影在环面处的影带很窄），环冰反光环绕飞船；②大气边缘
   * 散射——太阳光擦着行星limb折射/散射进影锥（真探 frames 里呈橙红光环）。
   * 二者是围绕行星中心的扩展源，量级远小于直射与全相反照光，故建模为对既有
   * 反照光链路的残差补项：iRes = α_g·(R/d)²·K_ecl·(1−f)。f 为掩食因子
   * （eclipseFactor，1=无食 → 补项归零，严格不污染非掩食段），K_ecl 校准
   * 全食时残差 ≈ 直射阳光的 4–5%（Grand Finale 近土点 (R/d)²≈0.89 时
   * iRes ≈ 0.47×0.89×0.10 ≈ 0.042）。色调取静态值（环冰偏暖金；地球大气
   * 边缘为橙红暮光——贴图采样在本影内会给出全零夜面色，不可用）。 */
  const SHINE_ECL = { saturn: 0.10, jupiter: 0.05, earth: 0.06 };
  const SHINE_ECL_TINT = {
    saturn: [1.0, 0.94, 0.82], jupiter: [1.0, 0.90, 0.75], earth: [1.0, 0.62, 0.40],
  };
  /* —— 位置相关色调与亮度：表面贴图 CPU 采样 ——
   * 每天体懒抽取一张 128×64 equirect 缩略图（image/canvas 统一走 drawImage，
   * 贴图就绪前逐帧重试），并记录其全球平均亮度 lum（线性域）。逐帧在局部切
   * 平面取天底 ±10° 共 5 点双线性采样，每点先按贴图编码线性化、再按局地朗伯
   * 光照 max(0, N·L) 加权累加——行星阴影区（夜面）面元权重趋零，反照光随之
   * 减弱：飞掠晨昏线时变暗、深入夜面时近乎熄灭（月球/卫星进入地影等掩食
   * 几何下同理自洽）。加权和除以 5·lum（线性域）锚定：全球均亮面元 → 亮度
   * ≈1，云层冰面高于 1（钳 3），海洋暗色地质低于 1（伊阿珀托斯明暗两面对比
   * 可达数倍）；总体量级仍由 SHINE_ALBEDO
   * 标量控制。经纬度约定与 applySpin 一致：网格局部 +X 轴 = 贴图中心（本初
   * 子午线），行 0 = 北极（flipY 贴图顶行）。sRGB 贴图（loadTex）按 sRGB
   * 曲线线性化，proc 画布贴图本就按线性解释。贴图未就绪/缺失回退 SHINE_TINT
   * 静态色。 */
  const _shineAcc = [0, 0, 0];
  const _shineTex = [0, 0, 0];
  const _shineQ = new THREE.Quaternion();
  const _shineNadir = new THREE.Vector3();
  const _shineSunDir = new THREE.Vector3();
  const _shineSmp = new THREE.Vector3();
  const _shineS = new THREE.Vector3();
  const _shineT1 = new THREE.Vector3();
  const _shineT2 = new THREE.Vector3();
  function ensureShineMap(e) {
    if (e._shineMap !== undefined) return e._shineMap;
    const map = e.mesh && e.mesh.material && e.mesh.material.map;
    if (!map) { e._shineMap = null; return null; }   // 无贴图天体：永久回退静态色
    const img = map.image;
    if (!img || !img.width) return undefined;        // 贴图未就绪，下帧重试
    const W = 128, H = 64;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;
    const srgb = map.encoding === THREE.sRGBEncoding;
    const dec = (v) => srgb
      ? (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
      : v;                                       // proc 画布贴图本就按线性解释
    let lsum = 0;
    for (let i = 0; i < data.length; i += 4) {
      // 全球平均亮度取线性域（与采样一致）：先解码再算亮度
      lsum += 0.2126 * dec(data[i] / 255) +
              0.7152 * dec(data[i + 1] / 255) +
              0.0722 * dec(data[i + 2] / 255);
    }
    e._shineMap = {
      d: data, w: W, h: H,
      lum: lsum / (W * H),                           // 全球平均亮度（线性域，采样锚点）
      srgb,
      off: (map.offset && map.offset.x) || 0,        // equirect 经度偏移（Iapetus）
    };
    return e._shineMap;
  }
  function shineTexel(m, u, rowF, out) {
    const W = m.w, H = m.h, d = m.d;
    const x = ((u % 1) + 1) % 1 * W;
    const y = Math.min(Math.max(rowF, 0), H - 1);
    const x0 = Math.floor(x) % W, y0 = Math.floor(y);
    const fx = x - Math.floor(x), fy = y - y0;
    const x1 = (x0 + 1) % W, y1 = Math.min(y0 + 1, H - 1);
    const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4;
    const i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
    for (let c = 0; c < 3; c++) {
      const a = d[i00 + c] + (d[i10 + c] - d[i00 + c]) * fx;
      const b = d[i01 + c] + (d[i11 + c] - d[i01 + c]) * fx;
      out[c] = a + (b - a) * fy;
    }
  }
  function sampleShineTint(e, k, cdx, cdy, cdz, out) {
    const m = ensureShineMap(e);
    if (!m) return false;
    // 天底（行星中心→飞船）与日面方向转入网格局部系（含倾角 + 当前自转角）
    e.mesh.getWorldQuaternion(_shineQ).invert();
    _shineNadir.set(-cdx, -cdy, -cdz).applyQuaternion(_shineQ);
    const se = registry.get('sun');
    if (se) {
      _shineSunDir.set(
        se.world[0] - e.world[0], se.world[1] - e.world[1], se.world[2] - e.world[2]
      ).applyQuaternion(_shineQ).normalize();
    } else {
      _shineSunDir.set(0, 0, 0);
    }
    // 采样点自天底向日面偏置：可见亮面随相位亏缺向日侧边缘退缩为新月，
    // 偏置 ~tan(α/2)·R 无上限以始终落在被照亮面（亮度衰减由相位因子 k 负责），
    // α = 日-行星-飞船张角（k = (1+cosα)/2）
    const alpha = Math.min(Math.PI - 1e-4,
      Math.acos(Math.max(-1, Math.min(1, 2 * k - 1))));
    const bias = 0.5 * Math.tan(alpha / 2);
    _shineSmp.copy(_shineNadir).addScaledVector(_shineSunDir, bias).normalize();
    // 局部切平面标架：天底点 + 沿表面 ±10°（东/北）共 5 点抑海岸线跳变
    _shineT1.set(0, 1, 0);
    if (Math.abs(_shineSmp.y) > 0.99) _shineT1.set(1, 0, 0);
    _shineT2.crossVectors(_shineSmp, _shineT1).normalize();   // 东
    _shineT1.crossVectors(_shineT2, _shineSmp).normalize();   // 北
    const acc = _shineAcc;
    acc[0] = acc[1] = acc[2] = 0;
    const dt = Math.tan(10 / 180 * Math.PI);
    let lamSum = 0;
    for (let i = 0; i < 5; i++) {
      _shineS.copy(_shineSmp);
      if (i & 3) {
        _shineS.addScaledVector((i & 1) ? _shineT2 : _shineT1, (i & 2) ? -dt : dt)
          .normalize();
      }
      const lam = Math.max(0, _shineS.dot(_shineSunDir));   // 局地朗伯光照
      if (lam <= 0) continue;                               // 阴影面元不反光
      lamSum += lam;
      const u = 0.5 + Math.atan2(_shineS.z, _shineS.x) / TAU + m.off;
      const row = Math.acos(Math.max(-1, Math.min(1, _shineS.y))) / Math.PI * (m.h - 1);
      shineTexel(m, u, row, _shineTex);
      for (let c = 0; c < 3; c++) {
        // 先线性化再加权：反射亮度 ∝ 反照率 × 局地光照，均在线性域
        const v = _shineTex[c] / 255;
        acc[c] += (m.srgb
          ? (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
          : v) * lam;
      }
    }
    // 锚定：采样均值/全球均值（acc 与 lum 均为线性域 0..1）
    const inv = 1 / (5 * Math.max(m.lum, 0.002));
    let lr = acc[0] * inv, lg = acc[1] * inv, lb = acc[2] * inv;
    // 亮度钳制：云面/冰面可高于全球均值，钳 3 防局部爆亮（等比缩保色相）
    const lum2 = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    const cs = lum2 > 3 ? 3 / lum2 : 1;
    out[0] = lr * cs; out[1] = lg * cs; out[2] = lb * cs;
    _shineDbgSmp[0] = _shineSmp.x; _shineDbgSmp[1] = _shineSmp.y; _shineDbgSmp[2] = _shineSmp.z;
    _shineDbgSun[0] = _shineSunDir.x; _shineDbgSun[1] = _shineSunDir.y; _shineDbgSun[2] = _shineSunDir.z;
    shineDebug.lam = lamSum / 5;
    return true;
  }
  const _shineDir = new THREE.Vector3();
  const _shineCol = new THREE.Vector3();
  const _shineTint = [1, 1, 1];
  const _shineDbgCraft = [0, 0, 0], _shineDbgSmp = [0, 0, 0], _shineDbgSun = [0, 0, 0];
  const shineDebug = {
    body: null, tint: null, i: 0, dKm: 0, alphaDeg: 0,
    resI: 0, resF: 1,   // item 7 暗面残差：强度与掩食因子（无残差时 resI=0/resF=1）
    craft: _shineDbgCraft, smp: _shineDbgSmp, sunL: _shineDbgSun, lam: 0,
  };   // 调试探针（CassiniScene.shineDebug）；craft/smp/sunL 为复用缓冲，仅即时读取
  /* 逐天体取贡献最大的反照光天体（对给定飞船位置解算；分离后轨道器与
   * 探测器位置可差数万 km——Titan 进入日 ~6×10⁴ km，同一解算只对解算位置
   * 正确——轨道器/探测器各自调用一次）。返回 null 表示无有效贡献。 */
  function solveShine(world) {
    let best = 0, bestName = null, bestEntry = null, bk = 0, bdx = 0, bdy = 0, bdz = 0, bw = 0,
        bdKm = 0, bAlpha = 0;
    for (const [name, e] of registry) {
      if (name === '__sunLight' || name === 'sun' || !e.radius) continue;
      const dx = e.world[0] - world[0],
            dy = e.world[1] - world[1],
            dz = e.world[2] - world[2];
      const d = Math.hypot(dx, dy, dz);
      if (d <= e.radius) continue;            // 已撞入行星本体（掩食因子已归零）
      const ratio = e.radius / d;
      // 行星侧相位角 α（日-行星-飞船）：dx·e.world = (行星→飞船)·(行星→太阳)，
      // 日心系太阳在原点。α→0 飞船在向日面上空见全相 k→1；α→180° 行星位于
      // 飞船与太阳之间只见夜面 k→0，与 eclipseFactor 本影判定自洽
      const cosA = Math.max(-1, Math.min(1,
        (dx * e.world[0] + dy * e.world[1] + dz * e.world[2]) /
        (d * (Math.hypot(e.world[0], e.world[1], e.world[2]) || 1))));
      const k = 0.5 * (1 + cosA);
      const c = (SHINE_ALBEDO[name] || 0.4) * ratio * ratio * k;
      if (c > best) {
        best = c; bestName = name; bestEntry = e; bk = k; bw = ratio; bdKm = d; bAlpha = cosA;
        bdx = dx / d; bdy = dy / d; bdz = dz / d;   // 飞船→行星单位向量
      }
    }
    if (best <= 1e-4) return null;
    return { name: bestName, entry: bestEntry, i: best, k: bk, w: bw,
             dKm: bdKm, cosA: bAlpha, dx: bdx, dy: bdy, dz: bdz };
  }

  /* 解算结果 → 视图空间方向/颜色；最终色调写入 outTint（调试探针读取） */
  function applyShine(s, outDir, outCol, outTint) {
    let tint = SHINE_TINT[s.name] || [1, 1, 1];
    if (sampleShineTint(s.entry, s.k, s.dx, s.dy, s.dz, outTint)) tint = outTint;
    outTint[0] = tint[0]; outTint[1] = tint[1]; outTint[2] = tint[2];
    const I = SUN_INTENSITY * s.i;
    outDir.set(s.dx, s.dy, s.dz).applyQuaternion(_camQInv);
    outCol.set(tint[0] * I, tint[1] * I, tint[2] * I);
  }

  /* —— item 7 暗面土照：本影内残差反照光解算 ——
   * 取 SHINE_ECL 系数天体中 α_g·(R/d)² 最大者（不乘相位 k——残差的光源是
   * 环面/大气边缘而非行星盘亮面，本影内 k≈0 正是它要补的场景），量级再乘
   * (1−f)：f=1（无食）严格归零，全食 f=0 取满。方向与行星反照光同向（朝
   * 行星中心——环/大气边缘光源围绕行星中心分布，一阶近似取质心方向）。 */
  function solveEclResidual(world, f) {
    if (f === undefined || f >= 1) return null;
    let best = 0, bestName = null, bestE = null, bdKm = 0, bcosA = 0;
    for (const [name, e] of registry) {
      if (!SHINE_ECL[name] || !e.radius) continue;
      const dx = e.world[0] - world[0],
            dy = e.world[1] - world[1],
            dz = e.world[2] - world[2];
      const d = Math.hypot(dx, dy, dz);
      if (d <= e.radius) continue;            // 已撞入行星本体
      const ratio = e.radius / d;
      const c = (SHINE_ALBEDO[name] || 0.4) * ratio * ratio * SHINE_ECL[name];
      if (c > best) {
        best = c; bestName = name; bestE = e; bdKm = d;
        bcosA = Math.max(-1, Math.min(1,
          (dx * e.world[0] + dy * e.world[1] + dz * e.world[2]) /
          (d * (Math.hypot(e.world[0], e.world[1], e.world[2]) || 1))));
      }
    }
    if (!bestE || best <= 1e-5) return null;
    return { name: bestName, entry: bestE, dKm: bdKm, w: bestE.radius / bdKm,
             cosA: bcosA, iRes: best * (1 - f),
             dx: (bestE.world[0] - world[0]) / bdKm,
             dy: (bestE.world[1] - world[1]) / bdKm,
             dz: (bestE.world[2] - world[2]) / bdKm };
  }
  /* 残差 → 颜色累加（方向仅在既有反照光缺失时才写入 outDir——两者指向同一天体）。
   * 返回 1 表示有残差（着色端 uShineRes 置 1 启用暗面补项）。 */
  function applyEclResidual(s, outDir, outCol, haveDir) {
    if (!haveDir) outDir.set(s.dx, s.dy, s.dz).applyQuaternion(_camQInv);
    const tint = SHINE_ECL_TINT[s.name] || [1, 1, 1];
    const I = SUN_INTENSITY * s.iRes;
    outCol.x += tint[0] * I; outCol.y += tint[1] * I; outCol.z += tint[2] * I;
    return 1;
  }

  const _shineDirH = new THREE.Vector3();
  const _shineColH = new THREE.Vector3();
  const _shineTintH = [1, 1, 1];
  function updatePlanetShine(hw, fC, fH) {
    // 探测器（hw = 分离后惠更斯位置，未分离为 null）先解算：shineDebug 探针
    // 缓冲（smp/sunL/lam 在 sampleShineTint 内复用）随后被 Cassini 解算覆写，
    // 调试语义保持卡西尼视角。item 7：各实体独立解算本影残差补项（fC/fH），
    // 有残差时 uShineRes 置 1 启用着色端暗面补项
    const h = hw ? solveShine(hw) : null;
    const hr = hw ? solveEclResidual(hw, fH) : null;
    if (h || hr) {
      if (h) {
        applyShine(h, _shineDirH, _shineColH, _shineTintH);
      } else {
        _shineColH.set(0, 0, 0);
      }
      const rh = hr ? applyEclResidual(hr, _shineDirH, _shineColH, !!h) : 0;
      window.CassiniModel.setProbeShine(_shineDirH, _shineColH, h ? h.w : hr.w, rh);
    } else {
      window.CassiniModel.setProbeShine(null, null, 0);
    }
    const s = solveShine(_cassWorld);
    const sr = solveEclResidual(_cassWorld, fC);
    if (s || sr) {
      if (s) {
        applyShine(s, _shineDir, _shineCol, _shineTint);
        shineDebug.body = s.name;
        shineDebug.tint = [_shineTint[0], _shineTint[1], _shineTint[2]];
        shineDebug.i = s.i;
        shineDebug.dKm = Math.round(s.dKm);
        shineDebug.alphaDeg = +(Math.acos(Math.max(-1, Math.min(1, s.cosA))) * 180 / Math.PI).toFixed(1);
      } else {
        // 全食反照光熄灭、仅剩残差：调试面板显示残差解算结果
        _shineCol.set(0, 0, 0);
        shineDebug.body = sr.name;
        const tint = SHINE_ECL_TINT[sr.name] || [1, 1, 1];
        shineDebug.tint = [tint[0], tint[1], tint[2]];
        shineDebug.i = sr.iRes;
        shineDebug.dKm = Math.round(sr.dKm);
        shineDebug.alphaDeg = +(Math.acos(Math.max(-1, Math.min(1, sr.cosA))) * 180 / Math.PI).toFixed(1);
      }
      const r = sr ? applyEclResidual(sr, _shineDir, _shineCol, !!s) : 0;
      window.CassiniModel.setShine(_shineDir, _shineCol, s ? s.w : sr.w, r);
      shineDebug.resI = sr ? sr.iRes : 0;
      shineDebug.resF = sr ? fC : 1;
      _shineDbgCraft[0] = _cassWorld[0]; _shineDbgCraft[1] = _cassWorld[1]; _shineDbgCraft[2] = _cassWorld[2];
      shineDebug.craft = _shineDbgCraft;
    } else {
      window.CassiniModel.setShine(null, null, 0);
      shineDebug.body = null; shineDebug.tint = null; shineDebug.i = 0;
      shineDebug.dKm = 0; shineDebug.alphaDeg = 0; shineDebug.craft = null;
      shineDebug.resI = 0; shineDebug.resF = 1;
    }
  }

  /* —— 亮点标记视线遮挡 —— 太阳/Cassini/Huygens 标记 depthTest:false（标记须
   * 盖过自身天体的近侧盘面，深度缓冲无法区分「被自身盘面挡住」与「被前方
   * 行星挡住」），改用 CPU 射线-球体判定：相机→目标连线被任一更近天体
   * （skip = 目标自身，排除自身盘面）的球面截断 → 目标在行星盘面之后，
   * 标记随天体一并隐藏（土星遮挡太阳/飞船时不再显示穿透亮点）。 */
  function viewOccluded(wx, wy, wz, skip) {
    const dx = wx - camWorld.x, dy = wy - camWorld.y, dz = wz - camWorld.z;
    const len2 = dx * dx + dy * dy + dz * dz;
    if (len2 < 1e-12) return false;
    for (const [name, e] of registry) {
      if (name === '__sunLight' || name === skip || !e.radius) continue;
      const a = e.radius;
      // —— 射线-扁椭球判定 ——
      // 沿极轴 n 把整段射线拉伸 k=1/(1−f)（相对体心），椭球即仿射映射为
      // 半径 a 的正球（体心不动、段参数不变）→ 在压缩空间做与旧版完全同构
      // 的「最近点 + 段内」测试。旧版按正球（赤道半径）判定，扁率大的天体
      // （土星 f=0.098、木星 0.065）极区方向的遮挡边界比可见椭球 limb 凸出
      // ~10%，太阳标记贴近上下临边时提前消失——用户报告「上下提前变暗、
      // 左右正常」（2026-10-05）。
      let ox = camWorld.x, oy = camWorld.y, oz = camWorld.z;
      let tx = wx, ty = wy, tz = wz;
      const f = e.flat || 0;
      if (f > 1e-4 && e.polarN) {
        const k1 = f / (1 - f);            // = k − 1
        const n = e.polarN;
        const w0 = e.world;
        let rx = ox - w0[0], ry = oy - w0[1], rz = oz - w0[2];
        const s0 = (rx * n.x + ry * n.y + rz * n.z) * k1;
        rx += s0 * n.x; ry += s0 * n.y; rz += s0 * n.z;
        let px = tx - w0[0], py = ty - w0[1], pz = tz - w0[2];
        const s1 = (px * n.x + py * n.y + pz * n.z) * k1;
        px += s1 * n.x; py += s1 * n.y; pz += s1 * n.z;
        ox = w0[0] + rx; oy = w0[1] + ry; oz = w0[2] + rz;
        tx = w0[0] + px; ty = w0[1] + py; tz = w0[2] + pz;
      }
      const ddx = tx - ox, ddy = ty - oy, ddz = tz - oz;
      const L2 = ddx * ddx + ddy * ddy + ddz * ddz;
      if (L2 < 1e-12) continue;
      const s = ((e.world[0] - ox) * ddx + (e.world[1] - oy) * ddy + (e.world[2] - oz) * ddz) / L2;
      if (s <= 0 || s >= 1) continue;                   // 遮挡体须位于相机与目标之间
      const cx = ox + ddx * s - e.world[0],
            cy = oy + ddy * s - e.world[1],
            cz = oz + ddz * s - e.world[2];
      if (cx * cx + cy * cy + cz * cz < a * a) return true;
    }
    return false;
  }

  /* —— 飞船实体对无深度测试标记的遮挡 ——
   * 太阳迷你标记 depthTest:false（须盖过日面自身深度，否则标记被日盘前半
   * 球吞掉），代价是深度缓冲里的一切都挡不住它——Cassini 轨道器 / Huygens
   * 探测器模型恰在相机与太阳之间时会透过船体显形（背光特写尤其刺眼）。
   * 按「相机→天体射线穿过飞船包围球」解析补测，与 viewOccluded 同一套射
   * 线-球体几何；仅在 3D 模型实际渲染时生效——远观只剩亮点标记时，亮点互
   * 叠由 renderOrder 定层级（Cassini 标记更上），太阳标记不熄灭避免闪烁。 */
  const CASSINI_OCCL_R = MODEL_SPAN / 2;   // 9 m：全尺寸跨距（磁强计双杆）之半
  const HUYGENS_OCCL_R = 0.0016;           // 1.6 m：φ2.62 m 探测器 + 余量
  function craftOccluded(wx, wy, wz) {
    const dx = wx - camWorld.x, dy = wy - camWorld.y, dz = wz - camWorld.z;
    const len2 = dx * dx + dy * dy + dz * dz;
    if (len2 < 1e-20) return false;
    const hw = window.HuygensVis && window.HuygensVis.getWorld();
    for (let i = 0; i < 2; i++) {
      const p = i === 0 ? _cassWorld : hw;
      if (!p) continue;
      const shown = i === 0
        ? cassiniModel.visible
        : !!(huygensMesh && huygensMesh.visible);
      if (!shown) continue;
      const r = i === 0 ? CASSINI_OCCL_R : HUYGENS_OCCL_R;
      const bx = p[0] - camWorld.x, by = p[1] - camWorld.y, bz = p[2] - camWorld.z;
      const t = (bx * dx + by * dy + bz * dz) / len2;   // 射线参数：0=相机 1=目标
      if (t <= 0 || t >= 1) continue;                   // 遮挡体须位于相机与目标之间
      const cx = bx - dx * t, cy = by - dy * t, cz = bz - dz * t;
      if (cx * cx + cy * cy + cz * cz < r * r) return true;
    }
    return false;
  }

  /* —— Cassini 真实姿态回放（NASA 官方数据驱动）——
   * 数据: NASA Eyes on the Solar System dynamo sc_cassini/quat（NAIF SPICE CK
   *   定轨姿态的烘焙产物），覆盖 1997-10-15 发射 → 2017-09-15 任务终段；由
   *   tools/fetch_attitude.py 下载、tools/bake_attitude.py 转换为场景系四元数
   *   (window.CASSINI_ATT)：Q_scene(t) = A ⊗ q(t) ⊗ M ⊗ Q_GLB⁻¹（坐标链见该
   *   脚本头注释，滚动自由度与 Eyes 渲染一致）。
   * 覆盖内逐样本 slerp 回放；HUD 姿态标签按真实 HGA(+Z) 指向实时分类。
   * 覆盖外（数据止于 2017-09-15 10:33Z，其后的坠入大气段等）退回任务记录
   * 启发式：HGA(+Z) 默认对地通信（Earth 方向，实时由历表求解），三个有据可
   * 查的例外：
   *  1. SOI 防护/点火（2004-07-01）：穿越环面前 ~1 h 起 HGA 转向前方（行进方向）
   *     作防尘盾，保持到 96 分钟点火结束（02:48 UTC），期间与地球失联（JPL
   *     mission status report；穿越时刻由轨迹数据在土星赤道面内的法向坐标
   *     过零解算）；
   *  2. Huygens 中继（2005-01-14）：下降全程 HGA 指向 Titan 接收探测器遥测，
   *     结束后转回 Earth 回放数据（ESA Huygens descent timeline；起止取进入
   *     前 ~4 h / 着陆后 ~3 h 近似）；
   *  3. Grand Finale 环缝俯冲（2017-04-26 起共 22 次）：穿越前后 HGA 指向行进
   *     方向（"HGA to RAM" 防护姿态；首次俯冲按 NASA 记录为边缘对准、不用盾）。
   * 终段再入保持对地直至烧毁（无例外）。当前状态名经
   * window.CassiniScene.attitudeState 供 HUD 显示；姿态逐帧直接跟随数据，
   * 不做过渡动画（跳转/变速时朝向即时切换）。 */
  const Z_AXIS = new THREE.Vector3(0, 0, 1);
  const _attV = new THREE.Vector3();
  const _attQ = new THREE.Quaternion();
  const _satN = (() => {   // 土星赤道面法线（three 系，与 TILT.saturn 同一定向）
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(TILT.saturn[0]),
      THREE.MathUtils.degToRad(TILT.saturn[1] || 0), 0, 'YXZ'));
    return new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
  })();
  const ET_UTC = (utc) => (Date.parse(utc) - J2000Ms) / 1000;
  const ATT_SOI_END = ET_UTC('2004-07-01T02:48:00Z') + 600;
  const ATT_SOI_BURN0 = ET_UTC('2004-07-01T01:12:00Z');
  const ATT_RELAY0 = ET_UTC('2005-01-14T05:06:00Z');
  const ATT_RELAY1 = ET_UTC('2005-01-14T14:38:00Z');
  const ATT_RAM_HALF = 2100;   // finale 穿越防护窗口半宽（±35 min）
  const ATT_LBL = {
    earth: '对地通信 · HGA→Earth',
    ram: '防护姿态 · HGA→前向（防尘盾）',
    burn: 'SOI 点火 · HGA→前向（防尘盾）',
    titan: '中继惠更斯 · HGA→Titan',
    free: '真实姿态 · 科学观测定向',
  };

  /* —— 真实姿态数据（window.CASSINI_ATT，tools/bake_attitude.py 烘焙）—— */
  let attT = null, attQ4 = null;    // ET 秒序列 + 场景系四元数 (x,y,z,w) 序列
  let attIdx = 0;                   // 顺序回放缓存
  if (window.CASSINI_ATT) {
    attT = b64ToFloat64(window.CASSINI_ATT.t);
    attQ4 = b64ToFloat32(window.CASSINI_ATT.q);
  }
  const _attQa = new THREE.Quaternion();
  const _attQb = new THREE.Quaternion();
  const _hgaV = new THREE.Vector3();
  const _clsV = new THREE.Vector3();
  const ATT_CLASS_TOL = 4 * Math.PI / 180;   // HUD 分类阈值

  /* 覆盖内将 out 置为 t 时刻真实姿态（相邻样本 slerp）并返回 out，否则 null */
  function attQuatAt(t, out) {
    if (!attT || t < attT[0] || t > attT[attT.length - 1]) return null;
    let i = attIdx;
    if (i >= attT.length - 1 || attT[i] > t || attT[i + 1] < t) {
      let lo = 0, hi = attT.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (attT[mid] <= t) lo = mid; else hi = mid;
      }
      i = lo;
    }
    attIdx = i;
    const span = attT[i + 1] - attT[i];
    const u = span > 0 ? (t - attT[i]) / span : 0;
    const g = i * 4;
    _attQa.set(attQ4[g], attQ4[g + 1], attQ4[g + 2], attQ4[g + 3]);
    _attQb.set(attQ4[g + 4], attQ4[g + 5], attQ4[g + 6], attQ4[g + 7]);
    return out.copy(_attQa).slerp(_attQb, THREE.MathUtils.clamp(u, 0, 1));
  }

  /* HUD 姿态标签：由真实 HGA(+Z) 指向分类（点火窗口优先标注更具体） */
  function classifyAttitude(t, cassWorld) {
    if (t >= ATT_SOI_BURN0 && t <= ATT_SOI_END) return 'burn';
    _hgaV.set(0, 0, 1).applyQuaternion(_attQ);
    const ti = registry.get('titan');
    if (ti) {
      _clsV.set(ti.world[0] - cassWorld[0], ti.world[1] - cassWorld[1], ti.world[2] - cassWorld[2]);
      if (_hgaV.angleTo(_clsV) < ATT_CLASS_TOL) return 'titan';
    }
    const a = [0, 0, 0], b = [0, 0, 0];
    cassiniPosAt(Math.max(trailT[0], t - 90), a);
    cassiniPosAt(Math.min(trailT[trailN - 1], t + 90), b);
    _clsV.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (_hgaV.angleTo(_clsV) < ATT_CLASS_TOL) return 'ram';
    const e = registry.get('earth');
    if (e) {
      _clsV.set(e.world[0] - cassWorld[0], e.world[1] - cassWorld[1], e.world[2] - cassWorld[2]);
      if (_hgaV.angleTo(_clsV) < ATT_CLASS_TOL) return 'earth';
    }
    return 'free';
  }

  let attScanDone = false;
  let attSoiCross = null;       // SOI 点火中的环面穿越时刻
  let attFinaleCrossings = [];  // finale 环缝穿越 [{t, r}]（[0] = 首次俯冲，边缘对准）
  let attMode = 'earth';

  const _attScanC = [0, 0, 0];
  const _attScanS = [0, 0, 0];

  /* 环面过零扫描（一次性）：轨迹点相对土星位置在赤道面法向上的坐标过零 →
   * 穿越时刻 + 穿越半径。finale 俯冲的穿越半径在主环内缘（74,500 km）以内。
   * 终段再入（2017-09-15）的坠入轨迹也会在大气内（r ≈ 60,160 km < 行星半径）
   * 穿越赤道面一次，但它不是环缝俯冲：穿越后轨迹（任务）随即终结，防护窗口
   * 结束前已无轨迹数据——过滤掉，再入段 HGA 保持对地直至烧毁（无例外）。 */
  function scanRingCrossings() {
    attScanDone = true;
    const sat = registry.get('saturn');
    if (!sat || !sat.track) return;
    const n = _satN;
    const tFin0 = ET_UTC('2017-04-22T00:00:00Z');
    const tSoiLo = ET_UTC('2004-06-30T00:00:00Z');
    const tSoiHi = ET_UTC('2004-07-02T00:00:00Z');
    const tSoiRef = ET_UTC('2004-07-01T02:00:00Z');
    const found = [];
    let zPrev = 0;
    for (let i = 0; i < trailN; i++) {
      sat.track.at(trailT[i], tmpV);          // 黄道系
      const sx = tmpV[0], sy = tmpV[2], sz = -tmpV[1];   // ecl → three
      const g = i * 3;
      const z = (trailThree[g] - sx) * n.x +
                (trailThree[g + 1] - sy) * n.y +
                (trailThree[g + 2] - sz) * n.z;
      if (i > 0 && (z < 0) !== (zPrev < 0)) {
        const tt = trailT[i - 1] + (trailT[i] - trailT[i - 1]) * (zPrev / (zPrev - z));
        cassiniPosAt(tt, _attScanC);          // three 系
        sat.track.at(tt, _attScanS);          // 黄道系 → three
        const rx = _attScanC[0] - _attScanS[0];
        const ry = _attScanC[1] - _attScanS[2];
        const rz = _attScanC[2] + _attScanS[1];
        const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
        found.push({ t: tt, r });
      }
      zPrev = z;
    }
    let best = null, bd = Infinity;
    for (const c of found) {
      if (c.t < tSoiLo || c.t > tSoiHi) continue;
      const d = Math.abs(c.t - tSoiRef);
      if (d < bd) { bd = d; best = c.t; }
    }
    attSoiCross = best;
    // 防护窗口（±35 min）要求航天器穿越后继续飞行：终段再入的赤道面穿越
    // 在窗口结束前轨迹已终结（大气内坠毁），排除之，避免覆盖对地姿态
    attFinaleCrossings = found.filter(c =>
      c.t >= tFin0 && c.r < 74500 && c.t + ATT_RAM_HALF < trailT[trailN - 1]);
  }

  /* t 时刻的姿态目标：attMode/ATT_LBL 标签；_attV 填入 HGA(+Z) 目标方向（未归一） */
  function attitudeTarget(t, cassWorld) {
    if (!attScanDone) scanRingCrossings();
    // 1) SOI 防护/点火（穿越前 ~1 h → 点火结束）
    const soi0 = (attSoiCross !== null ? attSoiCross : ET_UTC('2004-07-01T01:08:00Z')) - 3600;
    if (t >= soi0 && t <= ATT_SOI_END) {
      const a = [0, 0, 0], b = [0, 0, 0];
      cassiniPosAt(Math.max(trailT[0], t - 60), a);
      cassiniPosAt(Math.min(trailT[trailN - 1], t + 60), b);
      _attV.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      attMode = t >= ATT_SOI_BURN0 ? 'burn' : 'ram';
      return;
    }
    // 2) Huygens 中继
    if (t >= ATT_RELAY0 && t <= ATT_RELAY1) {
      const ti = registry.get('titan');
      if (ti) {
        _attV.set(ti.world[0] - cassWorld[0], ti.world[1] - cassWorld[1], ti.world[2] - cassWorld[2]);
        attMode = 'titan';
        return;
      }
    }
    // 3) Grand Finale 环缝穿越防护（[0] = 首次俯冲，边缘对准不用盾）
    for (let i = 1; i < attFinaleCrossings.length; i++) {
      const c = attFinaleCrossings[i].t;
      if (Math.abs(t - c) <= ATT_RAM_HALF) {
        const a = [0, 0, 0], b = [0, 0, 0];
        cassiniPosAt(Math.max(trailT[0], t - 60), a);
        cassiniPosAt(Math.min(trailT[trailN - 1], t + 60), b);
        _attV.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        attMode = 'ram';
        return;
      }
      if (c > t + ATT_RAM_HALF) break;
    }
    // 默认：对地通信
    const e = registry.get('earth');
    let dx = 0, dy = 0, dz = 1;
    if (e) {
      dx = e.world[0] - cassWorld[0];
      dy = e.world[1] - cassWorld[1];
      dz = e.world[2] - cassWorld[2];
    }
    if (Math.hypot(dx, dy, dz) < 1) { dx = -cassWorld[0]; dy = -cassWorld[1]; dz = -cassWorld[2]; }
    _attV.set(dx, dy, dz);
    attMode = 'earth';
  }

  function updateCassiniAttitude(cassWorld, t) {
    if (!attQuatAt(t, _attQ)) {
      // 数据覆盖外：任务记录启发式兜底（HGA 对地 + 三处例外窗口）
      attitudeTarget(t, cassWorld);
      if (_attV.lengthSq() < 1e-18) _attV.set(0, 0, 1); else _attV.normalize();
      _attQ.setFromUnitVectors(Z_AXIS, _attV);
    } else {
      attMode = classifyAttitude(t, cassWorld);
    }
    cassiniModel.quaternion.copy(_attQ);
  }

  /* SOI 相对轨迹逐帧更新（item 2/3 两级参考系）：
     - 一级（行星 SOI：Venus/Earth/Jupiter/Saturn）：Cassini 进入 → 相对轨迹淡入，
       绝对（日心）轨迹同步降低亮度；离开 → 相对轨迹淡出、绝对轨迹恢复亮度。
     - 二级（卫星 SOI：Titan/Enceladus/…，仅 Saturn SOI 内存在）：进入卫星 SOI →
       绝对轨迹再降亮度、一级相对轨迹降亮度、二级相对轨迹淡入。
     亮度联动（对 opacity 乘子，逐帧平滑跟随 k 值，无突变）：
       absDim = (1−0.30·k1)·(1−0.25·k2)，一级 ×(1−0.45·k2)，二级 = k2；
       窗口激活时绝对轨迹再乘 (1−0.45·k1)。所有层压暗但不隐藏——绝对轨迹
       与相对轨迹分属两个参考系，仅在飞船实际位置处相交，两者共存呈现。
     cassini 总开关关闭时隐藏全部相对轨迹（soiState 仍用于 HUD 相对速度显示）。 */
  const ABS_DIM1 = 0.30, ABS_DIM2 = 0.25, REL_DIM2 = 0.45, ABS_DIM_WIN = 0.45;
  function updateSoiTrails(t) {
    const tfade = 1 - modelFade;   // 模型级特写时航天器轨迹整体淡出（含相对轨迹）
    let bestName = null, bestK = 0;
    let bestMoon = null, bestMK = 0;
    const showRel = trailOptions.cassini;
    const kOf = _kOf;
    kOf.clear();
    for (const [name, sp] of soiPlanets) {
      const entry = sp.entry;
      const dCass = Math.hypot(
        _cassWorld[0] - entry.world[0],
        _cassWorld[1] - entry.world[1],
        _cassWorld[2] - entry.world[2]);
      const showR = SOI_SHOW[name] || 5e6;
      // 进入半径即开始淡入，0.6R 处全亮（真实 SOI 较小，保证飞掠全程清晰可见）
      let k = THREE.MathUtils.clamp((showR - dCass) / (showR * 0.4), 0, 1);
      k = k * k * (3 - 2 * k);
      kOf.set(name, k);
      if (entry.parent) {
        if (k > bestMK) { bestMK = k; bestMoon = name; }
      } else if (k > bestK) {
        bestK = k; bestName = name;
      }
    }
    const absDim = (1 - ABS_DIM1 * bestK) * (1 - ABS_DIM2 * bestMK);
    const idxNow = trailIndexAt(t);
    for (const [name, sp] of soiPlanets) {
      const entry = sp.entry;
      const k = kOf.get(name) || 0;
      const isMoon = !!entry.parent;
      // 二级轨迹只在其窗口存在（真实 SOI 穿越），一级窗口覆盖整个 SOI 区间
      const lvlDim = isMoon ? 1 : (1 - REL_DIM2 * bestMK);
      const win = showRel && k > 0.001 ? soiWindowAt(sp, t) : null;
      for (const w of sp.wins) {
        if (!win || w !== win || tfade <= 0.01) { w.full.visible = false; w.flown.visible = false; continue; }
        // —— 缓冲一次性构建（不含相机量 → 永不重建）；每帧对象位置在 f64 中精确给出
        //    渲染位置 ≡ 锚定体当前 + rel0 + buf − camWorld = 锚定体当前 + rel_i − cam ——
        if (!w.built) buildSoiWindow(w);
        w.full.visible = trailOptions.future;
        w.flown.visible = true;
        const wx = entry.world[0], wy = entry.world[1], wz = entry.world[2];
        const rel0 = w.rel0;   // 旧数据回退路径 rel 未去锚：rel0 为 null → 用 0
        const bx = rel0 ? rel0[0] : 0, by = rel0 ? rel0[1] : 0, bz = rel0 ? rel0[2] : 0;
        w.full.position.set(
          wx + bx - camWorld.x,
          wy + by - camWorld.y,
          wz + bz - camWorld.z);
        w.flown.position.copy(w.full.position);
        w.full.material.opacity = 0.30 * k * lvlDim * tfade;
        w.flown.material.opacity = 0.9 * k * lvlDim * tfade;
        // 动态尾迹与所属窗口线同步（该体为当前层级的最佳匹配体时）
        if (name === bestName) tailPlanet.material.opacity = w.flown.material.opacity;
        if (name === bestMoon) tailMoon.material.opacity = w.flown.material.opacity;
        // 当前时刻在窗口顶点区间内的相对索引
        const rel = Math.min(Math.max(idxNow - w.i0, 0), w.n - 1);
        let wStart = 0;
        if (trailOptions.mode === 'recent') {
          const ts = w.times;
          let lo = 0, hi = w.n - 1;
          if (t - RECENT_SPAN <= ts[0]) lo = 0;
          else if (t - RECENT_SPAN >= ts[hi]) lo = hi;
          else { while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= t - RECENT_SPAN) lo = m; else hi = m; } }
          wStart = lo;
        }
        // flown 修剪到动态尾迹衔接点（idxTail 对应的窗口内索引）：其后的末端弦
        // 由相对系尾迹按真实路径绘制，衔接点与窗口线逐位重合
        const relTail = Math.min(Math.max(tailIdxTail - w.i0, -1), rel);
        const flownWinCount = relTail + 1 - wStart;
        w.flown.geometry.setDrawRange(wStart, Math.max(0, flownWinCount));
        w.flown.visible = flownWinCount >= 2;
        if (trailOptions.future) {
          // 首弦 [rel → rel+1] 由尾迹延伸段接管，future 线从 rel+1 起画
          w.full.geometry.setDrawRange(rel + 1, Math.max(0, w.n - (rel + 1)));
        }
        // 相对轨迹顶点少，逐帧刷新颜色（近期淡出跟随回放，无 600s 缓存迟滞）
        applyTrailFade(w.flown, w.times, t, [1.0, 0.827, 0.498], relTail + 1, wStart, true);
      }
    }
    // 绝对（日心）轨迹亮度：进入行星 SOI 降 45%，再进入卫星 SOI 再降 35%
    trailFullLine.material.opacity = 0.34 * absDim * tfade;
    trailFlownLine.material.opacity = 0.95 * absDim * tfade;
    tailAbs.material.opacity = 0.95 * absDim * tfade;
    soiState.name = bestK > 0.02 ? bestName : null;
    soiState.k = bestK;
    soiState.moon = bestMK > 0.02 ? bestMoon : null;
    soiState.k2 = bestMK;

    /* —— 活动行星窗口：绝对轨迹再压暗（不隐藏）——
     * 相对轨迹（行星锚定、剪切到行星当前帧）与绝对（日心）轨迹是两个参考系，
     * 仅在实际位置处相交；长窗口（地球发射逃逸 58.5 h）内两者随行星运动剪切
     * 分离达数千 km，属物理事实而非渲染缺陷。语义为 NASA Eyes 式分层呈现：
     * 进入 SOI → 相对轨迹淡入为主呈现，绝对轨迹持续可见但逐层压暗——
     * absDim（基础 30%+25% 层级）之外，窗口激活时再乘 (1−0.45·k)（k→1 时
     * 合成亮度约 0.37，主次分明且轨迹始终清晰可见）；k→0 平滑回补，无突跳。
     * 此前一版曾将窗口时间域内的日心轨迹按 drawRange 完全让位给相对轨迹，
     * 用户反馈绝对轨迹「被删除」——已回退为纯亮度分层。 */
    let actWin = null;
    if (showRel && bestName && bestK > 0.001) {
      const spBest = soiPlanets.get(bestName);
      actWin = spBest ? soiWindowAt(spBest, t) : null;
    }
    soiState.win = actWin || null;
    if (actWin) {
      const dimWin = 1 - ABS_DIM_WIN * bestK;
      trailFullLine.material.opacity *= dimWin;
      trailFlownLine.material.opacity *= dimWin;
      tailAbs.material.opacity *= dimWin;
    }
  }

  /* —— 真实光照后处理链（item 1）：场景直绘 + 掩膜太阳 bloom ——
   * 仅真实光照模式启用（效果类改动按约定不入普通模式，普通模式照旧直绘画布）。
   * 链路：
   *   scene → 画布（硬件 MSAA，与普通模式同一条零 RT 开销路径）；
   *   太阳（盘面 + 双层光晕壳，layers 1）单独渲进半分辨率 rtSun →
   *   （掩膜 = 遮挡预通道[层 2 不透明天体纯黑写深度] + 太阳三件套叠绘，
   *   保证 bloom 源与画布可见性一致——行星凌掩时泛光同步消退，
   *   详见 renderPost 步骤 2 注释）
   *   半/四分之一/八分之一 三级「下采样 + 可分离高斯」→ 加色合成回画布。
   *
   * 为什么不再把整帧渲进 HDR RT：实测（WebKit，1080p）rtScene 4×MSAA 使帧率
   * 从直绘 120fps 掉到 60fps——对数深度逐片元写 gl_FragDepth 令 MSAA 退化为
   * 全样本着色，RT 路径又享受不到驱动对默认帧缓冲的优化；且本环境 WebKit 的
   * RT MSAA resolve 存在间歇性产出整块零矩形的缺陷（~150px 方块、位置漂移，
   * 300 帧命中 117 帧；关 MSAA 后 0/80 帧）——即「移动视角黑块闪烁」「太阳
   * 突然变暗」两个目击问题的根因。掩膜方案把 bloom 对象限定为太阳：行星亮度
   * 永不进入模糊链，向阳面不再被泛光洗白（此前的过曝主因）；太阳光晕的过曝
   * 溢出得以保留。全屏额外开销只剩半分辨率太阳绘制 + 三级小尺寸模糊 + 一趟
   * 加色全屏四边形，实测与直绘基本同帧率。
   * rtSun 为 RGBA16F（无浮点渲染扩展时回退 8-bit，>1 值削顶、泛光略弱）；
   * 盘面是内置材质，经顶部 encodings chunk 补丁在 RT 中获得与画布一致的
   * sRGB 值（该补丁现在唯一的作用对象就是这条路径）。 */
  const POST_BLOOM_STR = 0.55; // bloom 叠加强度
  const POST_VS = `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`;
  // 可分离高斯（线性采样 5 tap ≈ 9 tap），uDir = 模糊方向 × 半纹素步长
  const POST_BLUR_FS = `
    uniform sampler2D tex; uniform vec2 uDir;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D( tex, vUv ).rgb * 0.227027;
      vec2 o1 = uDir * 1.3846153846, o2 = uDir * 3.2307692308;
      c += ( texture2D( tex, vUv + o1 ).rgb + texture2D( tex, vUv - o1 ).rgb ) * 0.3162162162;
      c += ( texture2D( tex, vUv + o2 ).rgb + texture2D( tex, vUv - o2 ).rgb ) * 0.0702702703;
      gl_FragColor = vec4( c, 1.0 );
    }`;
  // 下采样：双线性 2×2 盒滤（源纹理本就是模糊后的低频内容，够用）
  const POST_COPY_FS = `
    uniform sampler2D tex; uniform vec2 uTexel;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D( tex, vUv + uTexel * vec2( -0.5, -0.5 ) ).rgb
             + texture2D( tex, vUv + uTexel * vec2(  0.5, -0.5 ) ).rgb
             + texture2D( tex, vUv + uTexel * vec2( -0.5,  0.5 ) ).rgb
             + texture2D( tex, vUv + uTexel * vec2(  0.5,  0.5 ) ).rgb;
      gl_FragColor = vec4( c * 0.25, 1.0 );
    }`;
  // 合成：三级 bloom 加权后**加色**叠回画布（画布上已绘好场景本体，禁用清屏）。
  // 无软肩/无场景采样——>1 值保持原有硬削顶语义，太阳白核外观与 item 1 之前一致
  const POST_COMP_FS = `
    uniform sampler2D b1; uniform sampler2D b2; uniform sampler2D b3;
    uniform float uStr;
    varying vec2 vUv;
    void main() {
      vec3 bloom = texture2D( b1, vUv ).rgb * 0.5
                 + texture2D( b2, vUv ).rgb * 0.3
                 + texture2D( b3, vUv ).rgb * 0.2;
      gl_FragColor = vec4( bloom * uStr, 1.0 );
    }`;

  let post = null;   // 惰性创建（首次真实光照渲染时），null = 未初始化
  const _postSize = new THREE.Vector2();

  function ensurePost() {
    if (post) return;
    const size = renderer.getDrawingBufferSize(_postSize);
    // rtSun 需浮点渲染扩展（RGBA16F 可写）；否则 8-bit 回退
    let hdr = false;
    if (renderer.capabilities.isWebGL2) {
      try { hdr = !!renderer.extensions.get('EXT_color_buffer_float'); } catch (e) { hdr = false; }
    }
    // 一律不开 MSAA：模糊源无需抗锯齿，且 RT MSAA resolve 在 WebKit 下有零块缺陷
    const mkRT = (w, h, depth) => new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      depthBuffer: depth, stencilBuffer: false,
    });
    const w = size.x, h = size.y;
    const P = {
      hdr,
      rtSun: mkRT(w >> 1, h >> 1, true),   // 深度：掩膜期壳已关深度测试（见 renderPost），保留日面自身深度路径
      rtHalfB: mkRT(w >> 1, h >> 1, false),
      rtQuaA: mkRT(w >> 2, h >> 2, false), rtQuaB: mkRT(w >> 2, h >> 2, false),
      rtEigA: mkRT(w >> 3, h >> 3, false), rtEigB: mkRT(w >> 3, h >> 3, false),
      quadScene: new THREE.Scene(),
      quadCam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    };
    P.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    P.quad.frustumCulled = false;
    P.quadScene.add(P.quad);
    const mkMat = (fs, uniforms) => new THREE.ShaderMaterial({
      vertexShader: POST_VS, fragmentShader: fs, uniforms,
      depthTest: false, depthWrite: false,
    });
    P.matBlur = mkMat(POST_BLUR_FS, { tex: { value: null }, uDir: { value: new THREE.Vector2() } });
    P.matCopy = mkMat(POST_COPY_FS, { tex: { value: null }, uTexel: { value: new THREE.Vector2() } });
    P.matComp = mkMat(POST_COMP_FS, {
      b1: { value: null }, b2: { value: null }, b3: { value: null },
      uStr: { value: POST_BLOOM_STR },
    });
    P.matComp.blending = THREE.AdditiveBlending;
    P.matComp.transparent = true;
    // 遮挡预通道材质（层 2 天体 → 纯黑 + 写深度；见 renderPost 步骤 2a）
    P.blackMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    post = P;
  }

  function resizePost() {
    if (!post) return;
    const size = renderer.getDrawingBufferSize(_postSize);
    const w = size.x, h = size.y;
    post.rtSun.setSize(w >> 1, h >> 1);
    post.rtHalfB.setSize(w >> 1, h >> 1);
    post.rtQuaA.setSize(w >> 2, h >> 2); post.rtQuaB.setSize(w >> 2, h >> 2);
    post.rtEigA.setSize(w >> 3, h >> 3); post.rtEigB.setSize(w >> 3, h >> 3);
  }

  /* 一趟全屏四边形 pass：换材质/uniform → 换目标 → 绘制 */
  function postPass(mat, target) {
    post.quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(post.quadScene, post.quadCam);
  }

  function renderPost() {
    ensurePost();
    const P = post;
    // drawing buffer 尺寸漂移兜底（如嵌入式内核改背衬缩放而不派发 resize 事件）
    const size = renderer.getDrawingBufferSize(_postSize);
    if (P.rtSun.width !== (size.x >> 1) || P.rtSun.height !== (size.y >> 1)) resizePost();
    // 1) 场景直绘画布：硬件 MSAA，与普通模式同路径（无 RT、无 resolve 开销）
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    // 2) 太阳掩膜 → 半分辨率 RT，与画布可见性保持一致：
    //    2a) 遮挡预通道：层 2（全部不透明天体）以纯黑材质渲入 rtSun——本趟
    //        renderer.render 的 autoClear 完成清屏（颜色+深度，不依赖手动 clear，
    //        规避 WebKit 的 RT 深度路径缺陷），天体深度留档作遮挡判据；
    //    2b) 太阳三件套（层 1）在 autoClear=false 下叠绘：盘面与光晕壳均开
    //        深度测试 → 被行星凌掩的部分不进 bloom 源（太阳沉入土星 limb 时
    //        泛光随几何同步消退、地球可正常挡住泛光——2026-10-05 用户反馈）。
    //        壳心亮核被日面深度挡掉与画布语义一致；显式清屏后 WebKit 实测
    //        （Playwright WebKit）壳完整渲染，早前的掩膜暗缺陷不再复现。
    camera.layers.set(2);
    scene.overrideMaterial = P.blackMat;
    renderer.setRenderTarget(P.rtSun);
    renderer.render(scene, camera);
    scene.overrideMaterial = null;
    camera.layers.set(1);
    renderer.autoClear = false;
    renderer.render(scene, camera);
    renderer.autoClear = true;
    camera.layers.set(0);
    // 3) 三级「下采样 + H/V 高斯」：半 → 四分之一 → 八分之一，晕径逐级翻倍
    // H/V 往返写回同一张 A 纹（B 仅作中间），三级各自独立
    const blurHV = (a, b, w, h) => {
      P.matBlur.uniforms.tex.value = a.texture;
      P.matBlur.uniforms.uDir.value.set(1.5 / w, 0);
      postPass(P.matBlur, b);
      P.matBlur.uniforms.tex.value = b.texture;
      P.matBlur.uniforms.uDir.value.set(0, 1.5 / h);
      postPass(P.matBlur, a);
    };
    blurHV(P.rtSun, P.rtHalfB, P.rtSun.width, P.rtSun.height);
    P.matCopy.uniforms.tex.value = P.rtSun.texture;
    P.matCopy.uniforms.uTexel.value.set(0.5 / P.rtSun.width, 0.5 / P.rtSun.height);
    postPass(P.matCopy, P.rtQuaA);
    blurHV(P.rtQuaA, P.rtQuaB, P.rtQuaA.width, P.rtQuaA.height);
    P.matCopy.uniforms.tex.value = P.rtQuaA.texture;
    P.matCopy.uniforms.uTexel.value.set(0.5 / P.rtQuaA.width, 0.5 / P.rtQuaA.height);
    postPass(P.matCopy, P.rtEigA);
    blurHV(P.rtEigA, P.rtEigB, P.rtEigA.width, P.rtEigA.height);
    // 4) bloom 加色合成回画布（场景已在步骤 1 绘好，禁清屏避免抹掉场景）
    P.matComp.uniforms.b1.value = P.rtSun.texture;
    P.matComp.uniforms.b2.value = P.rtQuaA.texture;
    P.matComp.uniforms.b3.value = P.rtEigA.texture;
    renderer.autoClear = false;
    postPass(P.matComp, null);
    renderer.autoClear = true;
  }

  function render() {
    // __forceDirect：调试/逃生开关——真实光照下绕过后处理链直接绘原画布
    //（对比 RT 链路与直绘的逐位一致性；亦供低端机出问题时手动关闭后处理）
    if (realisticOn && !window.__forceDirect) { renderPost(); return; }
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  }

  // ---------- labels（item 11：大天体标签上移不遮挡模型 + 遮挡剔除；
  //            Cassini 标签置于下侧，与上侧的天体标签天然分离，重叠时避让） ----------
  const projV = new THREE.Vector3();
  const screenPts = new Map();
  let cassiniLabelEl = null;
  let labelsVisible = true;
  function updateLabels(cassWorld) {
    if (!labelsVisible) {
      for (const entry of registry.values()) {
        if (entry.labelEl) entry.labelEl.classList.add('hide');
      }
      if (cassiniLabelEl) cassiniLabelEl.classList.add('hide');
      screenPts.clear();
      return;
    }
    const w = window.innerWidth, h = window.innerHeight;
    camera.updateMatrixWorld();
    const halfTan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const items = [];
    for (const [name, entry] of registry) {
      if (name === '__sunLight' || !entry.labelEl) continue;
      projV.set(
        entry.world[0] - camWorld.x,
        entry.world[1] - camWorld.y,
        entry.world[2] - camWorld.z,
      );
      const dist = projV.length();
      projV.project(camera);
      if (projV.z > 1 || projV.x < -1.1 || projV.x > 1.1 || projV.y < -1.1 || projV.y > 1.1) {
        entry.labelEl.classList.add('hide');
        screenPts.delete(name);
        continue;
      }
      const x = (projV.x * 0.5 + 0.5) * w;
      const y = (-projV.y * 0.5 + 0.5) * h;
      const rpx = (Math.asin(Math.min(1, entry.radius / Math.max(dist, 1e-9))) / halfTan) * (h / 2);
      // 放大到行星成为屏幕主体（盘面像素半径超过小半屏的 35%）时淡出该天体标签，缩小后恢复；
      // 淡出由 .hide 的透明度过渡完成，仍保留在 items 中继续参与遮挡判定；
      // 隐藏判定带迟滞区间，避免临界缩放处来回闪烁
      const bigR = Math.min(w, h) * 0.35;
      if (entry.zoomHidden ? rpx > bigR * 0.85 : rpx > bigR) {
        entry.zoomHidden = true;
        entry.labelEl.classList.add('hide');
        screenPts.delete(name);
      } else {
        entry.zoomHidden = false;
        screenPts.set(name, [x, y]);
        entry.labelEl.classList.remove('hide');
        entry.labelEl.classList.toggle('dim', dist > 4e9);
      }
      items.push({ name, x, y, dist, rpx, entry });
    }
    // 定位：标签抬高量随盘面像素半径连续增长（smoothstep 过渡），无阈值突变；
    // 并缓存标签像素尺寸（仅首次可见时量取，避免每帧强制重排）
    for (const L of items) {
      let k = THREE.MathUtils.clamp((L.rpx - 6) / 10, 0, 1);
      k = k * k * (3 - 2 * k);
      L.fy = L.y - k * (L.rpx + 10);
      L.entry.labelEl.style.transform = `translate(-50%,-130%) translate(${L.x.toFixed(1)}px,${L.fy.toFixed(1)}px)`;
      const el = L.entry.labelEl;
      if (!el._lw) { el._lw = el.offsetWidth || 0; el._lh = el.offsetHeight || 0; }
      L.w = el._lw; L.h = el._lh;
    }
    // 遮挡：标签锚点落在更近天体的盘面内 → 隐藏（被行星挡住的标签）
    for (const L of items) {
      for (const B of items) {
        if (B === L || B.dist >= L.dist * 0.999) continue;
        if (B.rpx > 6 && Math.hypot(L.x - B.x, L.y - B.y) < B.rpx * 0.92) {
          L.entry.labelEl.classList.add('hide');
          break;
        }
      }
    }
    // 卫星标签紧贴母星标签时避让
    for (const [name, entry] of registry) {
      if (name === '__sunLight' || !entry.labelEl || !entry.parent) continue;
      const mp = screenPts.get(name), pp = screenPts.get(entry.parent);
      if (mp && pp && Math.hypot(mp[0] - pp[0], mp[1] - pp[1]) < 26) {
        entry.labelEl.classList.add('hide');
      }
    }
    // Cassini 标签：置于标记点下侧（天体标签在上侧，二者天然分离）。
    // 锚点被更近行星盘面遮挡、或与可见天体标签矩形重叠时隐藏（天体标签优先保留）。
    if (cassiniLabelEl) {
      projV.set(cassWorld[0] - camWorld.x, cassWorld[1] - camWorld.y, cassWorld[2] - camWorld.z);
      const d = projV.length();
      projV.project(camera);
      if (projV.z > 1 || projV.x < -1.1 || projV.x > 1.1 || projV.y < -1.1 || projV.y > 1.1 || d < 30) {
        cassiniLabelEl.classList.add('hide');
      } else {
        const x = (projV.x * 0.5 + 0.5) * w;
        const y0 = (-projV.y * 0.5 + 0.5) * h;
        const projScale2 = 2 * halfTan;
        const modelPx = MODEL_SPAN / (projScale2 * Math.max(d, 1e-9)) * h;
        let lk = THREE.MathUtils.clamp((modelPx - 14) / 10, 0, 1);
        lk = lk * lk * (3 - 2 * lk);
        const y = y0 + lk * (modelPx * 0.5 + 8);
        let hidden = false;
        for (const B of items) {
          if (B.dist >= d * 0.999) continue;
          if (B.rpx > 6 && Math.hypot(x - B.x, y0 - B.y) < B.rpx * 0.92) { hidden = true; break; }
        }
        if (!hidden) {
          if (!cassiniLabelEl._lw) {
            cassiniLabelEl._lw = cassiniLabelEl.offsetWidth || 0;
            cassiniLabelEl._lh = cassiniLabelEl.offsetHeight || 0;
          }
          if (cassiniLabelEl._lw > 0) {
            const cl = x - cassiniLabelEl._lw / 2;
            const ct = y + cassiniLabelEl._lh * 0.3;
            const cr = cl + cassiniLabelEl._lw, cb = ct + cassiniLabelEl._lh;
            for (const B of items) {
              if (!B.w || B.entry.labelEl.classList.contains('hide')) continue;
              const bl = B.x - B.w / 2, bt = B.fy - B.h * 1.3;
              if (cl < bl + B.w && cr > bl && ct < bt + B.h && cb > bt) { hidden = true; break; }
            }
          }
        }
        if (hidden) {
          cassiniLabelEl.classList.add('hide');
        } else {
          cassiniLabelEl.classList.remove('hide');
          cassiniLabelEl.style.transform = `translate(-50%,30%) translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
        }
      }
    }
  }

  function setCassiniLabel(el) { cassiniLabelEl = el; }

  function setLabelsVisible(on) { labelsVisible = !!on; }

  function screenPosOf(world) {
    camera.updateMatrixWorld();
    projV.set(world[0] - camWorld.x, world[1] - camWorld.y, world[2] - camWorld.z);
    const d = projV.length();
    projV.project(camera);
    return {
      x: (projV.x * 0.5 + 0.5) * window.innerWidth,
      y: (-projV.y * 0.5 + 0.5) * window.innerHeight,
      behind: projV.z > 1,
      dist: d,
    };
  }

  function setTrailOptions(o) {
    Object.assign(trailOptions, o || {});
  }

  window.CassiniScene = {
    init, updatePositions, updateRender, render, updateLabels, screenPosOf, setCassiniLabel,
    setRealisticLighting, setTrailOptions, setLabelsVisible, viewOccluded,
    get registry() { return registry; },
    get camera() { return camera; },
    get scene() { return scene; },
    get trailOptions() { return trailOptions; },
    get SPIN() { return SPIN; },
    get TILT() { return TILT; },
    get soiState() { return soiState; },
    get attitudeState() { return ATT_LBL[attMode] || ATT_LBL.earth; },
    get shineDebug() { return shineDebug; },   // 行星反照光逐帧状态（调试）
    get shineEcl() { return SHINE_ECL; },      // item 7 暗面残差系数（可写，A/B：置 0 关闭）
    get postDebug() { return post; },          // 后处理链状态（调试：hdr/rtSun/uniforms）
    get rendererRef() { return renderer; },    // 调试探针：WebGLRenderer 句柄（program dump）
    get ringOccU() { return ringOccU; },       // 轨迹线解析环遮挡 uniforms（调试/AB 对照）
    get ringOccList() { return ringOccList; },
    setCameraWorld(v) { camWorld.x = v[0]; camWorld.y = v[1]; camWorld.z = v[2]; },
    camWorld,
    cassiniPosAt,
    trailIndexAt,
    trailLength: trailN,
    trailT,                       // 调试探针：轨迹时间表（f64）
    tailIdxTail: () => tailIdxTail,
    J2000Ms,
    bodyNames: BODIES.map(b => b.name),
    // —— 调试探针（只读，不影响渲染）——
    get cassiniMarker() { return cassiniMarker; },
    get cassiniModel() { return cassiniModel; },
    get cassWorld() { return _cassWorld; },
    get trailFullLine() { return trailFullLine; },
    get trailFlownLine() { return trailFlownLine; },
    get trailOrigin() { return trailOrigin; },
    // 调试探针：轨迹顶点世界坐标（three 场景系）；已发生坍塌/平滑，与渲染一致
    trailWorldAt(i) {
      if (!(i >= 0 && i < trailN)) return null;
      return [trailThree[i * 3], trailThree[i * 3 + 1], trailThree[i * 3 + 2]];
    },
    get tailAbs() { return tailAbs; },
    get tailPlanet() { return tailPlanet; },
    get tailMoon() { return tailMoon; },
    get soiPlanets() { return soiPlanets; },
    get registryMap() { return registry; },
  };
})();
