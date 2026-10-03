/* patch_soi_dedup.js —— 对已烘焙的 cassini_data.js 做 SOI 窗口去重（外科式补丁）
 *
 * 背景：bake_spice.py 的 earth 发射逃逸窗可能被 SOI 扫描器与显式补建各生成一次，
 * 得到两个几乎重合的窗口。前端 soiWindowAt 只选其一绘制，但白建一份顶点缓冲。
 * 本脚本与 bake_spice.py 的全局去重逻辑同口径，对现有数据即刻生效。
 *
 * 输入：data/cassini_data.js
 * 输出：原地重写 data/cassini_data.js
 * 校验：打印去重前后各体窗口数
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'data', 'cassini_data.js');
const src = fs.readFileSync(FILE, 'utf8');

// 用 vm 求值取出对象（构造 window 只读快照）
const sandbox = { window: {}, self: {}, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'cassini_data.js' });
const D = sandbox.window.CASSINI_DATA;
if (!D) { console.error('未能取出 CASSINI_DATA'); process.exit(1); }

function dedup(rows) {
  const sorted = [...rows].sort((x, y) => (x.a - y.a) || (y.b - x.b));
  const merged = [];
  let removed = 0;
  for (const w of sorted) {
    if (merged.length) {
      const p = merged[merged.length - 1];
      const ov = Math.min(p.b, w.b) - Math.max(p.a, w.a);
      if (ov > 0) {
        const short = Math.min(p.b - p.a, w.b - w.a);
        if (ov >= 0.9 * short) {
          if ((w.b - w.a) > (p.b - p.a)) merged[merged.length - 1] = w;
          removed++;
          continue;
        }
      }
    }
    merged.push(w);
  }
  return { merged, removed };
}

const soi = D.spacecraft.cassini.soi;
let total = 0, totalRemoved = 0;
for (const name of Object.keys(soi)) {
  const before = soi[name];
  const { merged, removed } = dedup(before);
  total += before.length; totalRemoved += removed;
  soi[name] = merged;
  console.log(`${name.padEnd(9)} ${before.length} → ${merged.length} 窗${removed ? '  (移除 ' + removed + ' 重复)' : ''}`);
}
console.log(`\n合计：${total} → ${total - totalRemoved} 窗，移除 ${totalRemoved}`);

if (totalRemoved === 0) {
  console.log('无重复窗口，文件未改动。');
  process.exit(0);
}

// 外科式替换：只重写 "soi":{...} 这一节，其余字节保持不变。
// 定位到 `"soi":` 后的第一个 `{`，再做花括号配对找到该节的闭合位置。
const marker = '"soi":';
const mi = src.indexOf(marker);
if (mi < 0) { console.error('未找到 "soi": 标记'); process.exit(1); }
let i = src.indexOf('{', mi);
let depth = 0, end = -1;
for (let j = i; j < src.length; j++) {
  const ch = src[j];
  if (ch === '{') depth++;
  else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
}
if (end < 0) { console.error('soi 节括号不配对'); process.exit(1); }

const newSoi = JSON.stringify(D.spacecraft.cassini.soi);
const out = src.slice(0, i) + newSoi + src.slice(end + 1);
fs.writeFileSync(FILE, out);
console.log(`\n已重写 ${FILE}（soi 节 ${end - i + 1} → ${newSoi.length} 字节）`);
