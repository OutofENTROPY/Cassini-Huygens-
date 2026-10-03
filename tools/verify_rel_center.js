const fs=require('fs'), vm=require('vm');
const src=fs.readFileSync('D:/Programming/HTML/Cassini/data/cassini_data.js','utf8');
const ctx={window:{}}; vm.createContext(ctx); vm.runInContext(src,ctx);
const sc=ctx.window.CASSINI_DATA.spacecraft.cassini;
const b64f32=(s)=>{const b=Buffer.from(s,'base64');return new Float32Array(b.buffer,b.byteOffset,b.length/4);};
const b64f64=(s)=>{const b=Buffer.from(s,'base64');return new Float64Array(b.buffer,b.byteOffset,b.length/8);};
const pad=(s,l)=>String(s).padEnd(l);
console.log('窗口       n     |buf| p50        p99        max        ULP@p99    ULP@max');
for(const [name,rows] of Object.entries(sc.soi)){
  for(const w of rows){
    const r=b64f32(w.rel); const n=w.n;
    const a=[];
    for(let i=0;i<n;i++){const g=i*3;a.push(Math.hypot(r[g],r[g+1],r[g+2]));}
    a.sort((x,y)=>x-y);
    const q=p=>a[Math.min(n-1,Math.floor(p*n))];
    console.log(pad(name,9)+pad(n,7)+pad(q(.5).toExponential(3),13)+pad(q(.99).toExponential(3),11)+pad(a[n-1].toExponential(3),11)+pad((q(.99)*2**-23).toExponential(2),11)+(a[n-1]*2**-23).toExponential(2));
  }
}
