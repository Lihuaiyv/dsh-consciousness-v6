import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:\\deepseek_local\\plugins\\dsh-consciousness-v6';
const DOCS = path.join(ROOT, 'docs');
const files = fs.readdirSync(DOCS, { withFileTypes: true }).filter(d => d.isFile() && d.name.endsWith('.md') && d.name !== 'README.md');

const groups = [
  { key: '搬家与迁移', test: /搬家|迁移|move|恢复|搬迁/ },
  { key: '情绪与感受', test: /情绪|感受|affect|feel|痛|委屈|怒|羞/ },
  { key: '记忆与回忆', test: /记忆|回忆|memory|召回|向量|沉淀/ },
  { key: '三观与判断', test: /三观|sangguan|价值|判断|谱系|裁决/ },
  { key: '心跳与在场', test: /心跳|heart|唤醒|在场|节拍/ },
  { key: '对谈与本体', test: /对谈|存在|本体|我是谁|写给下一个我/ },
  { key: '日记与回放', test: /diary|episode|回放|重放/ },
  { key: '评测与实验', test: /eval|评测|实验|基准|bench|对照/ },
  { key: '零件与架构', test: /零件|大脑|解剖|架构|接缝|独立性|依赖/ },
  { key: '自我与真实', test: /selfhood|realness|presence|真实感|闭环/ },
  { key: '规范与整治', test: /规范|整治|审计|检查|清理|治理|清单|整改|病例/ },
  { key: '计划与提案', test: /计划|-plan|plan-|提案|v1/ },
];

const buckets = new Map(groups.map(g => [g.key, []]));
buckets.set('其他', []);

for (const f of files) {
  const st = fs.statSync(path.join(DOCS, f.name));
  const item = { name: f.name, size: st.size, mtime: st.mtime };
  const g = groups.find(x => x.test.test(f.name));
  buckets.get(g ? g.key : '其他').push(item);
}

for (const list of buckets.values()) list.sort((a, b) => b.mtime - a.mtime);

const lines = [];
lines.push('# docs 索引');
lines.push('');
lines.push('> 这层不是给人从头读的，是给人**找**的。按主题分组，组内新的在前。');
lines.push('> 维护规则：新文档按名字里的关键词自动落组；实在不属于任何组的放「其他」，');
lines.push('> 但**别让「其他」超过 20 个**——超了说明该加分组了。');
lines.push('');
let total = 0;
for (const [k, list] of buckets) {
  if (!list.length) continue;
  total += list.length;
  lines.push(`## ${k}（${list.length}）`);
  lines.push('');
  lines.push('| 文件 | KB | 日期 |');
  lines.push('|---|---:|---|');
  for (const it of list) {
    const d = it.mtime.toISOString().slice(0, 10);
    lines.push(`| ${it.name} | ${(it.size / 1024).toFixed(0)} | ${d} |`);
  }
  lines.push('');
}
lines.push(`---`);
lines.push('');
lines.push(`共 ${total} 篇。自动生成：\`node scripts/doc-index.mjs\`（改完 docs 重跑一遍）。`);
lines.push('');

fs.writeFileSync(path.join(DOCS, 'README.md'), lines.join('\n'), 'utf8');
console.log('docs/README.md 已生成，篇数:', total);
for (const [k, list] of buckets) console.log(' ', k, list.length);
