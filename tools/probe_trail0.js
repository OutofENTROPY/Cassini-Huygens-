/* probe_trail0.js —— 直接读取烘焙数据，检查轨迹起点邻域的顶点与时间表。
 * 纯 Node，无浏览器。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/Programming/HTML/Cassini';
const src = fs.readFileSync(path.join(ROOT, 'data/cassini_data.js'), 'utf8');

// 剥掉包装：window.XXX = {...}
const m = src.match(/window\.\w+\s*=\s*(\{[\s\S]*\});?\s*$/);
if (!m) { console.error('cannot parse'); process.exit(1); }
const D = JSON.parse(m[1]);
const sc = D.spacecraft && D.spacecraft.cassini;
console.log('keys', Object.keys(D.spacecraft || {}));
console.log('cassini keys', sc ? Object.keys(sc) : null);

function b64f64(b) {
  const buf = Buffer.from(b, 'base64');
  const n = Math.floor(buf.length / 8);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readDoubleLE(i * 8);
  return out;
}
function b64f32(b) {
  const buf = Buffer.from(b, 'base64');
  const n = Math.floor(buf.length / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}
const T = b64f64(sc.trailT);
const P = b64f32(sc.trail);
console.log('trailN(trailT)', T.length, 'trail floats', P.length, '=> N', P.length / 3);
const N = P.length / 3;
console.log('t[0..5]', Array.from(T.slice(0, 6)).map(x=>x.toFixed(0)));
console.log('t[-1]', T[T.length-1].toFixed(0));
for (let i = 0; i < Math.min(8, N); i++) {
  console.log(`i=${i} t=${T[i].toFixed(1)} dt=${(T[i]-(T[i-1]??T[i])).toFixed(1)} xyz=[${P[i*3].toFixed(0)},${P[i*3+1].toFixed(0)},${P[i*3+2].toFixed(0)}]`);
}
// 与数据里 trail 起点的模长（日心距离，黄道 km）
let r0 = Math.hypot(P[0],P[1],P[2]);
console.log('|trail[0]| =', r0.toFixed(0), 'km (heliocentric)');
// Earth 位置粗查：d.segments 或在 bodies 里
console.log('bodies?', Object.keys(D).slice(0,20));
