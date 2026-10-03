/* 离线核验 js/huygens.js 的分离前后摆位逻辑（无需浏览器）：
 * 装载真实 GLB + 真实烘焙数据，驱动 HuygensVis，检查
 *   1) 分离瞬间（t = sepEt）探测器与 Cassini 的世界位置严格重合
 *   2) 分离前挂载态与组合体内 huygens_probe 节点逐点重合
 *   3) 分离后漂移量 = relCass 真实值（0.383 m/s）
 * 用法：node tools/verify_huygens_runtime.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const J2000_MS = 946728000000;

/* base64 → TypedArray：必须用 byteOffset/byteLength 切片。
 * Buffer.from(b64) 对 <4KB 的负载会复用 Node 的共享内存池，`.buffer.slice(0)`
 * 会把整个 8KB 池交出去、忽略 byteOffset，解出的全是别处的字节（曾致 NaN）。 */
function b64Arr(b64, T) {
  const b = Buffer.from(b64, 'base64');
  return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

function stubCtx2d() {
  const noop = () => {};
  return {
    fillStyle: '', globalAlpha: 1, globalCompositeOperation: '',
    createLinearGradient: () => ({ addColorStop: noop }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: noop, drawImage: noop, fillRect: noop,
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  };
}
const stubCanvas = () => ({ width: 1, height: 1, getContext: () => stubCtx2d(), style: {} });
const stubEl = () => ({
  classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
  style: {}, appendChild: () => {}, addEventListener: () => {}, textContent: '',
});

const ctx = {
  window: {}, console,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  document: {
    createElement: (tag) => (tag === 'canvas' ? stubCanvas() : stubEl()),
    getElementById: () => stubEl(),
  },
  performance: { now: () => Date.now() },
  requestAnimationFrame: () => 0,
};
ctx.globalThis = ctx;
ctx.self = ctx;
ctx.createImageBitmap = () => Promise.reject(new Error('skip'));
vm.createContext(ctx);

// —— 真实数据 ——
vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/models.js'), 'utf8'), ctx, { filename: 'models.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/cassini_data.js'), 'utf8'), ctx, { filename: 'cassini_data.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/moons_data.js'), 'utf8'), ctx, { filename: 'moons_data.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib/three.min.js'), 'utf8'), ctx, { filename: 'three.min.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib/GLTFLoader.js'), 'utf8'), ctx, { filename: 'GLTFLoader.js' });
const THREE = ctx.THREE || ctx.window.THREE;
console.log('THREE r' + THREE.REVISION);

vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/cassini_model.js'), 'utf8'), ctx, { filename: 'cassini_model.js' });

// —— 桩场景（只提供 huygens.js 需要的接口）——
const DATA = ctx.window.CASSINI_DATA;
const HUY = DATA.spacecraft.cassini.huygens;
const registry = new Map();
const scene = new THREE.Scene();
const camWorld = { x: 0, y: 0, z: 0 };

function mkTrack(segs) {
  // segs: [{t0, dt, n, d(b64 f32)}]，与烘焙一致
  const list = segs.map((s) => ({
    t0: s.t0, dt: s.dt, n: s.n,
    xyz: b64Arr(s.d, Float32Array),
  }));
  return {
    at(t, out) {
      let seg = null;
      for (const s of list) {
        const end = s.t0 + s.dt * (s.n - 1);
        if (t >= s.t0 && t <= end) { seg = s; break; }
      }
      if (!seg) {
        // 取最近段并夹紧
        seg = list.reduce((a, b) => {
          const da = Math.max(a.t0 - t, t - (a.t0 + a.dt * (a.n - 1)), 0);
          const db = Math.max(b.t0 - t, t - (b.t0 + b.dt * (b.n - 1)), 0);
          return db < da ? b : a;
        });
      }
      const f = Math.max(0, Math.min((t - seg.t0) / seg.dt, seg.n - 1));
      const i = Math.min(seg.n - 2, Math.floor(f));
      const a = f - i, o = i * 3, o2 = (i + 1) * 3;
      out[0] = seg.xyz[o] + (seg.xyz[o2] - seg.xyz[o]) * a;
      out[1] = seg.xyz[o + 1] + (seg.xyz[o2 + 1] - seg.xyz[o + 1]) * a;
      out[2] = seg.xyz[o + 2] + (seg.xyz[o2 + 2] - seg.xyz[o + 2]) * a;
      return out;
    },
  };
}
const bodies = DATA.bodies;
const MOONS = (ctx.window.MOONS_DATA && ctx.window.MOONS_DATA.bodies) || {};
const PARENT = { moon: 'earth', titan: 'saturn', enceladus: 'saturn', iapetus: 'saturn',
                 rhea: 'saturn', dione: 'saturn', tethys: 'saturn', mimas: 'saturn' };
for (const [name, bd] of Object.entries(bodies)) {
  if (!bd.segs) continue;
  registry.set(name, { track: mkTrack(bd.segs), world: [0, 0, 0], radius: bd.radiusKm || 1 });
}
for (const [name, bd] of Object.entries(MOONS)) {
  if (!bd.segs) continue;
  registry.set(name, {
    track: mkTrack(bd.segs), world: [0, 0, 0], radius: bd.radiusKm || 1,
    parent: PARENT[name],
  });
}

// eclToThree = [x, z, -y]（与 scene.js 一致）
const eclToThree = (v) => [v[0], v[2], -v[1]];

// Cassini 位置：用主轨迹（trailThree，黄道 → three）
const trailT = b64Arr(DATA.spacecraft.cassini.trailT, Float64Array);
const trailN = DATA.spacecraft.cassini.trailN;
const trailXYZ = b64Arr(DATA.spacecraft.cassini.trail, Float32Array);
const trailThree = new Float64Array(trailN * 3);
for (let i = 0; i < trailN; i++) {
  const w = eclToThree([trailXYZ[i * 3], trailXYZ[i * 3 + 1], trailXYZ[i * 3 + 2]]);
  trailThree[i * 3] = w[0]; trailThree[i * 3 + 1] = w[1]; trailThree[i * 3 + 2] = w[2];
}
function cassiniPosAt(t, out) {
  let lo = 0, hi = trailN - 1;
  if (t <= trailT[0]) { lo = 0; hi = 1; }
  else if (t >= trailT[trailN - 1]) { lo = trailN - 2; hi = trailN - 1; }
  else { while (hi - lo > 1) { const m = (lo + hi) >> 1; if (trailT[m] <= t) lo = m; else hi = m; } }
  const a = (t - trailT[lo]) / (trailT[hi] - trailT[lo] || 1);
  const o = lo * 3, o2 = hi * 3;
  out[0] = trailThree[o] + (trailThree[o2] - trailThree[o]) * a;
  out[1] = trailThree[o + 1] + (trailThree[o2 + 1] - trailThree[o + 1]) * a;
  out[2] = trailThree[o + 2] + (trailThree[o2 + 2] - trailThree[o + 2]) * a;
  return out;
}

// 组合体姿态：优先用**真实姿态数据**（window.CASSINI_ATT，与 scene.js 同源），
// 取分离时刻的插值四元数——这样 §4 的「探测器自旋轴 vs 进入走廊」才是有意义的
// 实测复核（真实姿态下应 ≈0.7°，验证「分离后无需重定向」这一步）。无数据时退回
// 一个固定非平凡四元数（仅用于几何一致性核验）。
vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/attitude_data.js'), 'utf8'), ctx, { filename: 'attitude_data.js' });
const modelQuat = (() => {
  const A = ctx.window.CASSINI_ATT;
  if (!A) {
    return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.7)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -1.3)).normalize();
  }
  const T = b64Arr(A.t, Float64Array), Q = b64Arr(A.q, Float32Array);
  const t = HUY.sepEt;
  let lo = 0, hi = T.length - 1;
  if (t <= T[0]) { lo = 0; hi = 1; }
  else if (t >= T[T.length - 1]) { lo = T.length - 2; hi = T.length - 1; }
  else { while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; } }
  const s = (t - T[lo]) / (T[hi] - T[lo] || 1);
  const a = new THREE.Quaternion(Q[lo * 4], Q[lo * 4 + 1], Q[lo * 4 + 2], Q[lo * 4 + 3]);
  const b = new THREE.Quaternion(Q[hi * 4], Q[hi * 4 + 1], Q[hi * 4 + 2], Q[hi * 4 + 3]);
  return a.slerp(b, Math.min(1, Math.max(0, s)));
})();
console.log('分离时刻真实姿态 modelQuat =',
  `(${modelQuat.x.toFixed(4)}, ${modelQuat.y.toFixed(4)}, ${modelQuat.z.toFixed(4)}, ${modelQuat.w.toFixed(4)})`);

