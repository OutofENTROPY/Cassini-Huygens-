/* 判定 huygens_probe 的实际体轴朝向（GLB 系 vs 经 Q_GLB 的场景/结构系 vs wrap 系），
 * 用于确定 wrap 内正确的预旋转与自旋轴换算。
 *
 * 采用与 tools/verify_huygens_runtime.js 完全相同的 sandbox 装配（单一 vm 上下文、
 * ctx.self = ctx、ctx.window 挂 three/GLTFLoader），已验证可成功解析 GLB。
 * 用法：node tools/probe_huygens_axes.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

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
  // three r147 的 LoaderUtils.decodeText 优先用 TextDecoder；vm 上下文默认没有它，
  // 会退回 escape/decodeURIComponent 路径并可能在含非 ASCII 的 JSON chunk 上抛错，
  // 导致 GLTFLoader 解析出错误的 asset 判定。显式注入 Node 自带的 TextDecoder。
  TextDecoder,
  TextEncoder,
};
ctx.globalThis = ctx;
ctx.self = ctx;
ctx.createImageBitmap = () => Promise.reject(new Error('skip'));
vm.createContext(ctx);

vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/models.js'), 'utf8'), ctx, { filename: 'models.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib/three.min.js'), 'utf8'), ctx, { filename: 'three.min.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib/GLTFLoader.js'), 'utf8'), ctx, { filename: 'GLTFLoader.js' });
const THREE = ctx.THREE || ctx.window.THREE;
console.log('THREE r' + THREE.REVISION);

const Q_GLB = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(
  0, 0, -1, 0,
  -1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 0, 1));

/* 顶点级主成分（幂迭代）+ 均值/包围盒/各轴标准差 */
function shapeInfo(obj) {
  const pts = [];
  obj.updateMatrixWorld(true);
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld));
    }
  });
  const mean = new THREE.Vector3();
  for (const p of pts) mean.add(p);
  mean.divideScalar(pts.length || 1);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of pts) {
    const dx = p.x - mean.x, dy = p.y - mean.y, dz = p.z - mean.z;
    xx += dx * dx; xy += dx * dy; xz += dx * dz;
    yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  let v = new THREE.Vector3(0.31, 0.77, 0.55).normalize();
  for (let i = 0; i < 400; i++) {
    v.set(xx * v.x + xy * v.y + xz * v.z,
          xy * v.x + yy * v.y + yz * v.z,
          xz * v.x + yz * v.y + zz * v.z).normalize();
  }
  return { axis: v, mean, box: new THREE.Box3().setFromObject(obj), n: pts.length };
}

// GLB 必须在 vm 上下文内解码：GLTFLoader 用 `data instanceof ArrayBuffer` 判定，
// 而跨 realm 的 ArrayBuffer 不满足该判定（会落入 else 分支 → json 无 asset →
// "Unsupported asset"）。故照搬 cassini_model.js 的 b64ToBuffer，在 ctx 内执行。
const b64ToBufferSrc = `function b64ToBuffer(b64){
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return buf;
}`;
vm.runInContext(b64ToBufferSrc, ctx, { filename: 'b64ToBuffer.js' });
const ab = vm.runInContext('b64ToBuffer(window.CassiniGLBData.eyes)', ctx);
console.log('GLB bytes:', ab.byteLength, 'magic:', String.fromCharCode(...new Uint8Array(ab, 0, 4)));

