/**
 * 盲拆对照：同一批话，带注入 / 不带注入各答一次，算「行为真的变了」的比例。
 *
 * 用法：
 *   node scripts/blind-diff.mjs pairs.json
 * pairs.json: [{ "id": "t1", "with_inject": "…", "without_inject": "…" }, …]
 *
 * 采集方式（需要模型可用）：取 20 句真实发言，对每句各跑一次 reply()，
 * 一次带 consciousnessBlock 的注入，一次不带，存成上面这个格式。这里只做判定。
 */
import fs from 'node:fs'
import { diffRate } from '../src/modules/sangguan/blind.js'

const file = process.argv[2]
if (!file || !fs.existsSync(file)) {
  console.error('用法：node scripts/blind-diff.mjs <pairs.json>')
  process.exit(2)
}
const pairs = JSON.parse(fs.readFileSync(file, 'utf8'))
const r = diffRate(pairs, { threshold: Number(process.argv[3]) || 0.4 })

console.log('样本 ' + r.n + ' 对，行为变了 ' + r.changed + ' 对，差异率 ' + r.rate + '（阈值 ' + r.threshold + '）')
for (const it of r.items) console.log('  ' + (it.changed ? '变' : '同') + '  ' + it.id + '  d=' + it.distance)

if (!r.n) {
  console.error('没有样本：不能把「没测」当成「没差别」。')
  process.exit(1)
}
if (r.rate === 0) {
  console.error('差异率为 0：注入没有改变它的说法。这时候切 live 只是把台词念得更响。')
  process.exit(1)
}
