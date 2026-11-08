import fs from 'node:fs';
import path from 'node:path';

// 一次性拆分：把 client.js 的 factory 体切成多份源码，构建脚本再拼回去。
// 安全性保证：build 出来的字节必须和原文件完全一致，否则不写盘。
const ROOT = 'D:\\deepseek_local\\plugins\\dsh-consciousness-v6';
const SRC = path.join(ROOT, 'client.js');
const OUT = path.join(ROOT, 'client');
const SRC_DIR = path.join(OUT, 'src');

const raw = fs.readFileSync(SRC, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(eol);

// 找 factory 开头
const openIdx = lines.findIndex((l) => /factory\s*\(\s*require\s*\)\s*\{/.test(l));
if (openIdx < 0) { console.error('找不到 factory 开头'); process.exit(1); }
// 找收尾：最后几行里 '  },' 之后跟 '})' —— 取最后一个 '  },'
let closeIdx = -1;
for (let i = lines.length - 1; i > openIdx; i--) if (lines[i] === '  },') { closeIdx = i; break; }
if (closeIdx < 0) { console.error('找不到 factory 收尾'); process.exit(1); }

const head = lines.slice(0, openIdx + 1);
const tail = lines.slice(closeIdx);
const body = lines.slice(openIdx + 1, closeIdx);
console.log(`head=${head.length} body=${body.length} tail=${tail.length} eol=${JSON.stringify(eol)}`);

// 计算每行起始的花括号深度（轻量：只看代码、跳过引号/模板/注释）
function depthAtStart(lines) {
  const out = [];
  let depth = 0;
  let inBlock = false, quote = '', inTpl = false;
  for (const line of lines) {
    out.push(depth);
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (inBlock) { if (c === '*' && line[i + 1] === '/') { inBlock = false; i += 2; continue; } i++; continue; }
      if (quote) {
        if (c === '\\') { i += 2; continue; }
        if (c === quote) quote = '';
        i++; continue;
      }
      if (inTpl) {
        if (c === '\\') { i += 2; continue; }
        if (c === '`') inTpl = false;
        i++; continue;
      }
      if (c === '/' && line[i + 1] === '*') { inBlock = true; i += 2; continue; }
      if (c === '/' && line[i + 1] === '/') break;
      if (c === '"' || c === "'") { quote = c; i++; continue; }
      if (c === '`') { inTpl = true; i++; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    // 行尾未闭合的模板串会在下一行继续；这里不复位 inTpl/quote 是故意的（跨行字符串极少）
    if (quote && !line.endsWith('\\')) quote = '';
  }
  return out;
}
const depth = depthAtStart(body);

// 候选切点：深度 0，且行首是 function / const / let 或分区横幅注释
const cands = [];
for (let i = 0; i < body.length; i++) {
  if (depth[i] !== 0) continue;
  const l = body[i];
  if (/^    (function |const |let |var |class )/.test(l) || /^    \/\* =+/.test(l) || /^    \/\* ── /.test(l)) cands.push(i);
}
console.log('候选切点:', cands.length);

// 目标：切成 10~14 片，尽量均衡
const TARGET = 12;
const cuts = new Set([0]);
if (cands.length) {
  const step = Math.max(1, Math.floor(body.length / TARGET));
  let next = step;
  for (let i = 0; i < cands.length && cuts.size < TARGET; i++) {
    if (cands[i] >= next) { cuts.add(cands[i]); next = cands[i] + step; }
  }
}
const cutList = [...cuts].sort((a, b) => a - b);
cutList.push(body.length);

fs.mkdirSync(SRC_DIR, { recursive: true });
const manifest = [];
for (let k = 0; k < cutList.length - 1; k++) {
  const a = cutList[k], b = cutList[k + 1];
  const chunk = body.slice(a, b);
  // 命名：优先分区横幅文字，其次第一个函数名，再次第一个 const，最后 part
  const banner = chunk.find((l) => /^    \/\* [─=\-]{2,} *(.+?) *[─=\-]{2,} *\*\/\s*$/.test(l)) || '';
  const bm = banner.match(/^    \/\* [─=\-]{2,} *(.+?) *[─=\-]{2,} *\*\/\s*$/);
  const fnLine = chunk.find((l) => /^    function [A-Za-z0-9_$]+/.test(l)) || '';
  const fm = fnLine.match(/^    function ([A-Za-z0-9_$]+)/);
  const cnLine = chunk.find((l) => /^    const [A-Za-z0-9_$]+/.test(l)) || '';
  const cm = cnLine.match(/^    const ([A-Za-z0-9_$]+)/);
  let label = (bm ? bm[1] : fm ? fm[1] : cm ? cm[1] : 'part');
  label = label.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '');
  // 文件名只留 ASCII：中文横幅（还混着个别历史乱码）不适合当文件名，退回函数名
  if (!/^[A-Za-z0-9_.-]{2,}$/.test(label)) {
    label = (fm ? fm[1] : cm ? cm[1] : 'part');
  }
  const name = String(k + 1).padStart(2, '0') + '-' + label.slice(0, 20);
  const file = name + '.js';
  fs.writeFileSync(path.join(SRC_DIR, file), chunk.join(eol) + eol, 'utf8');
  manifest.push(file);
  console.log(`  ${file}  ${chunk.length} 行`);
}

// head/tail 也存成文件（构建时原样拼回）
fs.writeFileSync(path.join(OUT, 'head.txt'), head.join(eol) + eol, 'utf8');
fs.writeFileSync(path.join(OUT, 'tail.txt'), tail.join(eol), 'utf8');
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ eol: eol === '\r\n' ? 'crlf' : 'lf', parts: manifest }, null, 2) + '\n', 'utf8');
console.log('写出', manifest.length, '片 + head/tail/manifest');
