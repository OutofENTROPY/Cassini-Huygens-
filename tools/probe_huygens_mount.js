/* 离线核验 Huygens 挂点几何（无需浏览器）：
 * 解出 data/models.js 的 GLB，打印 huygens_probe 节点的局部变换、在 Cassini
 * 结构系（Q_GLB 映射后、米→km 前）中的挂点坐标与包围盒，供 js/cassini_model.js
 * 的 wrapProbe 几何约定对照。
 * 用法：node tools/probe_huygens_mount.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const vm = require('vm');

// 最小 DOM 桩：models.js 是纯 JS 赋值，但 GLTFLoader 需要 atob / DataView
const ctx = { window: {}, console, atob: (s) => Buffer.from(s, 'base64').toString('binary') };
ctx.globalThis = ctx;
vm.createContext(ctx);

function load(file, name) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  vm.runInContext(src, ctx, { filename: file });
  return ctx.window[name] || ctx[name];
}

load('data/models.js', 'CassiniGLBData');
global.window = ctx.window;
global.atob = ctx.atob;

// three.min.js（r147，UMD）——挂到 global
const threeSrc = fs.readFileSync(path.join(ROOT, 'lib/three.min.js'), 'utf8');
vm.runInNewContext(threeSrc, global, { filename: 'three.min.js' });
const THREE = global.THREE;
if (!THREE) { console.error('THREE 未加载'); process.exit(1); }

// GLTFLoader 依赖 THREE
global.THREE = THREE;
// 贴图解码无关几何，桩掉即可（浏览器里由 ImageBitmapLoader 承担）
global.self = global;
global.createImageBitmap = () => Promise.reject(new Error('skip'));
const loaderSrc = fs.readFileSync(path.join(ROOT, 'lib/GLTFLoader.js'), 'utf8');
vm.runInNewContext(loaderSrc, global, { filename: 'GLTFLoader.js' });

const b64 = ctx.window.CassiniGLBData.eyes;
const buf = Buffer.from(b64, 'base64');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const Q_GLB = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(
  0, 0, -1, 0,
  -1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 0, 1));

new THREE.GLTFLoader().parse(ab, '', (gltf) => {
  const src = gltf.scene;
  const node = src.getObjectByName('huygens_probe');
  if (!node) { console.error('未找到 huygens_probe'); process.exit(1); }

  console.log('=== huygens_probe 节点 ===');
  console.log(' parent          :', node.parent && (node.parent.name || node.parent.type));
  console.log(' type / children :', node.type, node.children.length);
  console.log(' position (GLB m):', fmt(node.position));
  console.log(' quaternion      :', fmt(node.quaternion, 6));
  console.log(' scale           :', fmt(node.scale, 6));

  // GLB 系：包围盒（米）
  const gb = new THREE.Box3().setFromObject(node);
  console.log('\n GLB 包围盒 (m)  : min', fmt(gb.min, 3), ' max', fmt(gb.max, 3));
  console.log(' GLB 中心 (m)    :', fmt(gb.getCenter(new THREE.Vector3()), 3));

  // 结构系（Q_GLB 映射后，米）
  const asm = new THREE.Group();
  asm.quaternion.copy(Q_GLB);
  asm.add(node.clone(true));
  asm.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(asm);
  const c = box.getCenter(new THREE.Vector3());
  console.log('\n=== 映射到 Cassini 结构系（+Z=HGA, +X=RTG 桁架, 米）===');
  console.log(' 包围盒          : min', fmt(box.min, 3), ' max', fmt(box.max, 3));
  console.log(' 中心 / 挂点原点 :', fmt(c, 4), ' | 原点', fmt(new THREE.Vector3(0, 0, 0)));
  console.log(' 质心-原点距 (m) :', c.length().toFixed(4));
  console.log(' 朝向往 +Y 1 m   :', fmt(c.clone().add(new THREE.Vector3(0, 1, 0)), 3));

  // 组合体全尺寸（对照）
  const stackBox = new THREE.Box3().setFromObject(src);
  console.log('\n=== 组合体（GLB 系，米）===');
  console.log(' 包围盒          : min', fmt(stackBox.min, 2), ' max', fmt(stackBox.max, 2));

  // 自旋轴候选：结构系各轴与「挂点→质心」的夹角
  console.log('\n=== 自旋轴候选（结构系）===');
  const dir = c.clone().normalize();
  for (const [lbl, ax] of [['+X (RTG 桁架)', new THREE.Vector3(1, 0, 0)],
                            ['+Y', new THREE.Vector3(0, 1, 0)],
                            ['+Z (HGA)', new THREE.Vector3(0, 0, 1)]]) {
    const deg = THREE.MathUtils.radToDeg(ax.angleTo(dir));
    console.log(` ${lbl.padEnd(14)}: 与质心方向夹角 ${deg.toFixed(2)}°`);
  }
  console.log(' 挂点→质心单位向量:', fmt(dir, 4));
}, (e) => { console.error('解析失败', e); process.exit(1); });

function fmt(v, d = 4) {
  return `(${v.x.toFixed(d)}, ${v.y.toFixed(d)}, ${v.z.toFixed(d)})`;
}
