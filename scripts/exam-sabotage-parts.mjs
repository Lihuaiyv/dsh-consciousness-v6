/**
 * 新考卷打假：塞一个坏版本进实现，看考卷拦不拦。
 * 用法：node scripts/exam-sabotage-parts.mjs
 *
 * 两个坏版本：
 *   - 召回：把证据门放到 0（什么都放进来）；
 *   - 情绪评价：不再看「是不是冲我来的」（没点名的批评也算到她头上）。
 * 后面陆续补了：衰减忘太快、温度没迟滞、驱力迟滞失效 / 永不休眠、关系没上限 / 伤不再比暖快、
 * 写入闸不判旁白 / 低分也占热层。
 * 每个都要让对应考卷至少红一条；全拦住才 exit 0。
 * 改了 retrieve / appraise 的实现或考卷的 import 写法，这里也要跟着改。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const CASES = [
  {
    name: '召回：门放到 0',
    impl: 'src/modules/retrieve.js',
    exam: 'test/exam-recall.test.mjs',
    from: 'const gateVal = opt.keepAll ? 0.05 : GATE[scene]',
    to: 'const gateVal = 0',
    importFrom: "'../src/modules/retrieve.js'",
    importTo: "'../src/modules/retrieve.sabotage-0.js'",
  },
  {
    name: '情绪评价：不看是不是冲我来的',
    impl: 'src/algo/appraise.js',
    exam: 'test/exam-appraise.test.mjs',
    from: 'const neg = directed && critic && !praise',
    to: 'const neg = critic && !praise',
    importFrom: "'../src/algo/appraise.js'",
    importTo: "'../src/algo/appraise.sabotage-1.js'",
  },
  {
    name: '记忆衰减：可提取性忘得更快',
    impl: 'src/modules/tiers.js',
    exam: 'test/exam-tiers.test.mjs',
    from: 'return 1 / (1 + age / (9 * s))',
    to: 'return 1 / (1 + age / (3 * s))',
    importFrom: "'../src/modules/tiers.js'",
    importTo: "'../src/modules/tiers.sabotage-2.js'",
  },
  {
    name: '温度：去掉迟滞（降档立刻生效）',
    impl: 'src/modules/temps.js',
    exam: 'test/exam-tiers.test.mjs',
    from: 'const rising = RANK[want] > RANK[cur]',
    to: 'const rising = true',
    importFrom: "'../src/modules/temps.js'",
    importTo: "'../src/modules/temps.sabotage-3.js'",
  },
  {
    name: '驱力：迟滞失效（掉一点就降档）',
    impl: 'src/algo/deficit.js',
    exam: 'test/exam-drive.test.mjs',
    from: 'if (D < exit[id]) cur--',
    to: 'if (D < exit[id] + 0.1) cur--',
    importFrom: "'../src/algo/deficit.js'",
    importTo: "'../src/algo/deficit.sabotage-4.js'",
  },
  {
    name: '驱力：永远不休眠',
    impl: 'src/modules/drive.js',
    exam: 'test/exam-drive.test.mjs',
    from: 'const dormant = last ? Date.now() - Date.parse(last) > 14 * 86400000 : false',
    to: 'const dormant = false',
    importFrom: "'../src/modules/drive.js'",
    importTo: "'../src/modules/drive.sabotage-5.js'",
  },
  {
    name: '关系：单次变化不再设上限',
    impl: 'src/algo/reldyn.js',
    exam: 'test/exam-relation.test.mjs',
    from: 'dc = clamp(dc, -cap, cap)',
    to: 'dc = clamp(dc, -1, 1)',
    importFrom: "'../src/algo/reldyn.js'",
    importTo: "'../src/algo/reldyn.sabotage-6.js'",
  },
  {
    name: '关系：伤不再比暖快（对称）',
    impl: 'src/algo/reldyn.js',
    exam: 'test/exam-relation.test.mjs',
    from: 'rNeg: 0.12,',
    to: 'rNeg: 0.01,',
    importFrom: "'../src/algo/reldyn.js'",
    importTo: "'../src/algo/reldyn.sabotage-7.js'",
  },
  {
    name: '写入闸：旁白不再判（转述混进她自己的事）',
    impl: 'src/modules/memory_source.js',
    exam: 'test/exam-writegate.test.mjs',
    from: '  return NARRATION.some((re) => re.test(t))',
    to: '  return false',
    importFrom: "'../src/modules/memory_source.js'",
    importTo: "'../src/modules/memory_source.sabotage-8.js'",
  },
  {
    name: '写入闸：低分也占热层（按分量选人失效）',
    impl: 'src/modules/memory_source.js',
    exam: 'test/exam-writegate.test.mjs',
    from: '  if (verdict.keep && String(admission) === \'score\' && score < Number(minScore)) {',
    to: '  if (false) {',
    importFrom: "'../src/modules/memory_source.js'",
    importTo: "'../src/modules/memory_source.sabotage-9.js'",
  },
]

let pass = 0
let fail = 0
for (let i = 0; i < CASES.length; i++) {
  const c = CASES[i]
  const implPath = path.join(root, c.impl)
  const examPath = path.join(root, c.exam)
  const implText = fs.readFileSync(implPath, 'utf8')
  const examText = fs.readFileSync(examPath, 'utf8')
  if (!implText.includes(c.from)) {
    fail++
    console.log('FAIL ' + c.name + '：变异点没找到，脚本要跟着实现更新')
    continue
  }
  const mutant = implPath.replace(/\.js$/, '.sabotage-' + i + '.js')
  const examCopy = examPath.replace(/\.test\.mjs$/, '.sabotage-' + i + '.test.mjs')
  fs.writeFileSync(mutant, implText.replace(c.from, c.to))
  fs.writeFileSync(examCopy, examText.replace(c.importFrom, c.importTo))
  try {
    const r = spawnSync(process.execPath, [examCopy], { cwd: root, encoding: 'utf8', timeout: 120000 })
    const out = String(r.stdout || '') + String(r.stderr || '')
    const redLines = (out.match(/^FAIL /gm) || []).length
    if (r.status !== 0 && redLines > 0) {
      pass++
      console.log('PASS ' + c.name + '：卷子拦住（' + redLines + ' 条红）')
    } else {
      fail++
      console.log('FAIL ' + c.name + '：卷子没拦住（exit=' + r.status + '）')
      console.log('  ' + out.trim().split('\n').slice(-3).join(' | ').slice(0, 300))
    }
  } finally {
    try { fs.unlinkSync(mutant) } catch { /* 已删 */ }
    try { fs.unlinkSync(examCopy) } catch { /* 已删 */ }
  }
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
