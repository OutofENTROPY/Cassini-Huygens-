const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const ctx = { window: {}, atob: b64 => Buffer.from(b64, 'base64').toString('binary') };
vm.createContext(ctx);

for (const [base, varName] of [['cassini_data', 'CASSINI_DATA']]) {
  const mono = path.join(ROOT, 'data', base + '.js');
  if (fs.existsSync(mono)) {
    vm.runInContext(fs.readFileSync(mono, 'utf8'), ctx);
    continue;
  }
  const asm = path.join(ROOT, 'data', base + '.asm.js');
  if (!fs.existsSync(asm)) { console.error('MISSING ' + mono); process.exit(2); }
  ctx.window.__DP = {};
  const shards = fs.readdirSync(path.join(ROOT, 'data'))
    .filter(f => f.startsWith(base + '.p') && f.endsWith('.js')).sort();
  for (const f of shards) vm.runInContext(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(asm, 'utf8'), ctx);
}
delete ctx.window.__DP;

const sc = ctx.window.CASSINI_DATA.spacecraft.cassini;
const b64f32 = (s) => { const b = Buffer.from(s, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
const pad = (s, l) => String(s).padEnd(l);
console.log('窗口       n     |buf| p50        p99        max        ULP@p99    ULP@max');
for (const [name, rows] of Object.entries(sc.soi)) {
  for (const w of rows) {
    const r = b64f32(w.rel); const n = w.n;
    const a = [];
    for (let i = 0; i < n; i++) { const g = i * 3; a.push(Math.hypot(r[g], r[g + 1], r[g + 2])); }
    a.sort((x, y) => x - y);
    const q = p => a[Math.min(n - 1, Math.floor(p * n))];
    console.log(pad(name, 9) + pad(n, 7) + pad(q(.5).toExponential(3), 13) + pad(q(.99).toExponential(3), 11) + pad(a[n - 1].toExponential(3), 11) + pad((q(.99) * 2 ** -23).toExponential(2), 11) + (a[n - 1] * 2 ** -23).toExponential(2));
  }
}
