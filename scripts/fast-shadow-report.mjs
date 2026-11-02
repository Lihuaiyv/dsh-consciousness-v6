/**
 * 快情绪影子档的数据：如果接线，会改多少。
 * 只读，不改任何行为。输出 docs/fast-shadow-<日期>.md。
 *   node scripts/fast-shadow-report.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { expressionState, shadowLevel } from '../src/modules/expression_state.js'

const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const slows = [-0.8, -0.6, -0.4, -0.2, 0, 0.2, 0.35, 0.5, 0.65, 0.8]
const fasts = [-0.8, -0.5, -0.2, 0, 0.2, 0.4, 0.6, 0.8]
const up = (a, b) => ['quiet', 'brief', 'normal', 'warm'].indexOf(a) < ['quiet', 'brief', 'normal', 'warm'].indexOf(b)

const rows = []
let changed = 0
let raised = 0
let lowered = 0
for (const slow of slows) {
  const line = []
  for (const fast of fasts) {
    const st = expressionState({ affect: { primary_label: 'calm', intensity: 0.5, v3: { slow, fast, total: slow } } })
    const would = st.wouldLevel
    const diff = would !== st.level
    if (diff) changed++
    if (diff && up(st.level, would)) raised++
    if (diff && !up(st.level, would)) lowered++
    line.push(diff ? (up(st.level, would) ? '↑' : '↓') : '·')
  }
  rows.push('| ' + slow.toFixed(2) + ' | ' + line.join(' ') + ' |')
}

const total = slows.length * fasts.length
const md = [
  '# 快情绪影子档 · ' + new Date().toISOString().slice(0, 10),
  '',
  '只算不生效：这一版 `level` 仍然只看慢情绪（`v3.slow`）。下面是「如果接上快情绪会怎样」的分布。',
  '',
  '行 = 慢情绪 slow，列 = 快情绪 fast（' + fasts.map((f) => f.toFixed(1)).join(' / ') + '）。',
  '',
  '| slow | ' + fasts.map((f) => f.toFixed(1)).join(' | ') + ' |',
  '|' + '---|'.repeat(fasts.length + 1),
  ...rows,
  '',
  '- 会改档的组合：' + changed + ' / ' + total + '（' + Math.round((changed / total) * 100) + '%）',
  '- 其中抬档 ' + raised + ' 次、压档 ' + lowered + ' 次。',
  '- 规则：fast ≥ 0.35 且 slow > -0.2 → 抬一档；fast ≤ -0.35 → 压一档；封顶封底不越界。',
  '- 要怎么用：抬档只影响「说多少 / 要不要展开」，不改温度与关系；压档同样不碰关系。',
  '',
  '结论（给人看的）：如果只想要「刚被扎一下会立刻反应」的效果，抬档就够；压档会和她低落时的安静叠在一起，容易更闷，建议先只接抬档。',
  '',
].join('\n')

fs.writeFileSync(path.join(dir, 'docs', 'fast-shadow-' + new Date().toISOString().slice(0, 10) + '.md'), md, 'utf8')
console.log('会改档组合', changed, '/', total, '；抬', raised, '；压', lowered)
console.log('报告：docs/fast-shadow-' + new Date().toISOString().slice(0, 10) + '.md')
