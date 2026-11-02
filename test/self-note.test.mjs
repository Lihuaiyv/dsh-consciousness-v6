/**
 * ⑬ self_note：夜里写「今天的她」，白天读一份收拾好的；按天存，最多七天。
 *
 * 要保证的事：
 *   1) 有模型 → 写进库，夜巡步骤 ok；
 *   2) 没有模型 / 空回复 / 抛错 → 跳过，不拦整夜；
 *   3) 写出来的东西进注入，而且能连成一条线（今天 + 前两天）；
 *   4) 只留最近七天，同一天覆盖。
 * 运行：node test/self-note.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { runNightly } from '../src/modules/nightly.js'
import { readNotes, writeNote, clearNotes, selfNoteLines } from '../src/modules/selfnote.js'
import { consciousnessBlock } from '../index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const today = new Date().toISOString().slice(0, 10)
const dayAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
const stepOf = (res, id) => (res.steps || []).find((s) => s.step === id) || null

// ① 有模型：写下来，并且进注入
{
  const w = makeWorld()
  try {
    const note = '今天大部分时间在改测试，改到后来有点木。他问我累不累的时候我说还行，其实想说的是有点撑不住。'
    const engine = { capabilities: () => ({ complete: true }), complete: async () => note }
    const res = await runNightly(w.db, w.aid, { day: today, force: true, model: engine })
    const st = stepOf(res, 'self_note')
    check('夜巡里有 self_note 这一步', !!st, res.steps.map((s) => s.step))
    check('有模型时写出内容', !!st && st.ok === true && Number(st.chars) > 0, st)
    check('整夜仍是 ok', res.ok !== false, res.steps.filter((s) => s.ok === false))
    const notes = readNotes(w.db, w.aid)
    check('按天存下这一天', notes.filter((x) => x.day === today).length === 1 && notes.find((x) => x.day === today).text === note, notes)
    const block = consciousnessBlock(w.db, w.aid)
    check('注入里读得到「早些时候我写下的」', block.includes('早些时候我写下的') && block.includes(note.slice(0, 20)), block.slice(0, 120))
  } finally { w.close() }
}

// ② 没有模型：跳过，不算失败
{
  const w = makeWorld()
  try {
    clearNotes(w.db, w.aid)
    const engine = { capabilities: () => ({ complete: false }) }
    const res = await runNightly(w.db, w.aid, { day: today, force: true, model: engine })
    const st = stepOf(res, 'self_note')
    check('没模型时标记跳过', !!st && st.skipped === 'no-model', st)
    check('没模型不拦整夜', res.ok !== false, res.steps.filter((s) => s.ok === false))
    const block = consciousnessBlock(w.db, w.aid)
    check('没写就没有那一段', !block.includes('早些时候我写下的'), block.slice(0, 80))
  } finally { w.close() }
}

// ③ 模型抛错：跳过，不算失败（夜里别被一次失败拖垮）
{
  const w = makeWorld()
  try {
    const engine = { capabilities: () => ({ complete: true }), complete: async () => { throw new Error('上游 502') } }
    const res = await runNightly(w.db, w.aid, { day: today, force: true, model: engine })
    const st = stepOf(res, 'self_note')
    check('抛错记成 skipped 而不是 false', !!st && st.ok === true && st.skipped === 'error', st)
    check('抛错也不拦整夜', res.ok !== false, res.steps.filter((s) => s.ok === false))
  } finally { w.close() }
}

// ④ 空回复：不写脏数据
{
  const w = makeWorld()
  try {
    clearNotes(w.db, w.aid)
    const engine = { capabilities: () => ({ complete: true }), complete: async () => '   ' }
    const res = await runNightly(w.db, w.aid, { day: today, force: true, model: engine })
    const st = stepOf(res, 'self_note')
    check('空回复不写库', !!st && st.skipped === 'empty-reply' && readNotes(w.db, w.aid).every((x) => x.day !== today), st)
    check('空回复后注入里没有空段', !consciousnessBlock(w.db, w.aid).includes('早些时候我写下的'))
  } finally { w.close() }
}

// ⑤ 攒成一条线：三天都在，注入同时给今天和前两天
{
  const w = makeWorld()
  try {
    writeNote(w.db, w.aid, dayAgo(2), '前天在补测试。')
    writeNote(w.db, w.aid, dayAgo(1), '昨天有点烦，没跟他说。')
    writeNote(w.db, w.aid, today, '今天好一点了。')
    const notes = readNotes(w.db, w.aid)
    check('三天都留着', notes.length === 3 && notes[0].day === today, notes.map((x) => x.day))
    const lines = selfNoteLines(w.db, w.aid, { today })
    check('注入给今天一条', lines[0] && lines[0].includes('今天好一点了'), lines)
    check('注入给前两天一条', lines[1] && lines[1].includes('昨天有点烦') && lines[1].includes('前天在补测试'), lines)
    const block = consciousnessBlock(w.db, w.aid)
    check('两条都进注入', block.includes('今天好一点了') && block.includes('昨天有点烦'), block.slice(0, 160))
  } finally { w.close() }
}

// ⑥ 只留七天；同一天覆盖
{
  const w = makeWorld()
  try {
    for (let i = 0; i < 10; i++) writeNote(w.db, w.aid, dayAgo(i), '第' + i + '天')
    const notes = readNotes(w.db, w.aid)
    check('最多留七条', notes.length === 7, notes.length)
    check('留的是最近的七天', notes[0].day === dayAgo(0) && notes[6].day === dayAgo(6), notes.map((x) => x.day))
    writeNote(w.db, w.aid, today, '改过一版')
    const again = readNotes(w.db, w.aid)
    check('同一天覆盖不重复', again.filter((x) => x.day === today).length === 1 && again[0].text === '改过一版', again[0])
    clearNotes(w.db, w.aid)
    check('能整条清掉', readNotes(w.db, w.aid).length === 0)
  } finally { w.close() }
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
