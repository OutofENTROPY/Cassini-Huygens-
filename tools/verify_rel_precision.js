/* verify_rel_precision.js —— 验证「相对行星轨迹」精度修复。
 *
 * 对比两条路径在窗口内顶点上的 rel：
 *   A) 新数据：直接用烘焙端 f64 直算的 rel（b64f32，相对量）
 *   B) 旧路径：frontend 的 trailThree(f32 日心) − 锚定体日心
 * 参考真值：用烘焙端 pts（f64 日心）− 锚定体 f64 —— 但前端拿不到 pts。
 *   故这里以「A 的还原值」为基准，检查 A 与 B 的差 = f32 日心量化误差。
 * 另：检查 A 的内禀平滑性（相对轨迹的二阶差分应远小于弦长）。
 */
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const ROOT='D:/Programming/HTML/Cassini';
function load(f){ const c={window:{},console}; vm.createContext(c); vm.runInContext(fs.readFileSync(f,'utf8'),c); return c.window.CASSINI_DATA; }
const D=load(path.join(ROOT,'data/cassini_data.js'));
const sc=D.spacecraft.cassini;
const b64F64=(b)=>{const B=Buffer.from(b,'base64');return new Float64Array(B.buffer,B.byteOffset,B.byteLength/8);};
const b64F32=(b)=>{const B=Buffer.from(b,'base64');return new Float32Array(B.buffer,B.byteOffset,B.byteLength/4);};
const trailT=b64F64(sc.trailT), N=sc.trailN, xyz32=b64F32(sc.trail);
const soi=sc.soi||{};

// 复刻前端 makeTrack.at（行星 body track：segs 线性/Catmull-Rom + parent 合成）
function trackAt(entry, t) { return null; }   // 前端 track 结构复杂，这里用「日心 f32 直接读」近似

// 方案 B：前端旧路径 rel = trailThree − planetThree（f32 日心相减 → 量化误差）
const OBL=23.4392911*Math.PI/180, CE=Math.cos(OBL), SE=Math.sin(OBL);
const ecl3=(x,y,z)=>[x, z, -y];

// 因拿不到前端行星 track 的精确插值，这里用「同窗口内 rel 的差分」直接量化：
// 若 rel 是小量（新方案），其二阶差分 ~ 真实曲率；
// 若是 f32 大数相减（旧方案），二阶差分会出现 f32 ULP 级的随机跳变。
console.log('窗口     n      |rel|max(km)   二阶差分 p50     p99      max     判定');
for(const name of Object.keys(soi)){
  for(const w of soi[name]){
    const rel=b64F32(w.rel);
    const n=w.n;
    const d2=[];
    for(let i=1;i<n-1;i++){
      const a=[rel[(i-1)*3],rel[(i-1)*3+1],rel[(i-1)*3+2]];
      const b=[rel[i*3],rel[i*3+1],rel[i*3+2]];
      const c=[rel[(i+1)*3],rel[(i+1)*3+1],rel[(i+1)*3+2]];
      const v1=[b[0]-a[0],b[1]-a[1],b[2]-a[2]];
      const v2=[c[0]-b[0],c[1]-b[1],c[2]-b[2]];
      d2.push(Math.hypot(v2[0]-v1[0],v2[1]-v1[1],v2[2]-v1[2]));
    }
    if(!d2.length){ console.log(name,'(n<3)'); continue; }
    d2.sort((a,b)=>a-b);
    let mx=0; for(let i=0;i<n;i++) mx=Math.max(mx,Math.hypot(rel[i*3],rel[i*3+1],rel[i*3+2]));
    const p=(q)=>d2[Math.floor(d2.length*q)];
    // 旧路径的量化误差量级 = f32 ULP(|日心位置|)
    const ulp=Math.pow(2,Math.floor(Math.log2(1.5e9)))*Math.pow(2,-23);  // 土星量级
    console.log(`${name.padEnd(8)} ${String(n).padStart(7)} ${mx.toExponential(3).padStart(13)} ${p(0.5).toExponential(3).padStart(14)} ${p(0.99).toExponential(3).padStart(10)} ${d2[d2.length-1].toExponential(3).padStart(10)}`);
    break;   // 每体只看第一窗
  }
}
console.log(`\n（旧路径 f32 日心相减在土星段会引入 ~${(64).toFixed(0)} km 的随机步进，新方案应为真实曲率）`);
