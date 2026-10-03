/* 针对性诊断「分离后自旋轴是否正确」——直接取探测器真实顶点，逐帧测量：
 *   A) 大底边缘顶点在 wrap 系中绕「哪个点」划圆（用三点定圆求实际旋转中心）；
 *   B) 该实际旋转中心是否 = 大底圆心（= 回转轴）；
 *   C) 质心是否在自旋中漂移（应不动）；
 *   D) probe.position 在 wrap 系对应模型的哪个点（挂点 or 质心）。
 *
 * 用法：node tools/diag_huygens_spinaxis.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const J2000_MS = 946728000000;

function b64Arr(b64, T) { const b = Buffer.from(b64, 'base64');
  return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }

const stubCtx2d = () => { const noop = () => {}; return {
  fillStyle: '', globalAlpha: 1, globalCompositeOperation: '',
  createLinearGradient: () => ({ addColorStop: noop }),
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: noop, drawImage: noop, fillRect: noop,
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }; };
const stubCanvas = () => ({ width: 1, height: 1, getContext: () => stubCtx2d(), style: {} });
const stubEl = () => ({ classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
  style: {}, appendChild: () => {}, addEventListener: () => {}, textContent: '' });

const ctx = { window: {}, console, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  document: { createElement: (t) => (t === 'canvas' ? stubCanvas() : stubEl()), getElementById: () => stubEl() },
  performance: { now: () => Date.now() }, requestAnimationFrame: () => 0 };
ctx.globalThis = ctx; ctx.self = ctx;
ctx.createImageBitmap = () => Promise.reject(new Error('skip'));
vm.createContext(ctx);
vm.runInContext(`function b64ToBuffer(b64){var bin=atob(b64);var buf=new ArrayBuffer(bin.length);var u8=new Uint8Array(buf);for(var i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);return buf;}`,
  ctx, { filename: 'helpers.js' });

vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/models.js'), 'utf8'), ctx, { filename: 'models.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/cassini_data.js'), 'utf8'), ctx, { filename: 'cassini_data.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/moons_data.js'), 'utf8'), ctx, { filename: 'moons_data.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib/three.min.js'), 'utf8'), ctx, { filename: 'three.min.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib/GLTFLoader.js'), 'utf8'), ctx, { filename: 'GLTFLoader.js' });
const THREE = ctx.THREE || ctx.window.THREE;

vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/cassini_model.js'), 'utf8'), ctx, { filename: 'cassini_model.js' });

const DATA = ctx.window.CASSINI_DATA;
const HUY = DATA.spacecraft.cassini.huygens;
const registry = new Map(); const scene = new THREE.Scene();
const camWorld = { x: 0, y: 0, z: 0 };
function mkTrack(segs) { const list = segs.map((s) => ({ t0: s.t0, dt: s.dt, n: s.n, xyz: b64Arr(s.d, Float32Array) }));
  return { at(t, out) { let seg = null;
    for (const s of list) { const end = s.t0 + s.dt * (s.n - 1); if (t >= s.t0 && t <= end) { seg = s; break; } }
    if (!seg) seg = list.reduce((a, b) => { const da = Math.max(a.t0 - t, t - (a.t0 + a.dt * (a.n - 1)), 0);
      const db = Math.max(b.t0 - t, t - (b.t0 + b.dt * (b.n - 1)), 0); return db < da ? b : a; });
    const f = Math.max(0, Math.min((t - seg.t0) / seg.dt, seg.n - 1));
    const i = Math.min(seg.n - 2, Math.floor(f)); const a = f - i, o = i * 3, o2 = (i + 1) * 3;
    out[0] = seg.xyz[o] + (seg.xyz[o2] - seg.xyz[o]) * a; out[1] = seg.xyz[o + 1] + (seg.xyz[o2 + 1] - seg.xyz[o + 1]) * a;
    out[2] = seg.xyz[o + 2] + (seg.xyz[o2 + 2] - seg.xyz[o + 2]) * a; return out; } }; }
const bodies = DATA.bodies; const MOONS = (ctx.window.MOONS_DATA && ctx.window.MOONS_DATA.bodies) || {};
const PARENT = { moon: 'earth', titan: 'saturn', enceladus: 'saturn', iapetus: 'saturn', rhea: 'saturn', dione: 'saturn', tethys: 'saturn', mimas: 'saturn' };
for (const [name, bd] of Object.entries(bodies)) { if (!bd.segs) continue; registry.set(name, { track: mkTrack(bd.segs), world: [0,0,0], radius: bd.radiusKm||1 }); }
for (const [name, bd] of Object.entries(MOONS)) { if (!bd.segs) continue; registry.set(name, { track: mkTrack(bd.segs), world: [0,0,0], radius: bd.radiusKm||1, parent: PARENT[name] }); }
const eclToThree = (v) => [v[0], v[2], -v[1]];

const trailT = b64Arr(DATA.spacecraft.cassini.trailT, Float64Array);
const trailN = DATA.spacecraft.cassini.trailN;
const trailXYZ = b64Arr(DATA.spacecraft.cassini.trail, Float32Array);
const trailThree = new Float64Array(trailN * 3);
for (let i = 0; i < trailN; i++) { const w = eclToThree([trailXYZ[i*3], trailXYZ[i*3+1], trailXYZ[i*3+2]]);
  trailThree[i*3]=w[0]; trailThree[i*3+1]=w[1]; trailThree[i*3+2]=w[2]; }
function cassiniPosAt(t, out) { let lo=0, hi=trailN-1;
  if (t <= trailT[0]) { lo=0; hi=1; } else if (t >= trailT[trailN-1]) { lo=trailN-2; hi=trailN-1; }
  else { while (hi-lo>1) { const m=(lo+hi)>>1; if (trailT[m]<=t) lo=m; else hi=m; } }
  const a=(t-trailT[lo])/(trailT[hi]-trailT[lo]||1); const o=lo*3, o2=hi*3;
  out[0]=trailThree[o]+(trailThree[o2]-trailThree[o])*a; out[1]=trailThree[o+1]+(trailThree[o2+1]-trailThree[o+1])*a;
  out[2]=trailThree[o+2]+(trailThree[o2+2]-trailThree[o+2])*a; return out; }

vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/attitude_data.js'), 'utf8'), ctx, { filename: 'attitude_data.js' });
const modelQuat = (() => { const A = ctx.window.CASSINI_ATT; const T = b64Arr(A.t, Float64Array), Q = b64Arr(A.q, Float32Array);
  const t = HUY.sepEt; let lo=0, hi=T.length-1;
  if (t<=T[0]){lo=0;hi=1;} else if (t>=T[T.length-1]){lo=T.length-2;hi=T.length-1;}
  else { while (hi-lo>1){const m=(lo+hi)>>1; if(T[m]<=t)lo=m; else hi=m;} }
  const s=(t-T[lo])/(T[hi]-T[lo]||1);
  const a=new THREE.Quaternion(Q[lo*4],Q[lo*4+1],Q[lo*4+2],Q[lo*4+3]);
  const b=new THREE.Quaternion(Q[hi*4],Q[hi*4+1],Q[hi*4+2],Q[hi*4+3]);
  return a.slerp(b, Math.min(1, Math.max(0, s))); })();

const markerTex = () => { const tex = new THREE.Texture(stubCanvas()); tex.needsUpdate = true; return tex; };
const huyCtx = { scene, registry, eclToThree, cassiniPosAt, markerTexture: markerTex,
  viewOccluded: () => false, modelFadeK: () => 0,
  trailOpts: () => ({ future: true, mode: 'all', cassini: true, huygens: true }),
  cassiniQuatAt: () => modelQuat };
ctx.window.CassiniScene = { screenPosOf: () => ({ x:0,y:0,dist:1e6,behind:false }), camera: { fov: 45 } };
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/huygens.js'), 'utf8'), ctx, { filename: 'huygens.js' });
const HuygensVis = ctx.window.HuygensVis;

const tmpV = [0,0,0];
function stepWorld(t) { for (const [, e] of registry) { if (!e.track) continue; e.track.at(t, tmpV); const w = eclToThree(tmpV);
  if (e.parent) { const p = registry.get(e.parent); e.world[0]=p.world[0]+w[0]; e.world[1]=p.world[1]+w[1]; e.world[2]=p.world[2]+w[2]; }
  else { e.world[0]=w[0]; e.world[1]=w[1]; e.world[2]=w[2]; } } }

ctx.window.CassiniModel.load((parts) => {
  const { probe } = parts;
  scene.add(probe); probe.visible = true;
  HuygensVis.init(huyCtx, probe);

  const spin = probe.userData.spin;
  const asm = spin.children[0];
  const C0 = probe.userData.centroid.clone();
  const A0 = probe.userData.spinAxisPt ? probe.userData.spinAxisPt.clone() : new THREE.Vector3();

  console.log('=== 静止态几何（wrap 系，km）===');
  console.log(' centroid  =', f(C0, 9), '(模型质心/包围盒中心)');
  console.log(' spinAxisPt=', f(A0, 9), '(大底圆心 = 回转轴 XZ)');

  // 取几何上的真实顶点：大底外缘（r 最大）的一个顶点，在 wrap 系
  probe.updateMatrixWorld(true);
  const verts = [];
  probe.traverse((o) => { if (!o.isMesh || !o.geometry) return; const pa = o.geometry.attributes.position; if (!pa) return;
    for (let i = 0; i < pa.count; i++) verts.push(new THREE.Vector3().fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld)); });
  // 选离轴最远（XZ 半径最大）的顶点，且取两个对径点观察
  let vEdge = null, vEdge2 = null, rBest = -1;
  for (const p of verts) { const r = Math.hypot(p.x - A0.x, p.z - A0.z); if (r > rBest) { rBest = r; vEdge = p.clone(); } }
  const dir = new THREE.Vector3(vEdge.x - A0.x, 0, vEdge.z - A0.z).normalize();
  for (const p of verts) { const d = new THREE.Vector3(p.x - A0.x, 0, p.z - A0.z);
    const r = d.length(); if (r < 1e-6) continue; const cos = d.clone().normalize().dot(dir);
    if (cos < -0.98) { vEdge2 = p.clone(); break; } }
  console.log(' 大底外缘顶点 v1 (wrap):', f(vEdge, 9), ' 离轴半径 =', (rBest*1000).toFixed(4), 'mm');
  if (vEdge2) console.log(' 对径点 v2 (wrap)      :', f(vEdge2, 9));

  // 用顶点索引跟踪：记录顶点在 wrap 系的「体坐标」（spin 之前），逐帧看 wrap 系位置
  // 实现：用 asm.localToWorld 反推不适用（自旋会变）——改为用 spin 的逆变换。
  // 记录点 = spin 系坐标（不变），每帧映射回 wrap 系。
  spin.updateMatrixWorld(true);
  const invSpin = new THREE.Matrix4().copy(spin.matrixWorld).invert();
  const v1InSpin = vEdge.clone().applyMatrix4(invSpin);
  const v2InSpin = vEdge2 ? vEdge2.clone().applyMatrix4(invSpin) : null;
  console.log(' v1 在 spin 系（体坐标，应恒定）:', f(v1InSpin, 9));

  const SEP = HUY.sepEt;
  const PERIOD = 60 / 7;    // 7 rpm → 8.571 s
  const samples = [];
  for (let i = 0; i <= 12; i++) {
    const dt = i * PERIOD / 12;
    const t = SEP + 60 + dt;
    stepWorld(t); HuygensVis.update(t, camWorld, 0.83, 900, 0);
    probe.updateMatrixWorld(true);
    // v1 的 wrap 系位置 = spin.matrixWorld · v1InSpin，再经 wrap 世界矩阵逆。
    const pWorld = v1InSpin.clone().applyMatrix4(spin.matrixWorld);
    const invWrap = new THREE.Matrix4().copy(probe.matrixWorld).invert();
    const pW = pWorld.clone().applyMatrix4(invWrap);       // wrap 系
    samples.push({ dt, p: pW, spinY: spin.rotation.y, pos: spin.position.clone() });
  }

  console.log('\n=== 大底外缘顶点 v1 在一个自旋周期内的 wrap 系轨迹 ===');
  console.log('  Δt(s)   x(mm)     z(mm)      y(mm)     spin.rot.y(°)');
  for (const s of samples) console.log(`  ${s.dt.toFixed(3).padStart(5)}  ${(s.p.x*1000).toFixed(4).padStart(9)}  ${(s.p.z*1000).toFixed(4).padStart(9)}  ${(s.p.y*1000).toFixed(4).padStart(9)}  ${(s.spinY*180/Math.PI).toFixed(1).padStart(6)}`);

  // 三点定圆：取 θ=0°、120°、240° 三点，求实际旋转中心（在 XZ 平面）
  function circle3(p1, p2, p3) {
    const ax=p1.x, az=p1.z, bx=p2.x, bz=p2.z, cx=p3.x, cz=p3.z;
    const d = 2*(ax*(bz-cz)+bx*(cz-az)+cx*(az-bz));
    if (Math.abs(d) < 1e-18) return null;
    const ux = ((ax*ax+az*az)*(bz-cz)+(bx*bx+bz*bz)*(cz-az)+(cx*cx+cz*cz)*(az-bz))/d;
    const uz = ((ax*ax+az*az)*(cx-bx)+(bx*bx+bz*bz)*(ax-cx)+(cx*cx+cz*cz)*(bx-ax))/d;
    return new THREE.Vector3(ux, 0, uz);
  }
  const c = circle3(samples[0].p, samples[4].p, samples[8].p);
  console.log('\n=== 实际旋转中心（由 v1 的三点定圆求得，wrap 系，mm）===');
  if (c) {
    console.log(' 实测旋转中心 =', `(${(c.x*1000).toFixed(4)}, ${(c.z*1000).toFixed(4)})`);
    console.log(' 大底圆心 A0  =', `(${(A0.x*1000).toFixed(4)}, ${(A0.z*1000).toFixed(4)})`);
    console.log(' 质心 C0 XZ   =', `(${(C0.x*1000).toFixed(4)}, ${(C0.z*1000).toFixed(4)})`);
    console.log(' 偏离大底圆心 =', (Math.hypot(c.x-A0.x, c.z-A0.z)*1000).toFixed(4), 'mm  ← 应≈0，否则轴位置错');
  }

  // 质心漂移：每帧求模型质心（包围盒中心世界位置 → wrap 系）
  console.log('\n=== 质心 / 定位点在自旋中是否漂移（wrap 系，mm）===');
  const cenFirst = (() => { const b = new THREE.Box3().setFromObject(probe);
    const inv = new THREE.Matrix4().copy(probe.matrixWorld).invert();
    return b.getCenter(new THREE.Vector3()).applyMatrix4(inv); })();
  let maxDrift = 0;
  for (const s of samples) {
    // 用当前帧的包围盒中心
    const t = SEP + 60 + s.dt; stepWorld(t); HuygensVis.update(t, camWorld, 0.83, 900, 0); probe.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(probe);
    const inv = new THREE.Matrix4().copy(probe.matrixWorld).invert();
    const ce = b.getCenter(new THREE.Vector3()).applyMatrix4(inv);
    maxDrift = Math.max(maxDrift, ce.distanceTo(cenFirst));
  }
  console.log(' 质心最大漂移 =', (maxDrift*1000).toFixed(5), 'mm （应≈0，说明定位点稳定）');

  console.log('\n=== probe.position 在 wrap 系对应的模型点 ===');
  console.log(' probe.position 把 wrap 原点放到 worldAt(t) 上；wrap 原点 = GLB 挂点。');
  console.log(' 模型质心相对挂点偏移 =', (C0.length()*1000).toFixed(4), 'mm  → 质心并不严格落在 relCass 参考点上');
}, 0);

function f(v, d = 4) { const p = (x) => (Math.abs(x) < 1e-12 ? 0 : x).toFixed(d); return `(${p(v.x)}, ${p(v.y)}, ${p(v.z)})`; }
