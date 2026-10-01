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
    const segs = segsRaw.map(s => ({
      t0: s.t0, dt: s.dt, n: s.n, xyz: b64ToFloat32(s.d), cr: useCR,
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

  function cassiniPosAt(t, out) {
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
    { name: 'mercury', radius: 2439.7, tex: 'mercury', label: 'Mercury' },
    { name: 'venus', radius: 6051.8, tex: 'venus', label: 'Venus', glow: '#e8d8a8', atmo: { color: 0xe8d8a0, intensity: 0.55, power: 2.6 } },
    { name: 'earth', radius: 6371, tex: 'earth', label: 'Earth', clouds: true, glow: '#6fa8ff', atmo: { color: 0x5f9bff, intensity: 0.9, power: 3.0 } },
    { name: 'mars', radius: 3389.5, tex: 'mars', label: 'Mars', atmo: { color: 0xc08060, intensity: 0.3, power: 3.2 } },
    { name: 'jupiter', radius: 69911, tex: 'jupiter', label: 'Jupiter', glow: '#d8c0a0', rings: true },
    { name: 'saturn', radius: 58232, tex: 'saturn', label: 'Saturn', rings: true, glow: '#e8d8a8' },
    { name: 'uranus', radius: 25362, tex: 'uranus', label: 'Uranus', rings: true },
    { name: 'neptune', radius: 24622, tex: 'neptune', label: 'Neptune', rings: true },
    { name: 'moon', radius: 1737.4, tex: 'moon', label: 'Moon' },
    { name: 'titan', radius: 2574.7, tex: 'proc:titan', label: 'Titan', atmo: { color: 0xd89550, intensity: 0.65, power: 2.4 } },
    { name: 'enceladus', radius: 252.1, tex: 'proc:enceladus', label: 'Enceladus' },
    // Iapetus：NASA Cassini ISS 真实镶嵌（替换有误的程序化贴图）；texOffset 把暗区
    // （Cassini Regio）质心对齐到轨道前导半球——潮汐锁定下本地 +Z 指向 Saturn，
    // 顺行卫星前导方向 = 本地 -X = equirect u 0/1 接缝
    { name: 'iapetus', radius: 734.5, tex: 'iapetus', texOffset: 0.2523, label: 'Iapetus' },
    { name: 'rhea', radius: 763.8, tex: 'proc:rhea', label: 'Rhea' },
    { name: 'dione', radius: 561.4, tex: 'proc:dione', label: 'Dione' },
    { name: 'tethys', radius: 531.1, tex: 'proc:tethys', label: 'Tethys' },
    { name: 'mimas', radius: 198.2, tex: 'proc:mimas', label: 'Mimas' },
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
  let realisticOn = false;   // 真实光照模式（主循环内掩食计算仅在此模式生效）
  // 直射光强度：两种模式恒定 —— 取原真实 3.0 / 普通 1.15 的平均（见 setRealisticLighting）
  const SUN_INTENSITY = 2.075;
  let skyMesh = null;
  let trailFullLine, trailFlownLine;   // heliocentric frame
  let leaderLine;                      // trail end -> current position
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

  function init(canvas, labelsContainer, onLabelClick) {
    labelsEl = labelsContainer;
    renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, logarithmicDepthBuffer: true,
    });
    // 无抗锯齿：原生像素比渲染（上限 2 覆盖绝大多数屏），边缘锐利、填充率开销最小
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

    buildSky();
    buildBodies(onLabelClick);
    buildCassini();
    buildTrail();
    buildSoi();

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  /* realistic lighting mode (shadowed areas fully dark)
   * item 2：普通模式亮面 2.0→1.15（过曝修复）、阴影环境光 0.8→0.05。
   * item 3：环影/环的本影段不再需要按模式改 uniform——环影 shader 在
   * aomap_fragment 只移除直射光：普通模式剩环境光（与背阳面亮度天然一致）、
   * 真实光照模式环境光为 0（阴影全黑）。
   * 亮面两种模式恒定：直射光取原真实 3.0 / 普通 1.15 的平均 2.075，开关只
   * 改变暗面。真实模式额外熄灭飞船模型级补光（HemisphereLight 全局生效，
   * 泄漏到行星暗面）→ 暗面亮度严格为 0；普通模式暗面留环境光 + 补光。 */
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

  function glowTexture(color) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, color + 'cc');
    g.addColorStop(0.35, color + '44');
    g.addColorStop(1, color + '00');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }

  /* 太阳光晕壳层（NASA Eyes 风格）：按“视线到日心的瞄准距离 b”计算径向衰减，
   * 球面几何在任意视距下稳定（无广告牌近裁剪切边），日面圆盘自然遮挡中心亮核。
   * 外壳 BackSide = 盘外晕；内壳 FrontSide + pow 轮廓 = 盘缘增亮。
   * 含 logdepthbuf chunk：与对数深度缓冲的圆盘/行星正确做深度判定。 */
  function sunGlowShellMaterial(opt) {
    const glowLine = opt.rim
      ? 'float g = uI * pow(min(b, 1.6), 8.0);'
      : 'float g = exp(-b * b * uK) * uI;';
    return new THREE.ShaderMaterial({
      uniforms: {
        uR: { value: opt.rSun },
        uK: { value: opt.k },
        uI: { value: opt.intensity },
        uColor: { value: new THREE.Color(opt.color) },
        uFade: { value: 1.0 },
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
        uniform float uR; uniform float uK; uniform float uI; uniform vec3 uColor; uniform float uFade;
        varying vec3 vW; varying vec3 vSunC;
        #include <common>
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          vec3 D = normalize(vW - cameraPosition);
          vec3 oc = vSunC - cameraPosition;
          float tP = dot(oc, D);
          float b = length(oc - D * tP) / uR;   // 瞄准距离（日面半径归一）
          ${glowLine}
          gl_FragColor = vec4(uColor * max(g * uFade, 0.0), 1.0);
        }`,
      side: opt.side,
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
    const tex = texLoader().load(url);
    tex.encoding = THREE.sRGBEncoding;
    if (aniso) tex.anisotropy = aniso;
    return tex;
  }

  /* 大气边缘光（item 5）：菲涅尔边缘光直接注入行星表面材质。
   * 不再使用独立外壳网格——旧外壳是独立 ShaderMaterial 且未含 logdepthbuf
   * chunk，在 logarithmicDepthBuffer 下深度判定与行星表面不一致，会在圆面上
   * 错误叠加出硬边大气罩；并入表面后与表面光照同一管线，昼夜相位天然一致。 */
  function applyAtmoRim(mat, def) {
    mat.userData.atmoU = {
      uAtmoColor: { value: new THREE.Color(def.color) },
      uAtmoIntensity: { value: def.intensity },
      uAtmoPower: { value: def.power },
      uSunDirView: { value: new THREE.Vector3(0, 0, 1) },
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
          '#include <common>\nvarying vec3 vAtmoN;\nvarying vec3 vAtmoV;\nuniform vec3 uAtmoColor;\nuniform vec3 uSunDirView;\nuniform float uAtmoIntensity;\nuniform float uAtmoPower;')
        .replace('#include <dithering_fragment>', `
          #include <dithering_fragment>
          {
            vec3 N = normalize(vAtmoN), V = normalize(vAtmoV);
            float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), uAtmoPower);
            float day = clamp(dot(N, normalize(uSunDirView)) * 1.4 + 0.25, 0.0, 1.0);
            gl_FragColor.rgb += uAtmoColor * (rim * uAtmoIntensity * day);
          }`);
    };
    mat.customProgramCacheKey = () => 'atmo-rim';
  }

  /* —— 气态行星环参数（item 4）——
   * 内外半径（km，真实值）与纹理：土星用 Solar System Scope 烘焙贴图；
   * 木/天/海用程序化径向纹理（js/textures.js），alpha 按真实光深：
   * 木星环尘埃极淡（主环 alpha≈0.28）、天王星窄环炭黑、海王星环极淡
   * （Adams 环带 5 条真实亮弧）。 */
  const RINGS = {
    jupiter: { inner: 92000, outer: 226000, tex: 'proc:ringJupiter' },
    saturn:  { inner: 74500, outer: 140220, tex: 'ring' },
    uranus:  { inner: 37500, outer: 52500, tex: 'proc:ringUranus' },
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
      depthWrite: false, alphaTest: 0.01,
    });
    rm.userData.uniforms = {
      uSunPos: { value: new THREE.Vector3() },
      uPlanetPos: { value: new THREE.Vector3() },
      uPlanetR: { value: def.radius },
    };
    // 行星本影内的环段（item 3）：aomap_fragment 只乘直射光——
    // 普通模式剩环境光（与行星背阳面亮度一致），真实光照模式全黑
    rm.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, rm.userData.uniforms);
      shader.vertexShader = 'varying vec3 vWorldPos;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;');
      shader.fragmentShader = 'uniform vec3 uSunPos;\nuniform vec3 uPlanetPos;\nuniform float uPlanetR;\nvarying vec3 vWorldPos;\n' +
        shader.fragmentShader.replace('#include <aomap_fragment>',
          `#include <aomap_fragment>
          {
            vec3 Ldir = normalize(vWorldPos - uSunPos);
            vec3 toP = uPlanetPos - uSunPos;
            float tP = dot(toP, Ldir);
            float dFrag = length(vWorldPos - uSunPos);
            if (tP > 0.0 && tP < dFrag) {
              float closest = length(toP - Ldir * tP);
              float sh = smoothstep(uPlanetR * 0.97, uPlanetR * 1.06, closest);
              reflectedLight.directDiffuse *= sh;
            }
          }`);
    };
    const ring = new THREE.Mesh(rg, rm);
    ring.rotation.x = Math.PI / 2;
    tiltGroup.add(ring);
    entry.ringMesh = ring;
    entry.ringTexture = rt;
  }

  function buildBodies(onLabelClick) {
    const aniso = renderer.capabilities.getMaxAnisotropy();
    for (const def of BODIES) {
      const entry = {
        name: def.name,
        radius: def.radius,
        label: def.label,
        track: DATA.bodies[def.name] ? makeTrack(DATA.bodies[def.name].segs, DATA.bodies[def.name].interp) : null,
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
        // 贴图本身即目标亮度（亮黄盘面），颜色乘子仅轻微提亮中心
        mat.color.setRGB(1.10, 1.06, 1.0);
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
                  gl_FragColor.rgb += vec3(0.55, 0.46, 0.22) * sunFres;
                }`);
          };
        }
      } else {
        mat = new THREE.MeshLambertMaterial({ map: tex });
        // 大气边缘光并入表面材质（地球/金星/火星/土卫六；不再使用独立大气壳）
        if (def.atmo) {
          applyAtmoRim(mat, def.atmo);
          entry.atmoMat = mat;
        }
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.setScalar(def.radius);
      tiltGroup.add(mesh);

      if (def.clouds) {
        // 独立云层球：真实 NASA 云量贴图（白云 + alpha 通道），与地表贴图分离；
        // 复用表面分段球保证轮廓一致。真实比例：地球云层厚 1–10 km，取云顶
        // 10 km（R⊕=6371 km，仅 +0.16%）；同分段球面平行、法向间距恒定，
        // 对数深度缓冲下不会与地表深度冲突
        const ct = loadTex('earthClouds', aniso);
        const cm = new THREE.MeshLambertMaterial({ map: ct, transparent: true, opacity: 0.9, depthWrite: false });
        const clouds = new THREE.Mesh(geo, cm);
        clouds.scale.setScalar(def.radius + 10);
        tiltGroup.add(clouds);
        entry.clouds = clouds;
      }

      if (def.name === 'sun') {
        // 光晕壳层：按瞄准距离指数衰减，盘外柔光晕贴紧日缘（盘缘增亮在日面材质内做）
        const outer = new THREE.Mesh(
          new THREE.SphereGeometry(1, 48, 24),
          sunGlowShellMaterial({
            rSun: def.radius, k: 0.75, intensity: 1.5, color: 0xfff0be,
            side: THREE.BackSide,
          }));
        outer.scale.setScalar(def.radius * 2.8);
        outer.renderOrder = 1;
        group.add(outer);
        entry.glowShell = outer;
      } else if (def.glow) {
        const gm = new THREE.MeshBasicMaterial({
          map: glowTexture(def.glow),
          transparent: true, depthWrite: false,
          blending: THREE.AdditiveBlending, side: THREE.DoubleSide, opacity: 0.75,
        });
        const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), gm);
        glow.scale.setScalar(def.radius * 4.2);
        glow.renderOrder = 2;
        group.add(glow);
        entry.glow = glow;
      }

      // —— 行星环系统（item 4：木/土/天/海四颗气态行星，真实半径与真实透明度）——
      const rdef = RINGS[def.name];
      if (rdef) buildRingSystem(entry, tiltGroup, def, rdef, aniso);

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
        mat.onBeforeCompile = (shader) => {
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
                        reflectedLight.directDiffuse *= (1.0 - aa * uRingShadowDepth);
                      }
                    }
                  }
                }
              }`);
        };
        mat.userData.shadowU = shU;
      }

      entry.mesh = mesh;
      entry.tiltGroup = tiltGroup;
      entry.group = group;
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
        const om = new THREE.LineBasicMaterial({
          color: isMoon ? 0x5a7096 : 0x46587a, vertexColors: true,
          transparent: true, opacity: isMoon ? 0.58 : 0.72,
        });
        const line = new THREE.LineLoop(og, om);
        line.frustumCulled = false;
        entry.orbitLineObj = line;
        entry.orbitColAttr = orbitColAttr;
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
          scene, registry, eclToThree, cassiniPosAt, markerTexture,
          trailOpts: () => trailOptions,
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
    }));
    trailFullLine.frustumCulled = false;
    scene.add(trailFullLine);
    const gFlown = new THREE.BufferGeometry();
    gFlown.setAttribute('position', sharedAttr);
    const colArr = new Float32Array(trailN * 3);
    gFlown.setAttribute('color', new THREE.BufferAttribute(colArr, 3).setUsage(THREE.DynamicDrawUsage));
    trailFlownLine = new THREE.Line(gFlown, new THREE.LineBasicMaterial({
      color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false,
    }));
    trailFlownLine.frustumCulled = false;
    scene.add(trailFlownLine);

    const gLead = new THREE.BufferGeometry();
    gLead.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage));
    leaderLine = new THREE.Line(gLead, new THREE.LineBasicMaterial({
      color: 0xffd37f, transparent: true, opacity: 0.9, depthWrite: false,
    }));
    leaderLine.frustumCulled = false;
    scene.add(leaderLine);
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
        const i0 = Math.min(idxGte(trailT, a - 1.0), trailN - 2);
        let i1 = idxGte(trailT, b + 1.0) - 1;         // 最后一个 t <= b 的顶点
        i1 = Math.max(i1, i0 + 1);
        const n = i1 - i0 + 1;
        // rel(t_i) = merged(t_i) − 锚定体历表位置（f64，逐位对齐烘焙端口径）
        const rel = new Float64Array(n * 3);
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
        const pos = new Float32Array(n * 3);
        const gFull = new THREE.BufferGeometry();
        gFull.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
        const full = new THREE.Line(gFull, new THREE.LineBasicMaterial({
          color: 0x8fb0d8, transparent: true, opacity: 0, depthWrite: false,
        }));
        full.frustumCulled = false; full.visible = false;
        scene.add(full);
        const gFlown = new THREE.BufferGeometry();
        gFlown.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
        const colAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
        gFlown.setAttribute('color', colAttr);
        const flown = new THREE.Line(gFlown, new THREE.LineBasicMaterial({
          color: 0xffffff, vertexColors: true, transparent: true, opacity: 0, depthWrite: false,
        }));
        flown.frustumCulled = false; flown.visible = false;
        scene.add(flown);
        wins.push({
          a, b, i0, n, times: trailT.subarray(i0, i1 + 1), rel, full, flown, colAttr,
          built: false, o: { x: 0, y: 0, z: 0 }, pRef: { x: 0, y: 0, z: 0 },
        });
      }
      if (wins.length) soiPlanets.set(name, { entry, wins });
    }
  }

  /* 窗口缓冲重建：buf_i = f32(行星参考位置 pRef + rel_i − 原点 o)。
   * 近相机顶点值 ~ 相机距飞船的量级 → f32 亚像素；行星后续移动由对象位置
   * 逐帧补偿（o − cam + planet_now − pRef），无需逐帧重写顶点。 */
  function rebuildSoiWindow(w, entry) {
    const arr = w.full.geometry.attributes.position.array;
    const px = entry.world[0], py = entry.world[1], pz = entry.world[2];
    const ox = camWorld.x, oy = camWorld.y, oz = camWorld.z;
    for (let i = 0; i < w.n; i++) {
      const g = i * 3;
      arr[g] = px + w.rel[g] - ox;
      arr[g + 1] = py + w.rel[g + 1] - oy;
      arr[g + 2] = pz + w.rel[g + 2] - oz;
    }
    // full/flown 两个 BufferAttribute 包裹同一数组但各自持有独立 GPU 缓冲，
    // 必须双双标记上传——否则 flown 永远渲染建窗时的全零缓冲（轨迹不可见）
    w.full.geometry.attributes.position.needsUpdate = true;
    w.flown.geometry.attributes.position.needsUpdate = true;
    w.o.x = ox; w.o.y = oy; w.o.z = oz;
    w.pRef.x = px; w.pRef.y = py; w.pRef.z = pz;
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
    const arr = trailPosBuffer;
    for (let i = 0; i < trailN * 3; i += 3) {
      arr[i] = trailThree[i] - camWorld.x;
      arr[i + 1] = trailThree[i + 1] - camWorld.y;
      arr[i + 2] = trailThree[i + 2] - camWorld.z;
    }
    trailFullLine.geometry.attributes.position.needsUpdate = true;
    trailFlownLine.geometry.attributes.position.needsUpdate = true;
    // SOI 窗口缓冲为行星锚定（planet_ref + rel），其重建由 updateSoiTrails
    // 按"原点漂移 + 行星漂移"触发（见 rebuildSoiWindow / soiWindowBound）
  }

  /* 窗口缓冲重建阈值：与主轨迹同一判据（近处顶点 f32 量化折角 < ~1px）。
   * 行星自身漂移同样计入——相对轨迹锚定在行星当前位置，行星移动即等效
   * 原点漂移。 */
  function soiWindowBound() {
    const dEff = (window.CassiniCamera && window.CassiniCamera.state)
      ? window.CassiniCamera.state.sDist : 4.2e6;
    return Math.min(Math.max(dEff * 2000, 1e3), 5e5);
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
  const soiState = { name: null, k: 0, moon: null, k2: 0 };
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
    _cassWorld = [tmpV[0], tmpV[1], tmpV[2]];
    return { cassWorld: _cassWorld };
  }

  function updateRender(t) {
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
      }
      if (entry.mesh && entry.mesh.material.userData && entry.mesh.material.userData.shadowU) {
        const u = entry.mesh.material.userData.shadowU;
        u.uSunPos.value.set(-camWorld.x, -camWorld.y, -camWorld.z);
        u.uPlanetPos.value.copy(entry.group.position);
      }
    }

    // ---- 大气边缘昼向 uniform（已并入表面材质） ----
    _camQInv.copy(camera.quaternion).invert();
    for (const [name, entry] of registry) {
      if (name === '__sunLight' || !entry.atmoMat) continue;
      // 太阳（原点）→ 天体 方向，转到视图空间
      _sd.set(-entry.world[0], -entry.world[1], -entry.world[2]).applyQuaternion(_camQInv);
      entry.atmoMat.userData.atmoU.uSunDirView.value.copy(_sd);
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
    trailFullLine.visible = cassTrail && trailOptions.future;
    if (trailFullLine.visible) {
      trailFullLine.geometry.setDrawRange(idxNow, Math.max(0, trailN - idxNow));
    }
    trailFlownLine.visible = cassTrail;
    if (cassTrail) {
      const startIdx = trailOptions.mode === 'recent' ? lowerBound(trailT, t - RECENT_SPAN) : 0;
      trailFlownLine.geometry.setDrawRange(startIdx, Math.max(2, idxNow + 1 - startIdx));
      applyTrailFade(trailFlownLine, trailT, t, [1.0, 0.827, 0.498], idxNow + 1, startIdx);
    }

    // ---- SOI 相对行星轨迹（item 3）----
    updateSoiTrails(t);

    // ---- 行星本影掩食（item 6，仅真实光照模式）----
    // 点光不投射阴影 → 卡西尼/惠更斯进入行星本影后仍被照亮；按太阳/行星
    // 视角半径实时解算掩食因子并调制模型材质（0=全食，1=无食）
    if (realisticOn && window.CassiniModel) {
      let fC = eclipseFactor(_cassWorld);
      let fH = fC;
      if (window.HuygensVis) {
        const hw = window.HuygensVis.tryWorldAt(t);
        if (hw) fH = eclipseFactor(hw);
      }
      window.CassiniModel.setEclipse(fC, fH);
    }

    // ---- Cassini marker + model（真实尺寸缩放 + 真实姿态）----
    const cassWorld = _cassWorld;
    cassiniMarker.position.set(cassWorld[0] - camWorld.x, cassWorld[1] - camWorld.y, cassWorld[2] - camWorld.z);
    cassiniModel.position.copy(cassiniMarker.position);
    const dCam = Math.hypot(cassWorld[0] - camWorld.x, cassWorld[1] - camWorld.y, cassWorld[2] - camWorld.z);
    const hPx = window.innerHeight;
    const projScale = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const modelPx = MODEL_SPAN / (projScale * Math.max(dCam, 1e-6)) * hPx;
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
    updateCassiniAttitude(cassWorld, t);
    // 分离（2004-12-25）：组合体 → 轨道器（without-Huygens）；Huygens 独立飞行（js/huygens.js）
    if (cassiniStack && cassiniOrbiter) {
      const sep = t >= HUYGENS_SEP_ET;
      cassiniStack.visible = !sep;
      cassiniOrbiter.visible = sep;
    }
    if (window.HuygensVis) window.HuygensVis.update(t, camWorld, projScale, hPx);

    // 引导线段：轨迹末端 → 当前位置
    leaderLine.geometry.attributes.position.setXYZ(0,
      trailThree[idxNow * 3] - camWorld.x,
      trailThree[idxNow * 3 + 1] - camWorld.y,
      trailThree[idxNow * 3 + 2] - camWorld.z);
    leaderLine.geometry.attributes.position.setXYZ(1,
      cassWorld[0] - camWorld.x, cassWorld[1] - camWorld.y, cassWorld[2] - camWorld.z);
    leaderLine.geometry.attributes.position.needsUpdate = true;
    leaderLine.visible = cassTrail && idxNow < trailN - 1;

    // glows face camera, fade when close; mini markers for sub-pixel bodies
    const camQ = camera.quaternion;
    for (const [name, entry] of registry) {
      if (name === '__sunLight') continue;
      const d = Math.hypot(
        entry.world[0] - camWorld.x,
        entry.world[1] - camWorld.y,
        entry.world[2] - camWorld.z);
      if (entry.glow) {
        // 行星光晕：朝向相机，靠近即淡出避免遮蔽（太阳光晕已改为壳层，无此需求）
        const k = Math.min(1, Math.max(0, (d / (entry.radius * 14)) - 0.35));
        entry.glow.quaternion.copy(camQ);
        entry.glow.material.opacity = 0.9 * k;
        entry.glow.visible = k > 0.01;
      }
      if (entry.glowShell) {
        // 相机进入光晕壳内（<2.8R）时整体淡出，避免暖纱遮蔽星空
        entry.glowShell.material.uniforms.uFade.value =
          Math.min(1, Math.max(0, (d / (entry.radius * 2.8) - 0.55) / 0.45));
      }
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
          entry.miniMarker.visible = true;
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
          entry.mesh.rotation.y = Math.atan2(_v1.x, _v1.z);
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

  /* —— Cassini 真实姿态状态（NASA 任务记录，item 6）——
   * HGA(+Z) 默认对地通信（Earth 方向，实时由历表求解）。三个有据可查的例外：
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
   * window.CassiniScene.attitudeState 供 HUD 显示；姿态切换按墙钟指数收敛
   * （真实机动在数分钟内完成，回放/跳转时平滑跟随）。 */
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
  };
  let attScanDone = false;
  let attSoiCross = null;       // SOI 点火中的环面穿越时刻
  let attFinaleCrossings = [];  // finale 环缝穿越 [{t, r}]（[0] = 首次俯冲，边缘对准）
  let attMode = 'earth';
  let attQ = null;
  let attLastWall = 0;

  const _attScanC = [0, 0, 0];
  const _attScanS = [0, 0, 0];

  /* 环面过零扫描（一次性）：轨迹点相对土星位置在赤道面法向上的坐标过零 →
   * 穿越时刻 + 穿越半径。finale 俯冲的穿越半径在主环内缘（74,500 km）以内。 */
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
    attFinaleCrossings = found.filter(c => c.t >= tFin0 && c.r < 74500);
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
    attitudeTarget(t, cassWorld);
    if (_attV.lengthSq() < 1e-18) _attV.set(0, 0, 1); else _attV.normalize();
    _attQ.setFromUnitVectors(Z_AXIS, _attV);
    const now = performance.now();
    if (!attQ) {
      attQ = _attQ.clone();
    } else {
      const dt = attLastWall ? Math.min(0.1, Math.max(0, (now - attLastWall) / 1000)) : 1;
      attQ.slerp(_attQ, 1 - Math.exp(-dt * 5));
    }
    attLastWall = now;
    cassiniModel.quaternion.copy(attQ);
  }

  /* SOI 相对轨迹逐帧更新（item 2/3 两级参考系）：
     - 一级（行星 SOI：Venus/Earth/Jupiter/Saturn）：Cassini 进入 → 相对轨迹淡入，
       绝对（日心）轨迹同步降低亮度；离开 → 相对轨迹淡出、绝对轨迹恢复亮度。
     - 二级（卫星 SOI：Titan/Enceladus/…，仅 Saturn SOI 内存在）：进入卫星 SOI →
       绝对轨迹再降亮度、一级相对轨迹降亮度、二级相对轨迹淡入。
     亮度联动（对 opacity 乘子，逐帧平滑跟随 k 值，无突变）：
       absDim = (1−0.45·k1)·(1−0.35·k2)，一级 ×(1−0.45·k2)，二级 = k2。
     cassini 总开关关闭时隐藏全部相对轨迹（soiState 仍用于 HUD 相对速度显示）。 */
  const ABS_DIM1 = 0.45, ABS_DIM2 = 0.35, REL_DIM2 = 0.45;
  function updateSoiTrails(t) {
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
    const bound2 = (() => { const b = soiWindowBound(); return b * b; })();
    for (const [name, sp] of soiPlanets) {
      const entry = sp.entry;
      const k = kOf.get(name) || 0;
      const isMoon = !!entry.parent;
      // 二级轨迹只在其窗口存在（真实 SOI 穿越），一级窗口覆盖整个 SOI 区间
      const lvlDim = isMoon ? 1 : (1 - REL_DIM2 * bestMK);
      const win = showRel && k > 0.001 ? soiWindowAt(sp, t) : null;
      for (const w of sp.wins) {
        if (!win || w !== win) { w.full.visible = false; w.flown.visible = false; continue; }
        // —— 行星锚定的浮动原点维护：原点漂移或行星漂移超阈值才重建顶点缓冲，
        //    逐帧仅更新对象位置（o − cam + planet_now − pRef，f64 精确补偿）——
        const wx = entry.world[0], wy = entry.world[1], wz = entry.world[2];
        const ddx = camWorld.x - w.o.x, ddy = camWorld.y - w.o.y, ddz = camWorld.z - w.o.z;
        const dpx = wx - w.pRef.x, dpy = wy - w.pRef.y, dpz = wz - w.pRef.z;
        if (!w.built ||
            ddx * ddx + ddy * ddy + ddz * ddz + dpx * dpx + dpy * dpy + dpz * dpz > bound2) {
          rebuildSoiWindow(w, entry);
        }
        w.full.visible = trailOptions.future;
        w.flown.visible = true;
        w.full.position.set(
          w.o.x - camWorld.x + (wx - w.pRef.x),
          w.o.y - camWorld.y + (wy - w.pRef.y),
          w.o.z - camWorld.z + (wz - w.pRef.z));
        w.flown.position.copy(w.full.position);
        w.full.material.opacity = 0.30 * k * lvlDim;
        w.flown.material.opacity = 0.9 * k * lvlDim;
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
        w.flown.geometry.setDrawRange(wStart, Math.max(2, rel + 1 - wStart));
        if (trailOptions.future) {
          w.full.geometry.setDrawRange(rel, Math.max(0, w.n - rel));
        }
        // 相对轨迹顶点少，逐帧刷新颜色（近期淡出跟随回放，无 600s 缓存迟滞）
        applyTrailFade(w.flown, w.times, t, [1.0, 0.827, 0.498], rel + 1, wStart, true);
      }
    }
    // 绝对（日心）轨迹亮度：进入行星 SOI 降 45%，再进入卫星 SOI 再降 35%
    trailFullLine.material.opacity = 0.34 * absDim;
    trailFlownLine.material.opacity = 0.95 * absDim;
    leaderLine.material.opacity = 0.9 * absDim;
    soiState.name = bestK > 0.02 ? bestName : null;
    soiState.k = bestK;
    soiState.moon = bestMK > 0.02 ? bestMoon : null;
    soiState.k2 = bestMK;
  }

  function render() {
    renderer.render(scene, camera);
  }

  // ---------- labels（item 11：大天体标签上移不遮挡模型 + 遮挡剔除；
  //            Cassini 标签置于下侧，与上侧的天体标签天然分离，重叠时避让） ----------
  const projV = new THREE.Vector3();
  const screenPts = new Map();
  let cassiniLabelEl = null;
  function updateLabels(cassWorld) {
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
      screenPts.set(name, [x, y]);
      entry.labelEl.classList.remove('hide');
      entry.labelEl.classList.toggle('dim', dist > 4e9);
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
    setRealisticLighting, setTrailOptions,
    get registry() { return registry; },
    get camera() { return camera; },
    get scene() { return scene; },
    get trailOptions() { return trailOptions; },
    get SPIN() { return SPIN; },
    get TILT() { return TILT; },
    get soiState() { return soiState; },
    get attitudeState() { return ATT_LBL[attMode] || ATT_LBL.earth; },
    setCameraWorld(v) { camWorld.x = v[0]; camWorld.y = v[1]; camWorld.z = v[2]; },
    camWorld,
    cassiniPosAt,
    trailIndexAt,
    trailLength: trailN,
    J2000Ms,
    bodyNames: BODIES.map(b => b.name),
  };
})();
