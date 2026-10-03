/* 定位 Huygens 探测器「回转对称轴」在 wrap 系中的**真实位置**（不仅是方向）。
 *
 * 背景：probe_huygens_axes.js 已确认回转轴方向 = wrap-local Y（0.78°）。但方向对
 * 不等于「轴过哪个点」对——自旋必须绕真实回转轴，否则会像偏心陀螺一样摆。
 * 几何上：φ2.615 大底的圆盘中心（在所有绕 Y 的切片里）才是轴应该穿过的点。
 *
 * 本脚本：
 *   1) 遍历所有顶点，按 wrap-local y 分桶切片，求每片顶点在 XZ 平面的质心；
 *   2) 这些 XZ 质心随 y 变化若近似直线 → 即回转轴在 XZ 上的位置；
 *   3) 用 PCA（最小特征值）拟合出轴线在 XZ 平面的 (x0, z0)；
 *   4) 输出轴线与 wrap 原点的偏差、与包围盒中心的偏差、与 userData.centroid 的偏差。
 *
 * 用法：node tools/probe_huygens_axis_loc.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function b64ToBufInCtx(ctx, b64) {
  return vm.runInContext(`b64ToBuffer(${JSON.stringify(b64)})`, ctx);
}

const stubCtx2d = () => {
  const noop = () => {};
  return {
    fillStyle: '', globalAlpha: 1, globalCompositeOperation: '',
    createLinearGradient: () => ({ addColorStop: noop }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: noop, drawImage: noop, fillRect: noop,
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  };
};
const stubCanvas = () => ({ width: 1, height: 1, getContext: () => stubCtx2d(), style: {} });
const stubEl = () => ({
  classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
  style: {}, appendChild: () => {}, addEventListener: () => {}, textContent: '',
});

const ctx = {
  window: {}, console,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  document: { createElement: (t) => (t === 'canvas' ? stubCanvas() : stubEl()), getElementById: () => stubEl() },
  performance: { now: () => Date.now() },
  requestAnimationFrame: () => 0,
};
ctx.globalThis = ctx; ctx.self = ctx;
ctx.createImageBitmap = () => Promise.reject(new Error('skip'));
vm.createContext(ctx);

// 在 vm 内定义 b64ToBuffer（跨 realm 的 ArrayBuffer 才能被 GLTFLoader 认作 ArrayBuffer）
vm.runInContext(`
  function b64ToBuffer(b64) {
    var bin = atob(b64); var buf = new ArrayBuffer(bin.length); var u8 = new Uint8Array(buf);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return buf;
  }
`, ctx, { filename: 'helpers.js' });

vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/models.js'), 'utf8'), ctx, { filename: 'models.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib/three.min.js'), 'utf8'), ctx, { filename: 'three.min.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib/GLTFLoader.js'), 'utf8'), ctx, { filename: 'GLTFLoader.js' });
const THREE = ctx.THREE || ctx.window.THREE;
console.log('THREE r' + THREE.REVISION);

vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/cassini_model.js'), 'utf8'), ctx, { filename: 'cassini_model.js' });

ctx.window.CassiniModel.load((parts) => {
  const { probe, stack } = parts;
  if (!probe) { console.error('probe 未装载'); process.exit(1); }

  const wrap = probe;
  const spin = wrap.userData.spin;
  const asm = spin.children[0];

  // 收集 wrap 系顶点（probe 处于恒等变换时，matrixWorld 即 wrap 系）
  wrap.position.set(0, 0, 0); wrap.quaternion.identity(); wrap.scale.set(1, 1, 1);
  spin.position.set(0, 0, 0); spin.quaternion.identity();
  wrap.updateMatrixWorld(true);

  const pts = [];
  wrap.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes) return;
    const pa = o.geometry.attributes.position;
    if (!pa) return;
    for (let i = 0; i < pa.count; i += 1) {
      pts.push(new THREE.Vector3().fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld));
    }
  });
  console.log('顶点总数 =', pts.length);

  const box = new THREE.Box3().setFromPoints(pts);
  const size = box.getSize(new THREE.Vector3());
  const cen = box.getCenter(new THREE.Vector3());
  console.log('\n=== wrap 系包围盒 ===');
  console.log(' min =', f(box.min, 6), '\n max =', f(box.max, 6));
  console.log(' size(m) = ', f(size, 6), '  center =', f(cen, 6));
  console.log(' userData.centroid =', f(wrap.userData.centroid, 6));

  // —— 沿 Y 分桶切片，求每片的 XZ 质心 ——
  const N = 24;
  const y0 = box.min.y, y1 = box.max.y;
  const bins = Array.from({ length: N }, () => ({ sx: 0, sz: 0, n: 0, yMin: 0, yMax: 0, rMax: 0 }));
  for (const p of pts) {
    let k = Math.floor((p.y - y0) / (y1 - y0) * N);
    k = Math.max(0, Math.min(N - 1, k));
    const b = bins[k];
    b.sx += p.x; b.sz += p.z; b.n++;
  }
  console.log('\n=== 沿 Y 切片：各片 XZ 质心（轴心轨迹）===');
  console.log(' 片号   y中心(m)      n      XZ质心(x,z)(m)        r_max(m)');
  const trackPts = [];
  for (let k = 0; k < N; k++) {
    const b = bins[k];
    if (!b.n) continue;
    const yc = y0 + (k + 0.5) * (y1 - y0) / N;
    const cx = b.sx / b.n, cz = b.sz / b.n;
    let rMax = 0;
    for (const p of pts) {
      let kk = Math.floor((p.y - y0) / (y1 - y0) * N);
      kk = Math.max(0, Math.min(N - 1, kk));
      if (kk !== k) continue;
      rMax = Math.max(rMax, Math.hypot(p.x - cx, p.z - cz));
    }
    console.log(`  ${String(k).padStart(2)}   ${yc.toFixed(4)}   ${String(b.n).padStart(6)}   ` +
      `(${cx.toFixed(5)}, ${cz.toFixed(5)})   ${rMax.toFixed(4)}`);
    trackPts.push([yc, cx, cz, rMax]);
  }

  // —— 用轴心轨迹做 PCA：横截面质心随 y 走出的直线即回转轴 ——
  // 以 y 为自变量，x(y)、z(y) 分别做最小二乘直线拟合
  let sy = 0, sx = 0, sz = 0, syy = 0, syx = 0, syz = 0, m = 0;
  for (const [yc, cx, cz] of trackPts) { sy += yc; sx += cx; sz += cz; syy += yc * yc; syx += yc * cx; syz += yc * cz; m++; }
  const den = m * syy - sy * sy;
  const ax = (m * syx - sy * sx) / den, bx = (sx - ax * sy) / m;    // x = ax*y + bx
  const az = (m * syz - sy * sz) / den, bz = (sz - az * sy) / m;    // z = az*y + bz
  console.log('\n=== 回转轴直线拟合（横截面质心随 y 的最小二乘）===');
  console.log(` x(t) = ${ax.toFixed(6)}·y + ${bx.toFixed(6)}`);
  console.log(` z(t) = ${az.toFixed(6)}·y + ${bz.toFixed(6)}`);
  console.log(` 轴与 +Y 的夹角 = ${(Math.hypot(ax, az) * 180 / Math.PI).toFixed(3)}°` +
    `（方向偏差，应≈0）`);
  console.log(` 轴在 y=0 处的 XZ 交点 (x0,z0) = (${bx.toFixed(5)}, ${bz.toFixed(5)}) m`);
  console.log(` 轴在包围盒中心 y 处的 XZ 交点 = (${(ax * cen.y + bx).toFixed(5)}, ${(az * cen.y + bz).toFixed(5)}) m`);
  console.log(` 包围盒中心 XZ = (${cen.x.toFixed(5)}, ${cen.z.toFixed(5)}) m`);
  console.log(` userData.centroid XZ = (${wrap.userData.centroid.x.toFixed(5)}, ${wrap.userData.centroid.z.toFixed(5)}) m`);
}
, 0);

function f(v, d = 4) { return `(${v.x.toFixed(d)}, ${v.y.toFixed(d)}, ${v.z.toFixed(d)})`; }
