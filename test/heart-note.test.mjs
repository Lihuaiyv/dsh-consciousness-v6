/**
 * heart_note：心事匣（单槽），由心跳的 light 落拍；醒来时进注入。
 *
 * 要保证的事：
 *   1) 第一拍能落；冷却期内不落；
 *   2) 写一句能进 systemPrompt；同样的字再写 = 保留；
 *   3) 露过之后没再碰，下一拍散掉；
 *   4) 超长 / 空拒绝；clear 能放下。
 * 运行：node test/heart-note.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import {
  heartNoteTick, heartNoteLines, writeHeartNote, readHeartNote,
  clearHeartNote, heartNoteStatus, heartNoteWakeTick,
} from '../src/modules/heartnote.js'
import { consciousnessBlock } from '../index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const T = Date.now()

// ① 一拍 + 写 + 注入
{
  const w = makeWorld()
  try {
    const beat = heartNoteTick(w.db, w.aid, T)
    check('第一拍能落', beat.ran === true && beat.beat === 1, beat)
    const wrote = writeHeartNote(w.db, w.aid, '把空匣子翻过来', T)
    check('写下心事', wrote.kept === false, wrote)
    // 真实路径：这一轮的 systemPrompt 组装，第一次就带上心事
    const block = consciousnessBlock(w.db, w.aid)
    check('systemPrompt 里读得到', block.includes('我上一条留给自己的话') && block.includes('把空匣子翻过来'), block.slice(0, 120))
    // 同一拍再次组装：不再挂（像一封信，不是便签）
    const again = heartNoteLines(w.db, w.aid, T)
    check('同一拍不再重复挂', again.length === 0, again)
  } finally { w.close() }
}

// ② 冷却期内不落
{
  const w = makeWorld()
  try {
    heartNoteTick(w.db, w.aid, T)
    const r = heartNoteTick(w.db, w.aid, T + 60 * 1000)
    check('冷却期内挡掉', r.ran === false && r.reason === 'cooldown', r)
  } finally { w.close() }
}

// ③ 超长拒绝、空拒绝
{
  const w = makeWorld()
  try {
    let over = false
    try { writeHeartNote(w.db, w.aid, '长'.repeat(121), T) } catch { over = true }
    check('超过 120 字拒绝', over)
    let empty = false
    try { writeHeartNote(w.db, w.aid, '   ', T) } catch { empty = true }
    check('空话拒绝', empty)
  } finally { w.close() }
}

// ④ 同样的字再写 = 保留；clear 放下
{
  const w = makeWorld()
  try {
    writeHeartNote(w.db, w.aid, '同样的', T)
    const r = writeHeartNote(w.db, w.aid, '同样的', T + 1000)
    check('同字保留', r.kept === true, r)
    check('clear 能放下', clearHeartNote(w.db, w.aid) !== null)
    check('放下后读不到', readHeartNote(w.db, w.aid) === null)
  } finally { w.close() }
}

// ⑤ 露过之后没再碰，下一拍散
{
  const w = makeWorld()
  try {
    heartNoteTick(w.db, w.aid, T)
    writeHeartNote(w.db, w.aid, '一句', T)
    heartNoteLines(w.db, w.aid, T)                        // 第 1 拍露过
    heartNoteTick(w.db, w.aid, T + 11 * 60000)            // 第 2 拍：不散
    heartNoteLines(w.db, w.aid, T + 11 * 60000)           // 第 2 拍露过
    const r = heartNoteTick(w.db, w.aid, T + 22 * 60000)  // 第 3 拍：散
    check('露过没再碰就散', r.dropped === '一句' && readHeartNote(w.db, w.aid) === null, r)
    check('status 能报拍数', heartNoteStatus(w.db, w.aid).beats === 3)
  } finally { w.close() }
}

// ⑥ 叫醒：默认关 / force 能醒 / 上一条没露过不叫 / 日上限
{
  const w = makeWorld()
  const setP = (key, v) => {
    w.db.prepare("INSERT INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?) " +
      "ON CONFLICT(agent_id,key) DO UPDATE SET value=excluded.value")
      .run(w.aid, key, JSON.stringify(v), new Date().toISOString())
  }
  try {
    let calls = 0
    const complete = async () => { calls++; return '第一行是这句\n第二行不要' }

    const r1 = await heartNoteWakeTick(w.db, w.aid, { complete, at: T })
    check('叫醒默认关着', r1.ran === false && r1.reason === 'off' && calls === 0, r1)

    const r2 = await heartNoteWakeTick(w.db, w.aid, { complete, at: T, force: true })
    check('force 能醒，只取第一行', r2.ran === true && r2.text === '第一行是这句', r2)

    setP('heart.note.wake', 'on')
    setP('heart.note.wake_every_beats', 1)
    heartNoteTick(w.db, w.aid, T + 11 * 60000)
    const r3 = await heartNoteWakeTick(w.db, w.aid, { complete, at: T + 12 * 60000 })
    check('上一条没露过就不叫', r3.ran === false && r3.reason === 'unread-note', r3)

    heartNoteLines(w.db, w.aid, T + 12 * 60000)
    heartNoteTick(w.db, w.aid, T + 23 * 60000)
    const r4 = await heartNoteWakeTick(w.db, w.aid, { complete, at: T + 24 * 60000 })
    check('露过之后能再醒', r4.ran === true && r4.text === '第一行是这句', r4)

    setP('heart.note.wake_max_per_day', 1)
    heartNoteTick(w.db, w.aid, T + 34 * 60000)
    const r5 = await heartNoteWakeTick(w.db, w.aid, { complete, at: T + 35 * 60000 })
    check('日上限挡得住', r5.ran === false && r5.reason === 'cap', r5)
  } finally { w.close() }
}

// ⑦ 同一拍只露一次：像一封信，不是贴屏幕的便签
{
  const w = makeWorld()
  try {
    heartNoteTick(w.db, w.aid, T)
    writeHeartNote(w.db, w.aid, '一封短的信', T)
    const a = heartNoteLines(w.db, w.aid, T)
    const b = heartNoteLines(w.db, w.aid, T + 1000)
    check('同一拍只露一次', a.length === 2 && b.length === 0, { a: a.length, b: b.length })
    heartNoteTick(w.db, w.aid, T + 11 * 60000)
    const c = heartNoteLines(w.db, w.aid, T + 11 * 60000)
    check('下一拍又能露', c.length === 2, c)
  } finally { w.close() }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
