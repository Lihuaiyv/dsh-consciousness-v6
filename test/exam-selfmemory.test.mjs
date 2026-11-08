/**
 * 自我记忆零件 · 考卷
 *
 * 管的是「她夜里把自己怎么过的写成一条记忆」：当天素材 → 模型写成第一人称 →
 * 过闸门 → 一天一条落库；外加「今晚想明白的一件事」。
 *
 * 不管「这条记忆怎么衰减」（记忆衰减与分层）、不管「值不值得记」（记忆写入闸）、
 * 不管「白天那些碎片怎么抽」（记忆写入闸）。
 *
 * 运行：node test/exam-selfmemory.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { selfDayMaterial, writeSelfDay, selfInsightMaterial, writeSelfInsight } from '../src/modules/self_memory.js'
import { localDay } from '../src/db.js'
import { writeParam } from '../src/kernel.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const today = localDay()
const iso = (ms) => new Date(ms).toISOString()
const addMem = (w, text, source = 'self', created = Date.now(), factKey = null) => {
  const id = 'mem_sm_' + Math.random().toString(36).slice(2, 8)
  w.db.prepare(`INSERT INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,last_decay_at,status,created_at,fact_key)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, w.aid, 'episode', 'normal', text, source,
    0.5, 0.5, 1, 5, iso(created), 'active', iso(created), factKey)
  return id
}
const addLife = (w, summary, kind, at = Date.now()) => {
  w.db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
    .run('evt_' + Math.random().toString(36).slice(2), w.aid, 'life.done', JSON.stringify({ id: 'lf_x', kind, summary }), iso(at))
}
const chatOnce = (text) => { let n = 0; const f = async () => { n++; return text }; f.calls = () => n; return f }

// ================================================================ 当天素材
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
    check('没有素材：空', selfDayMaterial(w.db, w.aid, today) === '')
    addMem(w, '我今天把那段测试又跑了一遍')
    check('自己的条目进素材', selfDayMaterial(w.db, w.aid, today).includes('把那段测试又跑了一遍'))
    addMem(w, '往窗外看了很久', 'life')
    check('生活流写的条目也进素材', selfDayMaterial(w.db, w.aid, today).includes('往窗外看了很久'))
    addMem(w, '昨天的一条', 'self', Date.now() - 2 * 86400000)
    check('昨天的条目不进', !selfDayMaterial(w.db, w.aid, today).includes('昨天的一条'))
    addLife(w, '那阵风是怎么来的', 'think')
    check('夜里想过的：写成「想了」', selfDayMaterial(w.db, w.aid, today).includes('我自己想了'))
    addLife(w, '海边风大', 'interest')
    check('出门看过的：写成「去看」', selfDayMaterial(w.db, w.aid, today).includes('我自己去看'))
    w.db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run('evt_bad_' + w.aid, w.aid, 'life.done', '{坏掉的', iso(Date.now()))
    check('坏 payload 不炸', typeof selfDayMaterial(w.db, w.aid, today) === 'string')
  } finally { w.close() }
}

// ================================================================ 写当天那条：门与素材
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
    writeParam(w.db, w.aid, 'memory.write.self', 'off')
    const off = await writeSelfDay(w.db, w.aid, today, { chat: chatOnce('我想明白了，以后不把话说满') })
    check('总开关关掉：off', off.skipped === 'off', off)
    writeParam(w.db, w.aid, 'memory.write.self', 'on')
    writeParam(w.db, w.aid, 'memory.write.self.daily', 'off')
    const dailyOff = await writeSelfDay(w.db, w.aid, today, { chat: chatOnce('我想明白了，以后不把话说满') })
    check('日更关掉：daily_off', dailyOff.skipped === 'daily_off', dailyOff)
    writeParam(w.db, w.aid, 'memory.write.self.daily', 'on')
    const noMat = await writeSelfDay(w.db, w.aid, today, { chat: chatOnce('我想明白了，以后不把话说满') })
    check('没有素材：no_material', noMat.skipped === 'no_material', noMat)
    addMem(w, '我今天把那段测试又跑了一遍')
    const noModel = await writeSelfDay(w.db, w.aid, today, { chat: null })
    check('没有模型：no_model', noModel.skipped === 'no_model', noModel)
  } finally { w.close() }
}

// ================================================================ 写当天那条：成与不成
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
    addMem(w, '我今天把那段测试又跑了一遍')
    const chat = chatOnce('我想明白了，以后不把话说满')
    const ok = await writeSelfDay(w.db, w.aid, today, { chat })
    check('过得去就写', ok.ok === true && !!ok.id, ok)
    const row = w.db.prepare('SELECT text,type,source,importance,fact_key FROM memory_items WHERE id=?').get(ok.id)
    check('落成 episode / self / 一天一条的键', row && row.type === 'episode' && row.source === 'self' && row.fact_key === 'self.day.' + today, row)
    check('分量 0.55', Number(row.importance) === 0.55, row)
    const again = await writeSelfDay(w.db, w.aid, today, { chat })
    check('同一天再跑：exists，不写第二条', again.skipped === 'exists', again)
    check('真只有一条', w.db.prepare('SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND fact_key=?').get(w.aid, 'self.day.' + today).n === 1)
  } finally { w.close() }
}

// ================================================================ 写当天那条：太长再问一次
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
    addMem(w, '我今天把那段测试又跑了一遍')
    let n = 0
    const chat = async () => {
      n++
      return n === 1 ? '我' + '想'.repeat(200) : '我想明白了，以后不把话说满'
    }
    const out = await writeSelfDay(w.db, w.aid, today, { chat })
    check('太长：问第二次，收紧了就写', out.ok === true && n === 2, { out, n })
  } finally { w.close() }
}

// ================================================================ 写当天那条：旁白不重试、二次仍不过
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
    addMem(w, '我今天把那段测试又跑了一遍')
    let n = 0
    const narrationChat = async () => { n++; return '用户正在推进一个新的需求' }
    const narr = await writeSelfDay(w.db, w.aid, today, { chat: narrationChat })
    check('旁白：不重试，直接不写', narr.skipped === 'gate' && narr.why === 'narration' && n === 1, { narr, n })

    let m = 0
    const badChat = async () => { m++; return '好' }
    const bad = await writeSelfDay(w.db, w.aid, today, { chat: badChat })
    check('两次都不过：gate', bad.skipped === 'gate' && m === 2, { bad, m })

    const throwChat = async () => { throw new Error('模型挂了') }
    const failed = await writeSelfDay(w.db, w.aid, today, { chat: throwChat })
    check('模型抛错：model_failed', failed.skipped === 'model_failed', failed)
    check('一条都没落', w.db.prepare('SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND source=?').get(w.aid, 'self').n === 1)
  } finally { w.close() }
}

// ================================================================ 想明白的那条：素材与门槛
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
    addMem(w, '我今天把那段测试又跑了一遍', 'self', Date.now(), 'self.day.' + today)
    check('流水那条不算想明白的素材', selfInsightMaterial(w.db, w.aid, today) === '')
    addMem(w, '我今天忽然发现，怕的不是做错，是没人告诉我做对没有')
    check('自己的条目进素材', selfInsightMaterial(w.db, w.aid, today).includes('怕的不是做错'))
    addLife(w, '那阵风是怎么来的', 'think')
    check('夜里想过的进素材', selfInsightMaterial(w.db, w.aid, today).includes('我想过'))
  } finally { w.close() }
}

// ================================================================ 想明白的那条：写与不写
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
    addMem(w, '我今天把那段测试又跑了一遍', 'self', Date.now(), 'self.day.' + today)
    const thin = await writeSelfInsight(w.db, w.aid, today, { chat: chatOnce('我想明白了，以后不把话说满') })
    check('素材太少：thin', thin.skipped === 'thin', thin)

    addMem(w, '我今天忽然发现，怕的不是做错，是没人告诉我做对没有')
    addMem(w, '我想通了，等准话这件事本身比做错还耗人')
    const okChat = chatOnce('我想明白了，怕的不是做错，是没人告诉我做对没有，这话说起来有点难为情。')
    const ok = await writeSelfInsight(w.db, w.aid, today, { chat: okChat })
    check('够料就写', ok.ok === true && !!ok.id, ok)
    const row = w.db.prepare('SELECT text,type,source,importance,fact_key FROM memory_items WHERE id=?').get(ok.id)
    check('落成 reflection / self / 想明白的键', row && row.type === 'reflection' && row.fact_key === 'self.insight.' + today, row)
    check('分量 0.65', Number(row.importance) === 0.65, row)
    const again = await writeSelfInsight(w.db, w.aid, today, { chat: okChat })
    check('同一天再跑：exists', again.skipped === 'exists', again)

    w.db.prepare('DELETE FROM memory_items WHERE agent_id=? AND fact_key=?').run(w.aid, 'self.insight.' + today)
    const flat = await writeSelfInsight(w.db, w.aid, today, { chat: chatOnce('我把测试跑了一遍又一遍，最后全绿才合上电脑。') })
    check('只是流水账（没有想明白的词）：flat', flat.skipped === 'flat', flat)

    const short = await writeSelfInsight(w.db, w.aid, today, { chat: chatOnce('我想明白了一件事。') })
    check('太短：length', short.skipped === 'length', short)
  } finally { w.close() }
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
