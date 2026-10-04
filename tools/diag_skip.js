'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = 'D:/Programming/HTML/Cassini';
const MIME = { '.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css' };
const srv = http.createServer((req,res)=>{ let r=decodeURIComponent(req.url.split('?')[0]); if(r==='/')r='/index.html'; const fp=path.join(ROOT,r); fs.readFile(fp,(e,b)=>{ if(e){res.writeHead(404);return res.end();} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(b);});});
const CASES=[['1999-08-18T03:28:00Z','earth','earth'],['2005-01-14T10:00:00Z','titan','titan'],['2010-05-19T00:00:00Z','titan','titan']];
(async()=>{
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const P=srv.address().port;
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1400,height:800}});
  page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,200)));
  await page.goto(`http://127.0.0.1:${P}/index.html`,{waitUntil:'load',timeout:60000});
  await page.waitForTimeout(9000);
  await page.evaluate(()=>{const b=document.getElementById('help-close');if(b)b.click();});
  const out=await page.evaluate((cases)=>{
    const OFF=65;
    const S=window.CassiniScene, C=window.CassiniCamera;
    const frame=(t)=>{const {cassWorld}=S.updatePositions(t);
      const cache={}; for(const [n,e] of S.registry) cache[n]=e.world; cache.cassini=cassWorld;
      try{C.update(performance.now(),cache,cassWorld,S);}catch(e){}
      S.updateRender(t);};
    const res=[];
    for(const c of cases){
      const t=(Date.parse(c[0])-946728000000)/1000+OFF;
      if(window.CassiniTimeline){window.CassiniTimeline.setNow(t);window.CassiniTimeline.setPlaying(false);}
      frame(t); C.focus(c[1],{dist:2e6,animate:false}); if(C.state)C.state.sDist=2e6; frame(t); frame(t);
      const sp=S.soiPlanets.get(c[2]);
      const e=sp&&sp.entry;
      const dCass=e?Math.hypot(S.cassWorld[0]-e.world[0],S.cassWorld[1]-e.world[1],S.cassWorld[2]-e.world[2]):-1;
      const inWin=sp?sp.wins.filter(function(w){return t>=w.a&&t<=w.b;}).map(function(w){
        return {a:w.a,b:w.b,n:w.n,visF:w.flown.visible,visU:w.full.visible,
        drCount:w.flown.geometry.drawRange.count, i0:w.i0, hasRel0:!!w.rel0};}):[];
      res.push({when:c[0], t:t, dCass:dCass, soiState:{name:S.soiState.name,k:S.soiState.k,moon:S.soiState.moon,k2:S.soiState.k2},
        cassiniOpt:S.trailOptions.cassini, inWin:inWin, totalWins:sp?sp.wins.length:0});
    }
    return res;
  }, CASES);
  for(const r of out){
    console.log('\n['+r.when+'] t='+r.t.toFixed(0)+'  dCass='+r.dCass.toExponential(3)+' km');
    console.log('  soiState='+JSON.stringify(r.soiState)+'  cassiniOpt='+r.cassiniOpt);
    console.log('  windows总='+r.totalWins+'  含t的='+r.inWin.length);
    for(const w of r.inWin) console.log('    a='+w.a.toFixed(0)+' b='+w.b.toFixed(0)+' n='+w.n+' i0='+w.i0+' rel0='+w.hasRel0+' visF='+w.visF+' visU='+w.visU+' drCount='+w.drCount);
  }
  await browser.close(); srv.close();
})().catch(e=>{console.error('ERR',e);process.exit(1);});
