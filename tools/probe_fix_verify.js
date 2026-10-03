/* probe_fix_verify.js —— 逐字复刻 scene.js 的 smoothTrailNoise + collapseMicroSteps
 * （含 ULP/TRAIL_TOL 判据），验证修复效果。数据源可指定（默认 .prev）。
 * 用法：node probe_fix_verify.js [dataFile]
 */
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/Programming/HTML/Cassini';
const FILE = process.argv[2] || 'data/cassini_data.js';

function b64f64(b64) { const b = Buffer.from(b64, 'base64');
  return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
function b64f32(b64) { const b = Buffer.from(b64, 'base64');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }

const txt = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
const D = JSON.parse(txt.match(/window\.CASSINI_DATA\s*=\s*(\{[\s\S]*\});?\s*$/)[1]);
const sc = D.spacecraft.cassini;
const trailT = b64f64(sc.trailT), N = sc.trailN;
const trailThree = (() => { const xyz = b64f32(sc.trail); const a = new Float64Array(N*3);
  for (let i=0;i<N;i++){ a[i*3]=xyz[i*3]; a[i*3+1]=xyz[i*3+2]; a[i*3+2]=-xyz[i*3+1]; } return a; })();

const preSmooth = trailThree.slice();

function smoothTrailNoise() {
  const M = 10;
  const src = trailThree.slice();
  const p = new Float64Array(7), q = new Float64Array(16);
  const L = new Float64Array(16), y = new Float64Array(12);
  for (let i = 0; i < N; i++) {
    const m = Math.min(M, i, N - 1 - i);
    if (m < 2) continue;
    const o = i * 3, ti = trailT[i];
    const H = Math.max(ti - trailT[i - m], trailT[i + m] - ti);
    if (!(H > 0)) continue;
    p.fill(0); q.fill(0);
    for (let j = i - m; j <= i + m; j++) {
      const tau = (trailT[j] - ti) / H;
      const u = 1 - tau * tau;
      if (u <= 0) continue;
      const w = u * u, t2 = tau * tau, t3 = t2 * tau;
      const w0 = w, w1 = w * tau, w2 = w * t2, w3 = w * t3;
      p[0]+=w0;p[1]+=w1;p[2]+=w2;p[3]+=w3;p[4]+=w*t2*t2;p[5]+=w*t3*t2;p[6]+=w*t3*t3;
      const g = j * 3;
      q[0]+=w0*src[g];q[1]+=w0*src[g+1];q[2]+=w0*src[g+2];
      q[4]+=w1*src[g];q[5]+=w1*src[g+1];q[6]+=w1*src[g+2];
      q[8]+=w2*src[g];q[9]+=w2*src[g+1];q[10]+=w2*src[g+2];
      q[12]+=w3*src[g];q[13]+=w3*src[g+1];q[14]+=w3*src[g+2];
    }
    let done = false;
    for (let Dd = 4; Dd >= 1 && !done; Dd--) {
      let ok = true;
      for (let r = 0; r < Dd && ok; r++) {
        for (let c = 0; c <= r; c++) {
          let s = p[r + c];
          for (let k = 0; k < c; k++) s -= L[r*4+k] * L[c*4+k];
          if (r === c) { if (s <= 1e-11) { ok = false; break; } L[r*4+c] = Math.sqrt(s); }
          else L[r*4+c] = s / L[c*4+c];
        }
      }
      if (!ok) continue;
      for (let c = 0; c < 3; c++) {
        for (let r = 0; r < Dd; r++) { let s = q[r*4+c]; for (let k=0;k<r;k++) s -= L[r*4+k]*y[k*3+c]; y[r*3+c] = s/L[r*4+r]; }
        for (let r = Dd-1; r >= 0; r--) { let s = y[r*3+c]; for (let k=r+1;k<Dd;k++) s -= L[k*4+r]*y[k*3+c]; y[r*3+c] = s/L[r*4+r]; }
      }
      trailThree[o]=y[0]; trailThree[o+1]=y[1]; trailThree[o+2]=y[2]; done = true;
    }
  }
}

function collapseMicroSteps() {
  const MIN_DT = 5.0, TRAIL_TOL = 30.0, ULP_F = Math.pow(2, -23) * 2;
  const prevAnchor = new Int32Array(N), nextAnchor = new Int32Array(N);
  { let last = 0;
    for (let i=0;i<N;i++){ if(i>0 && trailT[i]-trailT[i-1]>=MIN_DT) last=i-1; prevAnchor[i]=last; }
    last = N-1;
    for (let i=N-1;i>=0;i--){ if(i<N-1 && trailT[i+1]-trailT[i]>=MIN_DT) last=i+1; nextAnchor[i]=last; } }
  let nFix=0, maxMove=0;
  for (let i=1;i<N-1;i++){
    const dPrev=trailT[i]-trailT[i-1], dNext=trailT[i+1]-trailT[i];
    if (dPrev>=MIN_DT && dNext>=MIN_DT) continue;
    const L=prevAnchor[i], R=nextAnchor[i];
    if (L>=i || R<=i || R<=L) continue;
    const span=trailT[R]-trailT[L]; if(!(span>0)) continue;
    const a=(trailT[i]-trailT[L])/span, lo=L*3, hi=R*3, o=i*3;
    const nx=trailThree[lo]+(trailThree[hi]-trailThree[lo])*a;
    const ny=trailThree[lo+1]+(trailThree[hi+1]-trailThree[lo+1])*a;
    const nz=trailThree[lo+2]+(trailThree[hi+2]-trailThree[lo+2])*a;
    const dx=trailThree[o]-nx, dy=trailThree[o+1]-ny, dz=trailThree[o+2]-nz;
    const mv=Math.sqrt(dx*dx+dy*dy+dz*dz);
    if (mv<=1e-4) continue;
    const rad=Math.sqrt(trailThree[o]**2+trailThree[o+1]**2+trailThree[o+2]**2);
    const lim=Math.max(rad*ULP_F, TRAIL_TOL);
    if (mv<=lim) { trailThree[o]=nx; trailThree[o+1]=ny; trailThree[o+2]=nz; nFix++; if(mv>maxMove)maxMove=mv; }
  }
  return {nFix, maxMove};
}

function turnStats(a, i0, i1, minChord) {
  const out = [];
  for (let i = Math.max(1,i0); i < Math.min(N-1,i1); i++) {
    const ax=a[i*3]-a[(i-1)*3], ay=a[i*3+1]-a[(i-1)*3+1], az=a[i*3+2]-a[(i-1)*3+2];
    const bx=a[(i+1)*3]-a[i*3], by=a[(i+1)*3+1]-a[i*3+1], bz=a[(i+1)*3+2]-a[i*3+2];
    const la=Math.hypot(ax,ay,az), lb=Math.hypot(bx,by,bz);
    if (la<1e-9||lb<1e-9) continue;
    if (minChord && (la<minChord || lb<minChord)) continue;
    const cs=Math.max(-1,Math.min(1,(ax*bx+ay*by+az*bz)/(la*lb)));
    out.push({i, deg:Math.acos(cs)*180/Math.PI});
  }
  out.sort((x,y)=>y.deg-x.deg);
  const s=out.slice().sort((x,y)=>x.deg-y.deg);
  return { n:out.length, max:+out[0].deg.toFixed(2), at:out[0].i,
    p99:+s[Math.floor(0.99*(s.length-1))].deg.toFixed(2) };
}

console.log('=== ' + FILE + '  N=' + N + ' ===');
console.log('RAW       launch:', JSON.stringify(turnStats(preSmooth, 2, 2500)));
console.log('RAW       global:', JSON.stringify(turnStats(preSmooth, 0, N)));
console.log('RAW       global(>100km):', JSON.stringify(turnStats(preSmooth, 0, N, 100)));

const smoothCopy = trailThree.slice();
smoothTrailNoise();
console.log('SMOOTHED  launch:', JSON.stringify(turnStats(trailThree, 2, 2500)));
console.log('SMOOTHED  global:', JSON.stringify(turnStats(trailThree, 0, N)));

const r = collapseMicroSteps();
console.log(`COLLAPSED (${r.nFix} fixed, maxMove=${r.maxMove.toFixed(2)}km)`);
console.log('COLLAPSED launch:', JSON.stringify(turnStats(trailThree, 2, 2500)));
console.log('COLLAPSED global:', JSON.stringify(turnStats(trailThree, 0, N)));
console.log('COLLAPSED global(>100km):', JSON.stringify(turnStats(trailThree, 0, N, 100)));
