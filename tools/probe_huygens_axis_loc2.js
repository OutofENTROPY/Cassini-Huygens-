/* 复核：Huygens 回转轴相对「挂点（wrap 原点）」的偏移，及其在真实物理尺寸下的含义。
 *
 * 已知：wrap 系 = asm(Q_GLB × 0.001) 之上、无平移。wrap 原点 = GLB 原点 = 组合体里
 * huygens_probe 节点的挂点。probe_huygens_axis_loc.js 测得回转轴在 XZ 上位于
 * (x≈0, z≈−1.03 mm)，即「挂点落在探测器边缘、距回转轴 1.03 mm」。
 *
 * 本脚本核对：
 *  1) 该偏移在 GLB 原始（米）系中的方向（经 Q_GLB 反解回 GLB 轴）；
 *  2) 与真实惠更斯几何对照：φ2.615 大底、0.806 厚，挂点侧挂 → 挂点应在母线（边缘）
 *     附近而非轴心，1.03 mm 的 z 偏移量级自洽吗；
 *  3) 结论：自旋必须绕「真实回转轴」而非 wrap 原点，需要把 spin 组平移到轴上。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

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
vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib/three.min.js'), 'utf8'), ctx, { filename: 'three.min.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib/GLTFLoader.js'), 'utf8'), ctx, { filename: 'GLTFLoader.js' });
const THREE = ctx.THREE || ctx.window.THREE;
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/cassini_model.js'), 'utf8'), ctx, { filename: 'cassini_model.js' });

ctx.window.CassiniModel.load((parts) => {
  const wrap = parts.probe;
  wrap.position.set(0,0,0); wrap.quaternion.identity(); wrap.scale.set(1,1,1);
  wrap.userData.spin.position.set(0,0,0); wrap.userData.spin.quaternion.identity();
  wrap.updateMatrixWorld(true);

  const pts = [];
  wrap.traverse((o) => { if (!o.isMesh || !o.geometry) return;
    const pa = o.geometry.attributes.position; if (!pa) return;
    for (let i = 0; i < pa.count; i++) pts.push(new THREE.Vector3().fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld)); });

  const box = new THREE.Box3().setFromPoints(pts);
  const cen = box.getCenter(new THREE.Vector3());

  // 更稳健的轴位置：对「大底那一片」单独求圆心。取 r_max 最大的若干片，
  // 用该片内顶点拟合圆（心 = 最小二乘圆心）。
  const y0 = box.min.y, y1 = box.max.y, N = 40;
  const bins = Array.from({length:N},()=>({pts:[]}));
  for (const p of pts) { let k = Math.floor((p.y-y0)/(y1-y0)*N); k=Math.max(0,Math.min(N-1,k)); bins[k].pts.push(p); }
  // 选顶点最多的片（即大底所在片）
  let bestK = 0, bestN = 0;
  bins.forEach((b,k)=>{ if (b.pts.length > bestN) { bestN = b.pts.length; bestK = k; } });

  function circleFit(ps) {   // 代数最小二乘圆 (Kasa)
    let sx=0,sy=0,sxx=0,syy=0,sxy=0,sxz=0,syz=0,sz=0,n=ps.length;
    for (const p of ps){ const x=p.x,z=p.z,xx=x*x,zz=z*z; sx+=x;sy+=z;sxx+=xx;syy+=zz;sxy+=x*z;
      const s=xx+zz; sxz+=x*s; syz+=z*s; sz+=s; }
    const A=[[sxx-sx*sx/n, sxy-sx*sy/n],[sxy-sx*sy/n, syy-sy*sy/n]];
    const B=[(sxz-sx*sz/n)/2, (syz-sy*sz/n)/2];
    const det=A[0][0]*A[1][1]-A[0][1]*A[1][0];
    const cx=(B[0]*A[1][1]-A[0][1]*B[1])/det, cz=(A[0][0]*B[1]-B[0]*A[1][0])/det;
    return [cx, cz];
  }

  console.log('=== 用 Kasa 圆拟合求大底圆心（= 回转轴真实位置）===');
  for (const k of [bestK, Math.floor(N*0.5), Math.floor(N*0.25), Math.floor(N*0.75)]) {
    const b = bins[k]; if (b.pts.length < 6) continue;
    const [cx, cz] = circleFit(b.pts);
    console.log(`  y片${String(k).padStart(2)} (n=${String(b.pts.length).padStart(4)}): 圆心 XZ = (${cx.toFixed(6)}, ${cz.toFixed(6)}) m`);
  }

  console.log('\n=== 关键几何（wrap 系，米）===');
  console.log(' 挂点(wrap 原点) = (0, 0, 0)');
  console.log(' 包围盒中心      =', `(${cen.x.toFixed(6)}, ${cen.y.toFixed(6)}, ${cen.z.toFixed(6)})`);
  console.log(' 尺寸           = φ' + (box.max.x-box.min.x).toFixed(4) + ' m × 厚 ' + (box.max.y-box.min.y).toFixed(4) + ' m');

  // 回转轴 → GLB 原始轴的映射（Q_GLB 的逆）：wrap = Q_GLB · GLB·0.001
  const invQ = ctx.window.CassiniModel.__x;   // 未必导出；改用手算
  // 手算：Q_GLB 行主序 [0,0,-1; -1,0,0; 0,1,0] ⇒ GLB+Z→wrap-X, GLB+X→wrap-Y, GLB+Y→wrap-Z
  // 逆映射：wrap(x,y,z) → GLB(-z, x, -y)？ 由 wrap = M·glb，M=[0,0,-1; -1,0,0; 0,1,0]
  //   wrap.x = -glb.z, wrap.y = -glb.x, wrap.z = glb.y
  //   反解：glb.z = -wrap.x, glb.x = -wrap.y, glb.y = wrap.z
  const glbOf = (v) => [-v.y, v.z, -v.x];
  // 回转轴方向：wrap +Y → GLB ?
  const axisW = [0, 1, 0];
  console.log(' 回转轴方向 wrap(0,1,0) → GLB', f3(glbOf(axisW)), '（= GLB +Z）');
  // 轴心（取大底片圆心）→ GLB
  const [acx, acz] = circleFit(bins[bestK].pts);
  const axW = new THREE.Vector3(acx, 0, acz);
  console.log(' 大底圆心 wrap', f(axW, 6), '→ GLB', f3(glbOf([axW.x, axW.y, axW.z])));
  console.log(' 轴心相对挂点偏移（wrap）|Δ| =', (Math.hypot(acx, acz) * 1000).toFixed(3), 'mm');
}, 0);

function f(v, d = 4) { return `(${v.x.toFixed(d)}, ${v.y.toFixed(d)}, ${v.z.toFixed(d)})`; }
function f3(a) { return `(${a[0].toFixed(4)}, ${a[1].toFixed(4)}, ${a[2].toFixed(4)})`; }
