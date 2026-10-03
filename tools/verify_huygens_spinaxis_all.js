/* 全顶点同心性核验：自旋时「每个顶点都应绕同一条轴（大底圆心）划圆」。
 * 若轴位置/朝向有任何残余错误，不同顶点的旋转中心会散开（偏心陀螺症状）。
 *
 * 用法：node tools/verify_huygens_spinaxis_all.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

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
  trailOpts: () => ({ future: true, mode: 'all', cassini: true, huygens: true }), cassiniQuatAt: () => modelQuat };
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
  const SEP = HUY.sepEt;

  // 采样 24 个顶点的体坐标（在 spin 系），逐帧映回 wrap 系，求各自的旋转中心
  probe.updateMatrixWorld(true);
  const verts = [];
  const invSpin0 = new THREE.Matrix4().copy(spin.matrixWorld).invert();
  probe.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const pa = o.geometry.attributes.position; if (!pa) return;
    for (let i = 0; i < pa.count; i += 23) {
      const w = new THREE.Vector3().fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld);
      verts.push(w.applyMatrix4(invSpin0));   // spin 系体坐标
    }
  });
  console.log('采样顶点数 =', verts.length);

  const c0 = probe.userData.centroid;
  const period = 60 / 7;
  const SAMPLES = 12;
  function wrapPosAt(vSpin, t) {
    stepWorld(t); HuygensVis.update(t, camWorld, 0.83, 900, 0); probe.updateMatrixWorld(true);
    const w = vSpin.clone().applyMatrix4(spin.matrixWorld);
    return w.applyMatrix4(new THREE.Matrix4().copy(probe.matrixWorld).invert());
  }
  function circle3(p1, p2, p3) {
    const ax=p1.x, az=p1.z, bx=p2.x, bz=p2.z, cx=p3.x, cz=p3.z;
    const d = 2*(ax*(bz-cz)+bx*(cz-az)+cx*(az-bz)); if (Math.abs(d)<1e-18) return null;
    const ux = ((ax*ax+az*az)*(bz-cz)+(bx*bx+bz*bz)*(cz-az)+(cx*cx+cz*cz)*(az-bz))/d;
    const uz = ((ax*ax+az*az)*(cx-bx)+(bx*bx+bz*bz)*(ax-cx)+(cx*cx+cz*cz)*(bx-ax))/d;
    return new THREE.Vector3(ux, 0, uz);
  }
  let maxDev = 0, maxRadiusErr = 0, maxYDrift = 0;
  const ctrs = [];
  for (const vs of verts) {
    const pts = [];
    for (let k = 0; k < SAMPLES; k++) pts.push(wrapPosAt(vs, SEP + 60 + k * period / SAMPLES));
    const c = circle3(pts[0], pts[4], pts[8]);
    if (!c) continue;
    ctrs.push(c);
    maxDev = Math.max(maxDev, Math.hypot(c.x - c0.x, c.z - c0.z));
    // 半径恒定性
    let rmin = 1e9, rmax = -1e9;
    for (const p of pts) { const r = Math.hypot(p.x - c.x, p.z - c.z); rmin = Math.min(rmin, r); rmax = Math.max(rmax, r); }
    if (rmax > 1e-7) maxRadiusErr = Math.max(maxRadiusErr, (rmax - rmin) / rmax);
    for (const p of pts) maxYDrift = Math.max(maxYDrift, Math.abs(p.y - pts[0].y));
  }
  // 各顶点旋转中心彼此的离散程度
  let cxM = 0, czM = 0;
  for (const c of ctrs) { cxM += c.x; czM += c.z; }
  cxM /= ctrs.length; czM /= ctrs.length;
  let ctrSpread = 0;
  for (const c of ctrs) ctrSpread = Math.max(ctrSpread, Math.hypot(c.x - cxM, c.z - czM));

  console.log('\n=== 全顶点自旋一致性（wrap 系）===');
  console.log(' 各顶点旋转中心 vs 质心 XZ 最大偏离 :', (maxDev * 1000).toFixed(5), 'mm  （应 ≈ 0）');
  console.log(' 各顶点旋转中心彼此离散度（max）    :', (ctrSpread * 1000).toFixed(5), 'mm  （应 ≈ 0 → 同一轴）');
  console.log(' 单顶点轨迹半径恒定性（max 相对误差）:', (maxRadiusErr * 100).toFixed(5), '%  （应 ≈ 0 → 正圆）');
  console.log(' 单顶点轨迹 Y 漂移（max）           :', (maxYDrift * 1000).toFixed(5), 'mm  （应 ≈ 0 → 轴沿 Y，无锥摆）');
  console.log('\n 质心 XZ =', `(${(c0.x*1000).toFixed(5)}, ${(c0.z*1000).toFixed(5)})`,
    ' | 平均旋转中心 =', `(${(cxM*1000).toFixed(5)}, ${(czM*1000).toFixed(5)})`, ' mm');
}, 0);
