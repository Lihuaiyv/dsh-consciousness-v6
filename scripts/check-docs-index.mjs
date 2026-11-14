// 文档索引闸（只读）：把「索引和事实分家」变成红灯。
//
//   node scripts/check-docs-index.mjs
//
// 查四样：
//   1. 链接：docs/ 下所有 md 的相对链接能不能指到；工作区总入口 docs/INDEX.md 同理
//   2. 收录：每个「功能」目录里的每份文档，有没有出现在该目录 README 的表格里
//   3. 漂移：README 写的「最后更新：YYYY-MM-DD」不能早于该目录里最新文档的日期
//   4. 总入口：工作区 INDEX 里点名要有的项目入口，文件在不在
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const WS = path.dirname(REPO);
const DOCS = path.join(REPO, 'docs');
const WS_INDEX = path.join(WS, 'docs', 'INDEX.md');

const problems = [];
const say = (s) => console.log(s);

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const n of fs.readdirSync(dir)) {
    if (n === 'node_modules' || n === '.git') continue;
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.md$/i.test(n)) out.push(p);
  }
  return out;
};

// ---- 1. 链接 ----
const WS_DOCS = path.join(WS, 'docs');
// 工作区 docs 下所有 md 也一起查（启动手册、总入口都在那儿）
const linkTargets = [...walk(DOCS), ...walk(WS_DOCS)];
let links = 0;
for (const file of linkTargets) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    // markdown 允许 <路径 带 空格>，闸里先剥掉尖括号
    const t = m[1].replace(/^<|>$/g, '');
    if (/^[a-z]+:\/\//i.test(t) || t.startsWith('#')) continue;
    links++;
    const abs = path.resolve(path.dirname(file), t.split('#')[0]);
    if (!fs.existsSync(abs)) problems.push(`链接指不到：${path.relative(WS, file)} -> ${t}`);
  }
}
say(`链接：${links} 条，问题 ${problems.length}`);

// ---- 2/3. 功能目录 ----
const FN = path.join(DOCS, '功能');
const features = fs.existsSync(FN)
  ? fs.readdirSync(FN).filter((d) => fs.statSync(path.join(FN, d)).isDirectory())
  : [];
let docsChecked = 0;
for (const f of features) {
  const dir = path.join(FN, f);
  const readme = path.join(dir, 'README.md');
  const files = fs.readdirSync(dir).filter((n) => n !== 'README.md');
  docsChecked += files.length;
  if (!fs.existsSync(readme)) { problems.push(`缺 README：功能/${f}`); continue; }
  const rt = fs.readFileSync(readme, 'utf8');

  // 收录：每份文档的文件名要出现在 README 正文里
  for (const n of files) {
    if (!rt.includes(n)) problems.push(`README 没登记：功能/${f}/${n}`);
  }

  // 漂移：README 的「最后更新」对比目录里最新文档日期
  const m = rt.match(/最后更新[:：]\s*(20\d\d-\d\d-\d\d)/);
  if (m) {
    const dates = files
      .map((n) => (n.match(/(20\d\d-\d\d-\d\d)/) || [])[1])
      .filter(Boolean)
      .sort();
    const newest = dates[dates.length - 1];
    if (newest && m[1] < newest) {
      problems.push(`README 过期：功能/${f} 写 ${m[1]}，目录里最新 ${newest}`);
    }
  } else {
    problems.push(`README 没写「最后更新」：功能/${f}`);
  }
}
say(`功能目录：${features.length} 个，文档 ${docsChecked} 份`);

// ---- 4. 总入口点名 ----
if (fs.existsSync(WS_INDEX)) {
  const t = fs.readFileSync(WS_INDEX, 'utf8');
  const must = [
    '../dsh-consciousness-v6/docs/INDEX.md',
    '../scratch/models/feiyu/DeepSeek免费公皮/DeepSeek/docs/交接文档-2026-11-14.md',
    '../dsh-bci-bridge/docs/hardware.md',
    '../scratch/memory-unify/REPORT.md',
    '../_portable/MIGRATION.md',
  ];
  for (const p of must) {
    if (!t.includes(p)) problems.push(`总入口没指：docs/INDEX.md 缺 ${p}`);
  }
  say(`总入口：${path.relative(WS, WS_INDEX)} 在`);
} else {
  problems.push('总入口不见了：docs/INDEX.md');
}

// ---- 结果 ----
if (problems.length) {
  say(`\n门禁红：${problems.length} 个问题`);
  for (const p of problems) say('  - ' + p);
  process.exit(1);
}
say('\n文档索引 ok — 链接、收录、最后更新、总入口都对得上');
