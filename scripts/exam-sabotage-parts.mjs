/**
 * 新考卷打假：塞一个坏版本进实现，看考卷拦不拦。
 * 用法：node scripts/exam-sabotage-parts.mjs
 *
 * 两个坏版本：
 *   - 召回：把证据门放到 0（什么都放进来）；
 *   - 情绪评价：不再看「是不是冲我来的」（没点名的批评也算到她头上）。
 * 后面陆续补了：衰减忘太快、温度没迟滞、驱力迟滞失效 / 永不休眠、关系没上限 / 伤不再比暖快、
 * 写入闸不判旁白 / 低分也占热层、注入丢保不丢边、说话分寸没迟滞、开环到期门、日记回声门、情绪动力衰减、感受 AI 味闸。
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
  {
    name: '注入：丢弃次序反过来（先丢最保的）',
    impl: 'src/modules/pack.js',
    exam: 'test/exam-inject.test.mjs',
    from: "const DROP_ORDER = ['T4', 'T2', 'T3', 'T1', 'buffer']",
    to: "const DROP_ORDER = ['buffer', 'T1', 'T3', 'T2', 'T4']",
    importFrom: "'../src/modules/pack.js'",
    importTo: "'../src/modules/pack.sabotage-10.js'",
  },
  {
    name: '注入：软收口失效（一律硬切加省略号）',
    impl: 'src/modules/pack.js',
    exam: 'test/exam-inject.test.mjs',
    from: 'if (SOFT_BOUNDARY.test(chars[i])) { cut = i; break }',
    to: 'if (false) { cut = i; break }',
    importFrom: "'../src/modules/pack.js'",
    importTo: "'../src/modules/pack.sabotage-11.js'",
  },
  {
    name: '说话分寸：低落压不过外向（低落也多说一句）',
    impl: 'src/algo/expression.js',
    exam: 'test/exam-expression.test.mjs',
    from: "if (e >= 0.65 && sentences < 4 && i <= 0.6 && level !== 'quiet') sentences += 1",
    to: 'if (e >= 0.65 && sentences < 4 && i <= 0.6) sentences += 1',
    importFrom: "'../src/algo/expression.js'",
    importTo: "'../src/algo/expression.sabotage-12.js'",
  },
  {
    name: '说话分寸：迟滞失效（慢情绪一动就换脸）',
    impl: 'src/modules/expression_state.js',
    exam: 'test/exam-expression.test.mjs',
    from: 'if (Math.abs(slow - Number(prev.slow)) < 0.08) level = prev.level',
    to: 'if (Math.abs(slow - Number(prev.slow)) < 0) level = prev.level',
    importFrom: "'../src/modules/expression_state.js'",
    importTo: "'../src/modules/expression_state.sabotage-13.js'",
  },
  {
    // 主动开口的卷子从 features 拿全部名字；这里只换 decideSpeak 的来源，其余照旧。
    // 变异点：气头门拆掉（气头上还开口）。
    name: '主动开口：气头上也开口（气头门失效）',
    impl: 'src/parts/speak/judge.js',
    exam: 'test/exam-speak.test.mjs',
    from: "const hot = !!af0 && ['irritated', 'frustrated'].includes(String(af0.primary_label)) && Number(af0.intensity) > 0.68",
    to: 'const hot = false',
    importFrom: "import { decideSpeak, proactiveTriggerOf, setProactivePrefs, budgetGet, proactiveSpend, addProactiveSpend } from '../src/features.js'",
    importTo: "import { proactiveTriggerOf, setProactivePrefs, budgetGet, proactiveSpend, addProactiveSpend } from '../src/features.js'\nimport { decideSpeak } from '{MUTANT}'",
  },
  {
    // 变异点：把「通道优先」拆掉，永远落到主人（回到各写各的旧路子）。
    name: '认人：通道绑了别人也认成主人（通道门失效）',
    impl: 'src/modules/who.js',
    exam: 'test/exam-who.test.mjs',
    from: '  if (byChannel) return { ...byChannel, source: \'channel\' }',
    to: '  if (false && byChannel) return { ...byChannel, source: \'channel\' }',
    importFrom: "'../src/modules/who.js'",
    importTo: "'{MUTANT}'",
  },
  {
    // 变异点：到期的判据拔掉——所有挂着的事都不冒头。
    name: '开环：到期也不冒出来（到期门失效）',
    impl: 'src/parts/loops/index.js',
    exam: 'test/exam-loops.test.mjs',
    from: '    const ready = (Number.isFinite(due) && due <= at) || (Number.isFinite(stale) && stale <= at)',
    to: '    const ready = false',
    importFrom: "'../src/modules/loops.js'",
    importTo: "'{MUTANT}'",
  },
  {
    // 变异点：抄回来的提示词原句不再拦（回声门失效）。
    name: '日记：抄提示词不拦（回声门失效）',
    impl: 'src/modules/diary.js',
    exam: 'test/exam-diary.test.mjs',
    from: '  if (/你在写这一天的日记|只写材料里出现|不要用 Markdown/.test(s)) return true',
    to: '  if (false && /你在写这一天的日记|只写材料里出现|不要用 Markdown/.test(s)) return true',
    importFrom: "'../src/modules/diary.js'",
    importTo: "'{MUTANT}'",
  },
  {
    // 变异点：衰减完反而把强度抬高（衰减不落）。
    name: '情绪动力：衰减反而抬高（衰减不落）',
    impl: 'src/parts/affect/index.js',
    exam: 'test/exam-affect-apply.test.mjs',
    from: '    .run(out.intensity, moodAlias, now(), aid)',
    to: '    .run(Math.min(1, Number(r.intensity) + 0.15), moodAlias, now(), aid)',
    importFrom: "'../src/parts/affect/index.js'",
    importTo: "'{MUTANT}'",
  },
  {
    // 变异点：AI 味闸失效——「感觉」这类词也放进来。
    name: '感受：AI 味闸失效（「感觉」也放进来）',
    impl: 'src/modules/feel.js',
    exam: 'test/feel-tool.test.mjs',
    from: "  for (const w of FEEL_BANNED) if (t.includes(w)) return { reason: 'ai-word', word: w }",
    to: "  for (const w of FEEL_BANNED) if (false) return { reason: 'ai-word', word: w }",
    importFrom: "'../src/modules/feel.js'",
    importTo: "'{MUTANT}'",
  },
  {
    // 变异点：夜里也出门（夜间门失效）——半夜爬起来去翻网。
    name: '生活流：夜里也出门（夜间门失效）',
    impl: 'src/modules/life.js',
    exam: 'test/exam-life.test.mjs',
    from: "  if (typeof browse === 'function' && !subj.repeat && !night) {",
    to: "  if (typeof browse === 'function' && !subj.repeat) {",
    importFrom: "'../src/modules/life.js'",
    importTo: "'{MUTANT}'",
  },
  {
    // 变异点：单次改动上限放到 0.5——语气一暖就把快情绪推得很高。
    name: '自我回读：单次改动的上限失守（越暖推得越狠）',
    impl: 'src/modules/self_read.js',
    exam: 'test/exam-selfread.test.mjs',
    from: 'delta = Math.round(CLAMP(delta, -0.02, 0.02) * 1000) / 1000',
    to: 'delta = Math.round(CLAMP(delta, -0.5, 0.5) * 1000) / 1000',
    importFrom: "'../src/modules/self_read.js'",
    importTo: "'{MUTANT}'",
  },
  {
    // 变异点：没素材也硬写——宁可编一条「今天我怎么过的」也不让空着。
    name: '自我记忆：没素材也硬写（空素材门失效）',
    impl: 'src/modules/self_memory.js',
    exam: 'test/exam-selfmemory.test.mjs',
    from: "  if (!material) return { skipped: 'no_material' }",
    to: '  if (false) return { skipped: \'no_material\' }',
    importFrom: "'../src/modules/self_memory.js'",
    importTo: "'{MUTANT}'",
  },
  {
    // 变异点：两条也算一批——没重复也硬合并。
    name: '记忆整理：两条也算一批（够批门失效）',
    impl: 'src/modules/consolidate.js',
    exam: 'test/exam-consolidate.test.mjs',
    from: '    if (members.length < 3) { seed.used = true; continue }',
    to: '    if (members.length < 1) { seed.used = true; continue }',
    importFrom: "'../src/modules/consolidate.js'",
    importTo: "'{MUTANT}'",
  },
  {
    // 变异点：完全重复也新建——同一个抽屉里塞两条一样的话。
    name: '记忆存储：重复也新建（去重门失效）',
    impl: 'src/modules/memory.js',
    exam: 'test/exam-memorystore.test.mjs',
    from: "  if (kind === 'duplicate') {",
    to: '  if (false) {',
    importFrom: "'../src/modules/memory.js'",
    importTo: "'{MUTANT}'",
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
  // {MUTANT}：从考卷目录出发的相对路径，给需要换单个函数来源的卷子用（比如开口从 features 拿一半名字）
  const mutantRel = path.relative(path.dirname(examPath), mutant).replace(/\\/g, '/')
  fs.writeFileSync(mutant, implText.replace(c.from, c.to))
  fs.writeFileSync(examCopy, examText.replace(c.importFrom, String(c.importTo || '').replaceAll('{MUTANT}', mutantRel)))
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
