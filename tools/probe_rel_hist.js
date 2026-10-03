const fs=require('fs'), vm=require('vm');
const src=fs.readFileSync('D:/Programming/HTML/Cassini/data/cassini_data.js','utf8');
const ctx={window:{}}; vm.createContext(ctx); vm.runInContext(src,ctx);
const sc=ctx.window.CASSINI_DATA.spacecraft.cassini;
const b64f32=(s)=>{const b=Buffer.from(s,'base64');return new Float32Array(b.buffer,b.byteOffset,b.length/4);};
const pad=(s,l)=>String(s).padEnd(l);
for(const [name,rows] of Object.entries(sc.soi)){
  for(const w of rows){
    if(!w.rel||w.i0===undefined)continue;
    const r=b64f32(w.rel); const n=w.n;
    const m=[];let mx=0;
    for(let i=0;i<n;i++){const g=i*3;const v=Math.hypot(r[g],r[g+1],r[g+2]);m.push(v);if(v>mx)mx=v;}
    m.sort((a,b)=>a-b);
    const q=p=>m[Math.min(n-1,Math.floor(p*n))];
    console.log(pad(name,10)+' n='+pad(n,7)+' |rel|max='+mx.toExponential(3)+'  p10='+q(.1).toExponential(2)+' p50='+q(.5).toExponential(2)+' p90='+q(.9).toExponential(2)+' p99='+q(.99).toExponential(2)+'  ULP@max='+(mx*Math.pow(2,-23)).toExponential(3)+' km');
  }
}