new THREE.GLTFLoader().parse(ab, '', (gltf) => {
  const SRC = gltf.scene;

  console.log('\n=== 1) 原始 GLB 系（未映射，米）===');
  {
    const node = SRC.getObjectByName('huygens_probe').clone(true);
    const holder = new THREE.Group();
    holder.add(node);
    const r = shapeInfo(holder);
    console.log(' 顶点数 / 包围盒 size :', r.n, fmt(r.box.getSize(new THREE.Vector3()), 4));
    console.log(' 包围盒 min/max       :', fmt(r.box.min, 3), '/', fmt(r.box.max, 3));
    console.log(' 均值(质心)           :', fmt(r.mean, 4));
    console.log(' 长轴(主成分)         :', fmt(r.axis));
    console.log(' 长轴·GLB X 夹角      :', ang(r.axis, new THREE.Vector3(1, 0, 0)), '°');
    console.log(' 长轴·GLB Y 夹角      :', ang(r.axis, new THREE.Vector3(0, 1, 0)), '°');
    console.log(' 长轴·GLB Z 夹角      :', ang(r.axis, new THREE.Vector3(0, 0, 1)), '°');
    const sub = [];
    node.traverse((o) => {
      if (!o.isMesh) return;
      const bx = new THREE.Box3().setFromObject(o);
      sub.push({ name: o.name || o.type,
                 c: bx.getCenter(new THREE.Vector3()), s: bx.getSize(new THREE.Vector3()) });
    });
    console.log(' 子网格（按包围盒最长边排序）：');
    sub.sort((a, b) => Math.max(b.s.x, b.s.y, b.s.z) - Math.max(a.s.x, a.s.y, a.s.z));
    for (const s of sub) {
      console.log('   ', s.name.padEnd(14), 'c=', fmt(s.c, 3), 's=', fmt(s.s, 3));
    }
  }

  console.log('\n=== 2) 经 Q_GLB 映射（= asm 内容，结构系，米）===');
  {
    const node = SRC.getObjectByName('huygens_probe').clone(true);
    const asm = new THREE.Group();
    asm.quaternion.copy(Q_GLB);
    asm.add(node);
    const r = shapeInfo(asm);
    console.log(' 包围盒 min/max :', fmt(r.box.min, 3), '/', fmt(r.box.max, 3));
    console.log(' 质心           :', fmt(r.mean, 4));
    console.log(' 长轴(主成分)   :', fmt(r.axis));
    console.log(' 长轴·结构 +X   :', ang(r.axis, new THREE.Vector3(1, 0, 0)), '°   (RTG 桁架方向)');
    console.log(' 长轴·结构 +Y   :', ang(r.axis, new THREE.Vector3(0, 1, 0)), '°');
    console.log(' 长轴·结构 +Z   :', ang(r.axis, new THREE.Vector3(0, 0, 1)), '°   (HGA 指向轴)');
  }

  console.log('\n=== 3) wrapProbe 当前实现（asm = Q_GLB × 0.001，无预旋转）===');
  const wrapAxes = {};
  {
    const node = SRC.getObjectByName('huygens_probe').clone(true);
    const wrap = new THREE.Group(), spin = new THREE.Group(), asm = new THREE.Group();
    asm.quaternion.copy(Q_GLB);
    asm.scale.setScalar(0.001);
    asm.add(node); spin.add(asm); wrap.add(spin);
    const r = shapeInfo(wrap);
    wrapAxes.axis = r.axis.clone(); wrapAxes.mean = r.mean.clone();
    console.log(' wrap 系质心    :', fmt(r.mean, 8));
    console.log(' 长轴(主成分)   :', fmt(r.axis));
    console.log(' 长轴·wrap +X   :', ang(r.axis, new THREE.Vector3(1, 0, 0)), '°');
    console.log(' 长轴·wrap +Y   :', ang(r.axis, new THREE.Vector3(0, 1, 0)), '°');
    console.log(' 长轴·wrap +Z   :', ang(r.axis, new THREE.Vector3(0, 0, 1)), '°   ← spin.rotation.z 绕此轴');
  }

  console.log('\n=== 4) 结论 ===');
  const a = wrapAxes.axis;
  const degZ = Math.acos(Math.min(1, Math.abs(a.clone().normalize().dot(new THREE.Vector3(0, 0, 1))))) * 180 / Math.PI;
  if (degZ < 15) console.log(' 长轴≈wrap +Z → spin.rotation.z 正确，问题在 setFromUnitVectors 的横滚未定。');
  else console.log(' 长轴≠wrap +Z（偏离 ' + degZ.toFixed(2) + '°）→ spin.rotation.z 绕错轴，'
    + '需在 asm 内先做预旋转把长轴转到 wrap ±Z，或改用「绕真实长轴」的四元数复合。');
}, (e) => { console.error('解析失败', e); process.exit(1); });

function fmt(v, d = 4) { return `(${v.x.toFixed(d)}, ${v.y.toFixed(d)}, ${v.z.toFixed(d)})`; }
function ang(u, v) {
  return (Math.acos(Math.min(1, Math.abs(u.clone().normalize().dot(v)))) * 180 / Math.PI).toFixed(2);
}
