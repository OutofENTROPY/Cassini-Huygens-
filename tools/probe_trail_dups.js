/* probe_trail_dups.js —— 统计 trailT 中重复/极小间隔的顶点（冻结帧）。
 * 用法：node probe_trail_dups.js [loSec] [hiSec]
 */
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/Programming/HTML/Cassini';
function b64f64(b64) { const b = Buffer.from(b64, 'base64');
  return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
function b64f32(b64) { const b = Buffer.from(b64, 'base64');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
const txt = fs.readFileSync(path.join(ROOT, 'data/cassini_data.js'), 'utf8');
const D = JSON.parse(txt.match(/window\.CASSINI_DATA\s*=\s*(\{[\s\S]*\});?\s*$/)[1]);
const sc = D.spacecraft.cassini;
const trailT = b64f64(sc.trailT), N = sc.trailN;
const xyz = b64f32(sc.trail);
const eclToThree = (v) => [v[0], v[2], -v[1]];

const lo = process.argv[2] ? parseFloat(process.argv[2]) : -Infinity;
const hi = process.argv[3] ? parseFloat(process.argv[3]) : Infinity;

let dupExact=0, tiny=0, list=[];
const dtv=[];
for (let i=1;i<N;i++){
  const dt = trailT[i]-trailT[i-1];
  if (dt>=lo && dt<=hi) dtv.push(dt);
  if (dt===0){ dupExact++; if(list.length<40) list.push({i,t:trailT[i]}); }
  else if (dt<1e-9){ tiny++; }
}
console.log('N =', N);
console.log('exact duplicate timestamps dt==0 :', dupExact);
console.log('dt<1e-9 :', tiny);
console.log('first dups:', JSON.stringify(list));

// dt 分布
dtv.sort((a,b)=>a-b);
const q=(p)=>dtv.length? dtv[Math.floor(p*(dtv.length-1))] : null;
console.log('dt(s): min=%s p1=%s p50=%s p99=%s max=%s',
  q(0), q(0.01), q(0.5), q(0.99), q(1));

// 重复顶点位置与是否同坐标
console.log('--- dup detail (first 10) ---');
let shown=0;
for (let i=1;i<N && shown<10;i++){
  if (trailT[i]-trailT[i-1]===0){
    const a=eclToThree([xyz[(i-1)*3],xyz[(i-1)*3+1],xyz[(i-1)*3+2]]);
    const b=eclToThree([xyz[i*3],xyz[i*3+1],xyz[i*3+2]]);
    const d=Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
    console.log(`i=${i} t=${trailT[i].toFixed(3)} posdelta=${d.toFixed(4)} km`);
    shown++;
  }
}

// 冻结簇：连续 dt==0 的段
console.log('--- frozen runs (dt==0) ---');
let run=0, runs=[];
for (let i=1;i<N;i++){
  if (trailT[i]-trailT[i-1]===0){ if(run===0) runs.push({start:i,t:trailT[i]}); run++; }
  else { if(run>0){ runs[runs.length-1].len=run+1; } run=0; }
}
if(run>0) runs[runs.length-1].len=run+1;
console.log('frozen runs:', runs.length);
console.log(JSON.stringify(runs.slice(0,20)));