const markerTex = () => {
  const c = stubCanvas();
  const tex = new THREE.Texture(c);
  tex.needsUpdate = true;
  return tex;
};
const huyCtx = {
  scene, registry, eclToThree, cassiniPosAt, markerTexture: markerTex,
  viewOccluded: () => false,
  modelFadeK: () => 0,
  trailOpts: () => ({ future: true, mode: 'all', cassini: true, huygens: true }),
  cassiniQuatAt: () => modelQuat,
};
ctx.window.CassiniScene = { screenPosOf: () => ({ x: 0, y: 0, dist: 1e6, behind: false }),
                            camera: { fov: 45 } };

vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/huygens.js'), 'utf8'), ctx, { filename: 'huygens.js' });
const HuygensVis = ctx.window.HuygensVis;

// —— 装载模型并接线 ——
ctx.window.CassiniModel.load((parts) => {
  const { stack, orbiter, probe } = parts;
  if (!probe) { console.error('probe 未装载'); process.exit(1); }
  stack.quaternion.copy(modelQuat);
  scene.add(stack);
  scene.add(probe);
  probe.visible = true;
  HuygensVis.init(huyCtx, probe);

  const SEP = HUY.sepEt;
  console.log('\n=== 1) 分离瞬间（t = sepEt）位置连续性 ===');
  console.log('   （分离前 update 直接返回、模型隐藏，故只核验 t ≥ sepEt；' +
    '分离前挂载态见第 2 段）');
  for (const dt of [0, 1, 10, 60, 300]) {
    const t = SEP + dt;
    stepWorld(t);
    HuygensVis.update(t, camWorld, 0.83, 900, 0);

    const cw = cassiniPosAt(t, [0, 0, 0]);
    const hw = HuygensVis.getWorld();
    const d = Math.hypot(hw[0] - cw[0], hw[1] - cw[1], hw[2] - cw[2]);
    console.log(` sep+${String(dt).padStart(3)}s   Huygens-Cassini 距离 = ${(d * 1000).toFixed(4)} m` +
      (dt === 0 ? '   ← 分离瞬间应与母船同点' : ''));
  }

  console.log('\n=== 2) 分离前挂载态 vs 组合体内节点（世界坐标）===');
  const t0 = SEP - 600;
  stepWorld(t0);
  // 分离前 update 提前返回，探测器模型由 scene.js 不驱动；此处直接按 huygens.js
  // 的分离前摆位规则（Cassini 位置 + R_cass·挂点，挂点 = 0）复现
  const cw0 = cassiniPosAt(t0, [0, 0, 0]);
  stack.position.copy(new THREE.Vector3(cw0[0] - camWorld.x, cw0[1] - camWorld.y, cw0[2] - camWorld.z));
  stack.quaternion.copy(modelQuat);
  stack.updateMatrixWorld(true);
  const node = stack.getObjectByName('huygens_probe');
  const pNode = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
  probe.position.copy(stack.position);        // 挂点 = 组合体原点
  probe.quaternion.copy(modelQuat);           // 挂载态与母船同姿态
  probe.userData.spin.position.set(0, 0, 0);
  probe.userData.spin.rotation.set(0, 0, 0);   // 自旋轴现为本地 Y（旧版为 Z）
  probe.updateMatrixWorld(true);
  const pProbe = new THREE.Vector3().setFromMatrixPosition(probe.matrixWorld);
  console.log(' 组合体内节点世界位置 :', f(pNode));
  console.log(' 独立探测器世界位置   :', f(pProbe));
  console.log(' 偏差（m）            :', (pNode.distanceTo(pProbe) * 1000).toFixed(6), '（应 ≈ 0）');
  const qn = node.getWorldQuaternion(new THREE.Quaternion());
  const qp = probe.getWorldQuaternion(new THREE.Quaternion());
  // 注：node 的世界四元数 = stackQ·Q_GLB（Q_GLB 在其祖先 asm 内），而 probe 的
  // 世界四元数 = wrapQ（Q_GLB 在其子级 spin→asm 内）。两者本就差 Q_GLB，
  // 直接比四元数得到 120° 是**假象**——同一物理网格的判据是顶点云/包围盒重合
  // （见下方 0.0000 的 RMS）。此处仅作参考输出，不再当作错误。
  console.log(' 姿态四元数夹角（°）  :', THREE.MathUtils.radToDeg(qn.angleTo(qp)).toFixed(6),
    '（= Q_GLB 夹角，两级的 Q_GLB 层级不同所致，非姿态错误；真实判据见顶点云）');
  // 几何包围盒对比（含探测器自身悬挂偏置）
  const bN = new THREE.Box3().setFromObject(node);
  const bP = new THREE.Box3().setFromObject(probe);
  const dc = bN.getCenter(new THREE.Vector3()).distanceTo(bP.getCenter(new THREE.Vector3()));
  console.log(' 包围盒中心偏差（m）  :', (dc * 1000).toFixed(6), '（应 ≈ 0 → 与组合体逐点重合）');
  console.log(' 节点 bbox min/max    :', f(bN.min, 6), f(bN.max, 6));
  console.log(' 探测器 bbox min/max  :', f(bP.min, 6), f(bP.max, 6));
  const dMin = bN.min.distanceTo(bP.min), dMax = bN.max.distanceTo(bP.max);
  console.log(' bbox min/max 偏差(m) :', (dMin * 1000).toFixed(3), '/', (dMax * 1000).toFixed(3),
    '（两者都应 ≈ 0 → 朝向一致；若 min/max 明显不同则姿态差 Q_GLB）');
  // 顶点级姿态一致性：把独立探测器的顶点云与组合体节点云的**同一顶点**相比
  {
    const refPts = [];
    node.traverse((o) => {
      if (!o.isMesh) return;
      const pa = o.geometry.attributes.position;
      for (let i = 0; i < pa.count; i += 7) refPts.push(new THREE.Vector3().fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld));
    });
    const curPts = [];
    probe.traverse((o) => {
      if (!o.isMesh) return;
      const pa = o.geometry.attributes.position;
      for (let i = 0; i < pa.count; i += 7) curPts.push(new THREE.Vector3().fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld));
    });
    let s = 0, n = 0;
    for (let i = 0; i < Math.min(refPts.length, curPts.length); i++) {
      s += refPts[i].distanceToSquared(curPts[i]); n++;
    }
    console.log(' 顶点云 RMS 偏差（m） :', n ? Math.sqrt(s / n).toExponential(4) : 'n/a',
      `（${n} 个采样点，应 ≈ 0 → 与组合体逐点重合，姿态无误）`);
  }

  console.log('\n=== 3) 分离后漂移 vs relCass 真值 ===');
  const { t: rcT, d: rcD } = HUY.relCass;
  const rcTs = b64Arr(rcT, Float64Array);
  const rcDs = b64Arr(rcD, Float32Array);
  for (const min of [0, 1, 5, 30, 60]) {
    const t = SEP + min * 60;
    stepWorld(t);
    HuygensVis.update(t, camWorld, 0.83, 900, 0);
    const cw = cassiniPosAt(t, [0, 0, 0]);
    const hw = HuygensVis.getWorld();
    const d = Math.hypot(hw[0] - cw[0], hw[1] - cw[1], hw[2] - cw[2]);
    // 真值
    let best = 0;
    for (let k = 0; k < rcTs.length; k++) if (Math.abs(rcTs[k] - t) < Math.abs(rcTs[best] - t)) best = k;
    const truth = Math.hypot(rcDs[best * 3], rcDs[best * 3 + 1], rcDs[best * 3 + 2]);
    console.log(` sep+${String(min).padStart(2)}min: 模型 ${(d * 1000).toFixed(2)} m | relCass ${(truth * 1000).toFixed(2)} m` +
      ` | 差 ${Math.abs(d - truth) * 1000 < 1 ? '<1' : (Math.abs(d - truth) * 1000).toFixed(1)} m`);
  }

  console.log('\n=== 4) 自旋轴（应为探测器 body +Y = 大底法向）===');
  // 分离后 1h（已远离母船）：body +Y 世界向应与进入走廊 RAM ≈ 0.7°（因姿态冻结在
  // 分离瞬间的挂载姿态——真实姿态回放实测即差 0.68°）；body +Z 应大致垂直 RAM。
  {
    const t = SEP + 3600;
    stepWorld(t);
    HuygensVis.update(t, camWorld, 0.83, 900, 0);
    probe.updateMatrixWorld(true);
    const q = probe.getWorldQuaternion(new THREE.Quaternion());
    const bodyY = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const bodyZ = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    // 进入走廊 RAM（= −relTit 在 ENTRY 处切向），与 huygens.js init 同式
    const ds = HUY.relTit;
    const dt = b64Arr(ds.t, Float64Array);
    const dd = b64Arr(ds.d, Float32Array);   // d 是 float32
    const eclTo3 = (v) => [v[0], v[2], -v[1]];
    const ddt = new Float64Array(dd.length);
    for (let i = 0; i < dd.length; i += 3) {
      const w = eclTo3([dd[i], dd[i + 1], dd[i + 2]]);
      ddt[i] = w[0]; ddt[i + 1] = w[1]; ddt[i + 2] = w[2];
    }
    const eAt = HUY.entryEt;
    function rel(t) {
      let l = 0, h = dt.length - 1;
      while (h - l > 1) { const m = (l + h) >> 1; if (dt[m] <= t) l = m; else h = m; }
      const a = (t - dt[l]) / (dt[h] - dt[l] || 1);
      const r = [0, 0, 0];
      for (let i = 0; i < 3; i++) r[i] = ddt[l * 3 + i] + (ddt[h * 3 + i] - ddt[l * 3 + i]) * a;
      return r;
    }
    function relT(t) { const a = rel(Math.max(dt[0], t - 60)), b = rel(Math.min(dt[dt.length - 1], t + 60)); return [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; }
    const tv = relT(eAt); const L = Math.hypot(tv[0], tv[1], tv[2]);
    const ram = new THREE.Vector3(-tv[0] / L, -tv[1] / L, -tv[2] / L);
    console.log(' body +Y 世界向 :', f(bodyY));
    console.log(' 进入走廊 RAM   :', f(ram));
    console.log(' 夹角（°）      :', THREE.MathUtils.radToDeg(bodyY.angleTo(ram)).toFixed(3),
      '（应 ≈ 0.7° → 大底正对气流；分离瞬间的真实挂载姿态即已对准走廊）');
    console.log(' （对照）body +Z 世界向:', f(bodyZ), '与 RAM 夹角', THREE.MathUtils.radToDeg(bodyZ.angleTo(ram)).toFixed(2), '°（应 ≈ 90°）');
  }

  console.log('\n=== 4b) 自旋几何：绕 body +Y 自旋，轴本身不动 ===');
  {
    const q0 = (() => { const t = SEP + 60; stepWorld(t); HuygensVis.update(t, camWorld, 0.83, 900, 0); probe.updateMatrixWorld(true); return probe.getWorldQuaternion(new THREE.Quaternion()); })();
    const y0 = new THREE.Vector3(0, 1, 0).applyQuaternion(q0);
    // 自旋一个周期（60/7 rpm ≈ 8.571 s）后，body +Y 世界向应完全不变（轴不动）
    let maxAxisDrift = 0, minSpinAngle = 1e9;
    for (const dt of [1, 2, 4, 60 / 7, 2 * 60 / 7]) {
      const t = SEP + 60 + dt;
      stepWorld(t); HuygensVis.update(t, camWorld, 0.83, 900, 0); probe.updateMatrixWorld(true);
      const y = new THREE.Vector3(0, 1, 0).applyQuaternion(probe.getWorldQuaternion(new THREE.Quaternion()));
      maxAxisDrift = Math.max(maxAxisDrift, y.angleTo(y0) * 180 / Math.PI);
    }
    console.log(' 轴在自旋中的最大漂移（°）:', maxAxisDrift.toFixed(4), '（应 ≈ 0 → 严格绕 Y 自旋）');
    // 旋转中心检查：取**离轴最远**的真实顶点（在 wrap 系），跟踪半个周期，三点定圆
    // 求实际旋转中心，应严格 = 大底圆心（= 回转轴心 = 质心 XZ）。
    // 旧版误把 GLB 系轴向点 (1.3,0,0) 当径向点（GLB +X 经 Q_GLB 变成 wrap −Y），
    // 得到的是「沿轴偏移」而非半径，输出恒为该偏移量 1.119，无诊断意义。
    probe.userData.spin.updateMatrixWorld(true);
    const asm2 = probe.userData.spin.children[0];
    const c0 = probe.userData.centroid;
    let v1 = null, rBest = -1, v1Spin = null;
    {
      const invW = new THREE.Matrix4().copy(probe.matrixWorld).invert();
      probe.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        const pa = o.geometry.attributes.position; if (!pa) return;
        for (let i = 0; i < pa.count; i++) {
          const p = new THREE.Vector3().fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld).applyMatrix4(invW);
          const r = Math.hypot(p.x - c0.x, p.z - c0.z);
          if (r > rBest) { rBest = r; v1 = p.clone(); }
        }
      });
    }
    // 该顶点在 spin 系的体坐标（不变），逐帧映回 wrap 系
    const invSpin = new THREE.Matrix4().copy(probe.userData.spin.matrixWorld).invert();
    v1Spin = v1.clone().applyMatrix4(invSpin);
    function edgeInWrap(t) {
      stepWorld(t); HuygensVis.update(t, camWorld, 0.83, 900, 0); probe.updateMatrixWorld(true);
      const w = v1Spin.clone().applyMatrix4(probe.userData.spin.matrixWorld);
      return w.applyMatrix4(new THREE.Matrix4().copy(probe.matrixWorld).invert());  // wrap 系
    }
    const tA = SEP + 60, tB = SEP + 60 + 2 * (60 / 7) / 3, tC = SEP + 60 + 4 * (60 / 7) / 3;
    const eA = edgeInWrap(tA), eB = edgeInWrap(tB), eC = edgeInWrap(tC);
    function circle3(p1, p2, p3) {
      const ax = p1.x, az = p1.z, bx = p2.x, bz = p2.z, cx = p3.x, cz = p3.z;
      const d = 2 * (ax * (bz - cz) + bx * (cz - az) + cx * (az - bz));
      if (Math.abs(d) < 1e-18) return null;
      const ux = ((ax * ax + az * az) * (bz - cz) + (bx * bx + bz * bz) * (cz - az) + (cx * cx + cz * cz) * (az - bz)) / d;
      const uz = ((ax * ax + az * az) * (cx - bx) + (bx * bx + bz * bz) * (ax - cx) + (cx * cx + cz * cz) * (bx - ax)) / d;
      return new THREE.Vector3(ux, 0, uz);
    }
    const ctr = circle3(eA, eB, eC);
    if (ctr) {
      console.log(' 实测旋转中心(wrap,mm):', `(${(ctr.x * 1000).toFixed(4)}, ${(ctr.z * 1000).toFixed(4)})`,
        '| 质心XZ:', `(${(c0.x * 1000).toFixed(4)}, ${(c0.z * 1000).toFixed(4)})`,
        '| 偏离 =', (Math.hypot(ctr.x - c0.x, ctr.z - c0.z) * 1000).toFixed(4), 'mm（应 ≈ 0）');
      console.log(' 大底外缘顶点绕转半径（mm）:', (rBest * 1000).toFixed(4),
        '（半周期位移应 ≈ 2×半径 =', (2 * rBest * 1000).toFixed(3), 'mm）');
    }
  }

  console.log('\n=== 5) 分离瞬间无穿模 / 无姿态跳变 ===');
  console.log(' 设计：分离后姿态冻结在分离瞬间的挂载姿态（自旋轴惯性系固定），' +
    '只叠加绕 body +Y 的 7 rpm——探测器随 relCass 漂离母船，不发生重定向。');
  {
    const orbiter = parts.orbiter;
    scene.add(orbiter);
    orbiter.quaternion.identity(); orbiter.position.set(0, 0, 0); orbiter.updateMatrixWorld(true);
    const obLocal = new THREE.Box3().setFromObject(orbiter);
    for (const dt of [0, 5, 15, 30, 60, 120, 240, 600, 3600]) {
      const t = SEP + dt;
      stepWorld(t);
      const cw = cassiniPosAt(t, [0, 0, 0]);
      orbiter.position.set(cw[0] - camWorld.x, cw[1] - camWorld.y, cw[2] - camWorld.z);
      orbiter.quaternion.copy(modelQuat);
      orbiter.updateMatrixWorld(true);
      HuygensVis.update(t, camWorld, 0.83, 900, 0);
      probe.updateMatrixWorld(true);
      const bP = new THREE.Box3().setFromObject(probe);
      const qInv = orbiter.quaternion.clone().invert();
      let hit = false;
      for (let i = 0; i < 8; i++) {
        const p = new THREE.Vector3(
          i & 1 ? bP.max.x : bP.min.x,
          i & 2 ? bP.max.y : bP.min.y,
          i & 4 ? bP.max.z : bP.min.z)
          .sub(orbiter.position).applyQuaternion(qInv);
        if (obLocal.containsPoint(p)) { hit = true; break; }
      }
      console.log(` sep+${String(dt).padStart(4)}s: 探测器角点${hit ? '仍在轨道器包围盒内（分离前挂载位置，正常）' : '已完全脱离轨道器'}`);
    }
    // 姿态连续性：分离前后相邻 15s 的姿态变化（应连续；分离瞬间不应有跳变）
    console.log(' 姿态连续性（相邻 15s 世界姿态夹角变化，°）:');
    let prevQ = null, prevT = null;
    for (const dt of [-30, -15, 0, 15, 30, 45, 60, 120, 240]) {
      const t = SEP + dt;
      stepWorld(t);
      if (t < SEP) {
        // 分离前 huygens.js 不摆位，直接按挂载规则取姿态
        probe.quaternion.copy(modelQuat);
        probe.userData.spin.rotation.set(0, 0, 0);
        probe.userData.spin.position.set(0, 0, 0);
        probe.updateMatrixWorld(true);
      } else {
        HuygensVis.update(t, camWorld, 0.83, 900, 0);
        probe.updateMatrixWorld(true);
      }
      const q = probe.getWorldQuaternion(new THREE.Quaternion());
      if (prevQ) {
        const dq = prevQ.angleTo(q) * 180 / Math.PI;
        console.log(`   ${String(dt).padStart(4)}s: Δ=${dq.toFixed(2)}°` + (dq > 60 ? '   ← 过大（跳变）' : ''));
      }
      prevQ = q;
    }
  }
}, 0);

// 更新 registry 世界位置（等价 scene.js updatePositions 的核心）
const tmpV = [0, 0, 0];
function stepWorld(t) {
  for (const [name, e] of registry) {
    if (!e.track) continue;
    e.track.at(t, tmpV);
    const w = eclToThree(tmpV);
    if (e.parent) {
      const p = registry.get(e.parent);
      e.world[0] = p.world[0] + w[0]; e.world[1] = p.world[1] + w[1]; e.world[2] = p.world[2] + w[2];
    } else { e.world[0] = w[0]; e.world[1] = w[1]; e.world[2] = w[2]; }
  }
  // Cassini 模型姿态（scene.js 逐帧更新 _attQ，再复制给 cassiniModel）
}

function f(v, d = 4) { return `(${v.x.toFixed(d)}, ${v.y.toFixed(d)}, ${v.z.toFixed(d)})`; }
