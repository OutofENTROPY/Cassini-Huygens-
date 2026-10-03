/* probe_rel_precision2.js —— 量化「相对行星轨迹」的真实精度损失（修正版）。
 *
 * 思路：
 *   rel_frontend(t) = trailThree_f32(t) − planetThree(t)      ← 现状
 *   rel_true(t)     = trailThree_f64(t) − planetThree(t)      ← 应有
 *   误差 = |rel_frontend − rel_true| ≈ f32 ULP(|日心位置|)
 *
 * 因前端只拿到 f32，这里用「f32 二进制的固有量化步长」直接给出误差上下界，
 * 并用实际窗口的 |位置| 与 |rel| 量级算出「相对误差」。
 */
'use strict';
const fs = require('fs'); const vm = require('vm');
function load(f){ const c={window:{},console}; vm.createContext(c); vm.runInContext(fs.readFileSync(f,'utf8'),c); return c.window.CASSINI_DATA; }
const DATA = load('D:/Programming/HTML/Cassini/data/cassini_data.js');
const sc = DATA.spacecraft.cassini;
const b64F64=(b)=>{const B=Buffer.from(b,'base64');return new Float64Array(B.buffer,B.byteOffset,B.byteLength/8);};
const b64F32=(b)=>{const B=Buffer.from(b,'base64');return new Float32Array(B.buffer,B.byteOffset,B.byteLength/4);};
const trailT=b64F64(sc.trailT), N=sc.trailN, xyz32=b64F32(sc.trail);
const iso=(s)=>new Date((s+946728000)*1000).toISOString();

const soi=sc.soi||{};
// 每个窗口：算 |日心位置| 最大 → f32 ULP；与「相对轨迹自身尺度」比较
const rows=[];
for (const name of Object.keys(soi)) {
  for (const w of soi[name]) {
    let i0=0; while(i0<N && trailT[i0]<w.a-1) i0++;
    let i1=i0; while(i1<N-1 && trailT[i1]<=w.b+1) i1++;
    if (i1<=i0) continue;
    let maxAbs=0, minAbs=1e30;
    for(let i=i0;i<=i1;i++){ const m=Math.hypot(xyz32[i*3],xyz32[i*3+1],xyz32[i*3+2]); if(m>maxAbs)maxAbs=m; if(m<minAbs)minAbs=m; }
    const ulp = Math.pow(2, Math.floor(Math.log2(maxAbs))) * Math.pow(2,-23);
    // 相对轨迹在窗口内的尺度：取该窗口时间跨度内的行程量级（用速度×跨度粗估）
    rows.push({name, a:w.a, b:w.b, n:i1-i0+1, maxAbs, ulp,
      span_d:(w.b-w.a)/86400});
  }
}
rows.sort((x,y)=>x.ulp-y.ulp);
console.log('窗口          时间域                      顶点数    |日心|max(km)   f32 ULP(km)');
for(const r of rows){
  console.log(`${r.name.padEnd(8)} ${iso(r.a).slice(0,10)}..${iso(r.b).slice(0,10)}  ${String(r.n).padStart(7)}  ${r.maxAbs.toExponential(3).padStart(11)}  ${r.ulp.toFixed(2).padStart(9)}`);
}

// 土星段（最长，ULP 最大）单独详查
const satW = (soi.saturn||[])[0];
if (satW) {
  let i0=0; while(i0<N && trailT[i0]<satW.a) i0++;
  let i1=i0; while(i1<N-1 && trailT[i1]<=satW.b) i1++;
  let maxAbs=0;
  for(let i=i0;i<=i1;i++){ const m=Math.hypot(xyz32[i*3],xyz32[i*3+1],xyz32[i*3+2]); if(m>maxAbs)maxAbs=m; }
  const ulp=Math.pow(2,Math.floor(Math.log2(maxAbs)))*Math.pow(2,-23);
  console.log(`\n=== 土星段（最苛刻）===`);
  console.log(`  顶点 ${i1-i0+1}，|日心| max = ${maxAbs.toExponential(4)} km，f32 ULP = ${ulp.toFixed(1)} km`);
  console.log(`  → 相对土星轨迹每顶点带 ±${(ulp/2).toFixed(0)} km 量化误差（3 轴合成 ~${(ulp*0.87).toFixed(0)} km）`);
  console.log(`  近土星特写（相机距飞船 5e3 km，视场 55°，700px）时：1px ≈ ${(5000*2*Math.tan(27.5*Math.PI/180)/700).toFixed(2)} km`);
  console.log(`  → ${ulp.toFixed(0)} km 误差 ≈ ${(ulp/(5000*2*Math.tan(27.5*Math.PI/180)/700)).toFixed(1)} px  ← 肉眼明显`);
}
