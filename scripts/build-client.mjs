// 把 client/src/*.js 拼回 client.js（无打包器：纯拼接 + 头尾模板）。
//   node scripts/build-client.mjs          写 client.js
//   node scripts/build-client.mjs --check  只比对，不一致就 exit 1（接进门禁用）
//
// 为什么能这么干：这些片段本来就是同一个函数体里的顺序语句，
// 拆的是"文件边界"不是"作用域"，按原顺序拼回去就一定等价。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'client');
const OUT = path.join(ROOT, 'client.js');
const CHECK = process.argv.includes('--check');

const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const eol = manifest.eol === 'crlf' ? '\r\n' : '\n';

const head = fs.readFileSync(path.join(DIR, 'head.txt'), 'utf8');
const tail = fs.readFileSync(path.join(DIR, 'tail.txt'), 'utf8');
let body = '';
for (const part of manifest.parts) body += fs.readFileSync(path.join(DIR, 'src', part), 'utf8');
const built = head + body + tail;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const debug = path.join(DIR, 'manifest.json');
const m = JSON.parse(fs.readFileSync(debug, 'utf8'));
m.sha256 = sha(built);
m.builtAt = new Date().toISOString();
fs.writeFileSync(debug, JSON.stringify(m, null, 2) + '\n', 'utf8');

if (CHECK) {
  if (!fs.existsSync(OUT)) { console.error('client.js 不存在'); process.exit(1); }
  const cur = fs.readFileSync(OUT, 'utf8');
  if (cur !== built) {
    console.error('client.js 和 client/src/ 不一致：跑 node scripts/build-client.mjs 重新生成');
    process.exit(1);
  }
  console.log('client.js 与源码一致（' + sha(built) + '，' + Math.round(Buffer.byteLength(built) / 1024) + ' KB）');
  process.exit(0);
}

fs.writeFileSync(OUT, built, 'utf8');
console.log('已生成 client.js：' + Math.round(Buffer.byteLength(built) / 1024) + ' KB，sha ' + sha(built) + '，片段 ' + manifest.parts.length + ' 个');
