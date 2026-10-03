/* probe_trail_zigzag.js —— 量化主轨迹顶点的折角（世界角），定位「折线/锯齿」来源。
 * 复刻 scene.js 的 f32 解码 → eclToThree → smoothTrailNoise，比较平滑前后折角。
 * 用法：node probe_trail_zigzag.js [fromSec] [toSec]
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

// —— 复刻 smoothTrailNoise ——
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

function turnStats(arr, i0, i1) {
  let mx=0, mn=1e9, arr2=[];
  for (let i=i0+1;i<i1-1;i++) {
    const ax=arr[i*3]-arr[(i-1)*3], ay=arr[i*3+1]-arr[(i-1)*3+1], az=arr[i*3+2]-arr[(i-1)*3+2];
    const bx=arr[(i+1)*3]-arr[i*3], by=arr[(i+1)*3+1]-arr[i*3+1], bz=arr[(i+1)*3+2]-arr[i*3+2];
    const la=Math.hypot(ax,ay,az), lb=Math.hypot(bx,by,bz);
    if (la<1e-9||lb<1e-9) continue;
    const cs=Math.max(-1,Math.min(1,(ax*bx+ay*by+az*bz)/(la*lb)));
    const d=Math.acos(cs)*180/Math.PI;
    arr2.push(d); if(d>mx)mx=d; if(d<mn)mn=d;
  }
  arr2.sort((a,b)=>a-b);
  const q=(p)=>arr2.length?+arr2[Math.floor(p*(arr2.length-1))].toFixed(3):null;
  return { n: arr2.length, max:+mx.toFixed(3), p50:q(0.5), p90:q(0.9), p99:q(0.99) };
}

const from = process.argv[2] ? parseInt(process.argv[2]) : 0;
const to = process.argv[3] ? parseInt(process.argv[3]) : 400;
console.log('trailN =', N, ' from', from, 'to', to);
console.log('t[from..to] =', trailT[from].toFixed(1), '..', trailT[Math.min(to,N-1)].toFixed(1));
console.log('RAW     :', JSON.stringify(turnStats(raw, from, Math.min(to,N))));
console.log('SMOOTHED:', JSON.stringify(turnStats(sm, from, Math.min(to,N))));
// 全局
console.log('--- global ---');
console.log('RAW     :', JSON.stringify(turnStats(raw, 0, N)));
console.log('SMOOTHED:', JSON.stringify(turnStats(sm, 0, N)));
// 前 12 个顶点的折角逐点
console.log('--- first 12 vertex turn (deg) ---');
const seq=[];
for (let i=1;i<12;i++){
  const ax=sm[i*3]-sm[(i-1)*3], ay=sm[i*3+1]-sm[(i-1)*3+1], az=sm[i*3+2]-sm[(i-1)*3+2];
  const bx=sm[(i+1)*3]-sm[i*3], by=sm[(i+1)*3+1]-sm[i*3+1], bz=sm[(i+1)*3+2]-sm[i*3+2];
  const la=Math.hypot(ax,ay,az), lb=Math.hypot(bx,by,bz);
  const cs=Math.max(-1,Math.min(1,(ax*bx+ay*by+az*bz)/(la*lb)));
  seq.push({i, turn:+(Math.acos(cs)*180/Math.PI).toFixed(3), chordA_km:+la.toFixed(1), chordB_km:+lb.toFixed(1)});
}
console.log(JSON.stringify(seq));
