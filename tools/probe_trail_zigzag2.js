/* probe_trail_zigzag2.js —— 定位主轨迹折角最大的顶点（世界角 + 弦长 + 屏幕角）。
 * 复刻 scene.js 的 f32 解码 → eclToThree → smoothTrailNoise。
 * 目标：区分「真实折线」与「极短弦导致的伪折角」。
 * 用法：node probe_trail_zigzag2.js [topN]
 */
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/Programming/HTML/Cassini';

function b64f64(b64) { const b = Buffer.from(b64, 'base64');
  return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
function b64f32(b64) { const b = Buffer.from(b64, 'base64');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }

const txt = fs.readFileSync(path.join(ROOT, 'data/cassini_data.js'), 'utf8');
const m = txt.match(/window\.CASSINI_DATA\s*=\s*(\{[\s\S]*\});?\s*$/);
const D = JSON.parse(m[1]);
const sc = D.spacecraft.cassini;
const trailT = b64f64(sc.trailT);
const N = sc.trailN;
const eclToThree = (v) => [v[0], v[2], -v[1]];

const raw = (() => { const xyz = b64f32(sc.trail); const a = new Float64Array(N*3);
  for (let i=0;i<N;i++){ const w = eclToThree([xyz[i*3],xyz[i*3+1],xyz[i*3+2]]);
    a[i*3]=w[0]; a[i*3+1]=w[1]; a[i*3+2]=w[2]; } return a; })();

function smooth(srcIn) {
  const M = 10, src = srcIn.slice();
  const p = new Float64Array(7), q = new Float64Array(16);
  const L = new Float64Array(16), y = new Float64Array(12);
  for (let i = 0; i < N; i++) {
    const mm = Math.min(M, i, N - 1 - i);
    if (mm < 2) continue;
    const o = i*3, ti = trailT[i];
    const H = Math.max(ti - trailT[i-mm], trailT[i+mm] - ti);
    if (!(H > 0)) continue;
    p.fill(0); q.fill(0);
    for (let j = i-mm; j <= i+mm; j++) {
      const tau = (trailT[j]-ti)/H, u = 1-tau*tau; if (u<=0) continue;
      const w = u*u, t2=tau*tau, t3=t2*tau;
      const w0=w,w1=w*tau,w2=w*t2,w3=w*t3;
      p[0]+=w0;p[1]+=w1;p[2]+=w2;p[3]+=w3;p[4]+=w*t2*t2;p[5]+=w*t3*t2;p[6]+=w*t3*t3;
      const g=j*3;
      q[0]+=w0*src[g];q[1]+=w0*src[g+1];q[2]+=w0*src[g+2];
      q[4]+=w1*src[g];q[5]+=w1*src[g+1];q[6]+=w1*src[g+2];
      q[8]+=w2*src[g];q[9]+=w2*src[g+1];q[10]+=w2*src[g+2];
      q[12]+=w3*src[g];q[13]+=w3*src[g+1];q[14]+=w3*src[g+2];
    }
    let done=false;
    for (let Dd=4; Dd>=1 && !done; Dd--) {
      let ok=true;
      for (let r=0;r<Dd&&ok;r++) for (let c=0;c<=r;c++) {
        let s=p[r+c]; for (let k=0;k<c;k++) s-=L[r*4+k]*L[c*4+k];
        if (r===c){ if (s<=1e-11){ok=false;break;} L[r*4+c]=Math.sqrt(s);} else L[r*4+c]=s/L[c*4+c];
      }
      if(!ok) continue;
      for (let c=0;c<3;c++){
        for (let r=0;r<Dd;r++){ let s=q[r*4+c]; for(let k=0;k<r;k++) s-=L[r*4+k]*y[k*3+c]; y[r*3+c]=s/L[r*4+r]; }
        for (let r=Dd-1;r>=0;r--){ let s=y[r*3+c]; for(let k=r+1;k<Dd;k++) s-=L[k*4+r]*y[k*3+c]; y[r*3+c]=s/L[r*4+r]; }
      }
      src[o]=y[0]; src[o+1]=y[1]; src[o+2]=y[2]; done=true;
    }
  }
  return src;
}
const sm = smooth(raw);

function turns(arr) {
  const out=[];
  for (let i=1;i<N-1;i++) {
    const ax=arr[i*3]-arr[(i-1)*3], ay=arr[i*3+1]-arr[(i-1)*3+1], az=arr[i*3+2]-arr[(i-1)*3+2];
    const bx=arr[(i+1)*3]-arr[i*3], by=arr[(i+1)*3+1]-arr[i*3+1], bz=arr[(i+1)*3+2]-arr[i*3+2];
    const la=Math.hypot(ax,ay,az), lb=Math.hypot(bx,by,bz);
    if (la<1e-12||lb<1e-12) continue;
    const cs=Math.max(-1,Math.min(1,(ax*bx+ay*by+az*bz)/(la*lb)));
    out.push({i, deg:Math.acos(cs)*180/Math.PI, ca:la, cb:lb, t:trailT[i]});
  }
  return out;
}

const topN = process.argv[2] ? parseInt(process.argv[2]) : 15;
const T = turns(sm);
T.sort((a,b)=>b.deg-a.deg);
console.log('=== SMOOTHED top-' + topN + ' turn (deg) ===');
for (let k=0;k<topN;k++){ const e=T[k];
  console.log(`i=${e.i} t=${e.t.toFixed(1)} deg=${e.deg.toFixed(2)} chordBefore=${e.ca.toFixed(3)} chordAfter=${e.cb.toFixed(3)} (km)`);
}
// 折角大 & 两条弦都不短（>100 km）的
const T2 = T.filter(e=>e.ca>100 && e.cb>100);
console.log('=== SMOOTHED top-' + topN + ' turn among chords>100km ===');
for (let k=0;k<Math.min(topN,T2.length);k++){ const e=T2[k];
  console.log(`i=${e.i} t=${e.t.toFixed(1)} deg=${e.deg.toFixed(2)} chordBefore=${e.ca.toFixed(3)} chordAfter=${e.cb.toFixed(3)} (km)`);
}

// 弦长分布：找到最短弦的位置（近掠段）
let minChord=1e18, minI=-1;
for (let i=1;i<N;i++){ const dx=sm[i*3]-sm[(i-1)*3],dy=sm[i*3+1]-sm[(i-1)*3+1],dz=sm[i*3+2]-sm[(i-1)*3+2];
  const d=Math.hypot(dx,dy,dz); if(d<minChord){minChord=d;minI=i;} }
console.log('min chord =', minChord.toFixed(3), 'km at i=', minI, 't=', trailT[minI].toFixed(1));

// 每秒（60s 节拍）大跨越对照
console.log('=== first 12 smoothed vertices: pos delta ===');
for (let i=1;i<12;i++){
  const dx=sm[i*3]-sm[(i-1)*3],dy=sm[i*3+1]-sm[(i-1)*3+1],dz=sm[i*3+2]-sm[(i-1)*3+2];
  console.log(`i=${i} t=${trailT[i].toFixed(1)} dt=${(trailT[i]-trailT[i-1]).toFixed(1)}s chord=${Math.hypot(dx,dy,dz).toFixed(2)}km`);
}
