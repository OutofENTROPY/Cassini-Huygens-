/* probe_fix_collapse.js —— 验证 collapseMicroSteps 的效果（Node 复刻）。
 * 复刻：f32 解码 → eclToThree → smoothTrailNoise → collapseMicroSteps
 * 输出：修复前 / 平滑后 / 塌缩后 的折角统计与发射段逐点。
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
const eclToThree = (v) => [v[0], v[2], -v[1] === 0 ? v[2] : v[2], -v[1]];
const raw = (() => { const xyz = b64f32(sc.trail); const a = new Float64Array(N*3);
  for (let i=0;i<N;i++){ a[i*3]=xyz[i*3]; a[i*3+1]=xyz[i*3+2]; a[i*3+2]=-xyz[i*3+1]; } return a; })();

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

// —— collapseMicroSteps 复刻 ——
function collapse(arr) {
  const MIN_DT = 5.0;
  const prevAnchor = new Int32Array(N), nextAnchor = new Int32Array(N);
  let last = 0;
  for (let i=0;i<N;i++){ if(i>0 && trailT[i]-trailT[i-1]>=MIN_DT) last=i-1; prevAnchor[i]=last; }
  last = N-1;
  for (let i=N-1;i>=0;i--){ if(i<N-1 && trailT[i+1]-trailT[i]>=MIN_DT) last=i+1; nextAnchor[i]=last; }
  let nFix=0, maxMove=0;
  for (let i=1;i<N-1;i++){
    const dPrev=trailT[i]-trailT[i-1], dNext=trailT[i+1]-trailT[i];
    if(dPrev>=MIN_DT && dNext>=MIN_DT) continue;
    const L=prevAnchor[i], R=nextAnchor[i];
    if(L>=i||R<=i||R<=L) continue;
    const span=trailT[R]-trailT[L]; if(!(span>0)) continue;
    const a=(trailT[i]-trailT[L])/span;
    const lo=L*3, hi=R*3, o=i*3;
    const nx=arr[lo]+(arr[hi]-arr[lo])*a, ny=arr[lo+1]+(arr[hi+1]-arr[lo+1])*a, nz=arr[lo+2]+(arr[hi+2]-arr[lo+2])*a;
    const dx=arr[o]-nx,dy=arr[o+1]-ny,dz=arr[o+2]-nz;
    const d2=dx*dx+dy*dy+dz*dz;
    if(d2>1e-6){ maxMove=Math.max(maxMove,Math.sqrt(d2)); arr[o]=nx;arr[o+1]=ny;arr[o+2]=nz; nFix++; }
  }
  return {nFix, maxMove};
}

function turns(arr, i0, i1) {
  const out=[];
  for (let i=Math.max(1,i0);i<Math.min(N-1,i1);i++) {
    const ax=arr[i*3]-arr[(i-1)*3], ay=arr[i*3+1]-arr[(i-1)*3+1], az=arr[i*3+2]-arr[(i-1)*3+2];
    const bx=arr[(i+1)*3]-arr[i*3], by=arr[(i+1)*3+1]-arr[i*3+1], bz=arr[(i+1)*3+2]-arr[i*3+2];
    const la=Math.hypot(ax,ay,az), lb=Math.hypot(bx,by,bz);
    if (la<1e-9||lb<1e-9) continue;
    const cs=Math.max(-1,Math.min(1,(ax*bx+ay*by+az*bz)/(la*lb)));
    out.push(Math.acos(cs)*180/Math.PI);
  }
  out.sort((a,b)=>a-b);
  const q=(p)=>out.length?+out[Math.floor(p*(out.length-1))].toFixed(3):null;
  return {n:out.length, max:q(1), p99:q(0.99), p90:q(0.9), p50:q(0.5)};
}
// 只看「两侧弦都 ≥100 km」的折角（真实可视角，排除退化弦伪影）
function turnsReal(arr) {
  const out=[];
  for (let i=1;i<N-1;i++) {
    const ax=arr[i*3]-arr[(i-1)*3], ay=arr[i*3+1]-arr[(i-1)*3+1], az=arr[i*3+2]-arr[(i-1)*3+2];
    const bx=arr[(i+1)*3]-arr[i*3], by=arr[(i+1)*3+1]-arr[i*3+1], bz=arr[(i+1)*3+2]-arr[i*3+2];
    const la=Math.hypot(ax,ay,az), lb=Math.hypot(bx,by,bz);
    if (la<100||lb<100) continue;
    const cs=Math.max(-1,Math.min(1,(ax*bx+ay*by+az*bz)/(la*lb)));
    out.push({i, deg:Math.acos(cs)*180/Math.PI});
  }
  out.sort((a,b)=>b.deg-a.deg);
  const q=(p)=>{const s=out.slice().sort((a,b)=>a.deg-b.deg);return s.length?+s[Math.floor(p*(s.length-1))].deg.toFixed(3):null;};
  return {n:out.length, max:+out[0].deg.toFixed(3), p99:q(0.99), p90:q(0.9), p50:q(0.5)};
}

const sm = smooth(raw);
const cl = sm.slice();
const res = collapse(cl);

console.log('N =', N, ' 塌缩顶点数 =', res.nFix, ' 最大搬移 =', res.maxMove.toFixed(3), 'km');
console.log('--- 发射段 i∈[2,2500] ---');
console.log('RAW     :', JSON.stringify(turns(raw,2,2500)));
console.log('SMOOTHED:', JSON.stringify(turns(sm,2,2500)));
console.log('COLLAPSED:', JSON.stringify(turns(cl,2,2500)));
console.log('--- 全局（含退化弦） ---');
console.log('SMOOTHED:', JSON.stringify(turns(sm,0,N)));
console.log('COLLAPSED:', JSON.stringify(turns(cl,0,N)));
console.log('--- 全局（双弦≥100km，真实视角） ---');
console.log('SMOOTHED :', JSON.stringify(turnsReal(sm)));
console.log('COLLAPSED:', JSON.stringify(turnsReal(cl)));

// 发射段折角>5° 的点
console.log('--- 发射段{i∈[2,2500]} 折角>5° ---');
for (const [nm,a] of [['SMOOTHED',sm],['COLLAPSED',cl]]) {
  const bad=[];
  for(let i=2;i<2500;i++){
    const ax=a[i*3]-a[(i-1)*3],ay=a[i*3+1]-a[(i-1)*3+1],az=a[i*3+2]-a[(i-1)*3+2];
    const bx=a[(i+1)*3]-a[i*3],by=a[(i+1)*3+1]-a[i*3+1],bz=a[(i+1)*3+2]-a[i*3+2];
    const la=Math.hypot(ax,ay,az),lb=Math.hypot(bx,by,bz);
    const cs=Math.max(-1,Math.min(1,(ax*bx+ay*by+az*bz)/(la*lb)));
    const d=Math.acos(cs)*180/Math.PI; if(d>5) bad.push({i,deg:+d.toFixed(2)});
  }
  console.log(nm+':', JSON.stringify(bad));
}
