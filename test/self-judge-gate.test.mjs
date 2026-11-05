/**
 * 自我记忆闸门 v2：三档分类 + 拿不准的批量问模型 + 超配额落冷层（不丢话）。
 * 运行：node test/self-judge-gate.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { writeExtractedItem, selfCountToday, selfWindowState } from '../src/features.js'
import { retrieve, deepRecall } from '../src/modules/retrieve.js'
import { classifySelf } from '../src/modules/memory_source.js'
import { ModelPort } from '../src/model.js'
import { getParam, setParam } from '../src/kernel.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-selfjudge-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_selfjudge'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '判留', 'daily', 'active', new Date().toISOString())
const row = (id) => db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)
const events = (type) => db.prepare('SELECT * FROM events WHERE agent_id=? AND type=?').all(aid, type)

// ---- 1. 三档分类 ----
const c1 = classifySelf('被用户一问，我心里有点发虚，于是当场补记了一句。')
check('含「我」开头不标准 → ok（放宽后不再要求「我」开头）', c1.tier === 'ok', c1)
const c2 = classifySelf('面板的冲突页面目前还没显示哪些旧纸条被替换，账本里已有记录')
check('通篇没有「我」→ unsure', c2.tier === 'unsure' && c2.why === 'no_me', c2)
const c3 = classifySelf('用户正在推进一个分步骤实现任务')
check('旁白 → drop 且落冷', c3.tier === 'drop' && c3.cold === true, c3)
const c4 = classifySelf('User: 我把日志贴出来了')
check('转写噪音 → drop 且不落冷', c4.tier === 'drop' && !c4.cold, c4)
const longText = '我把' + '很长的一段事'.repeat(60)
const c5 = classifySelf(longText)
check('超长不整条丢，截到 200', c5.tier === 'ok' && (c5.text || '').length === 200, { tier: c5.tier, len: (c5.text || '').length })
const c6 = classifySelf('我')
check('太短 → drop', c6.tier === 'drop', c6)

// ---- 2. 冷层通道 ----
const hot = writeExtractedItem(db, aid, { text: '我把摘要默认关掉了，刷新后确认不再写旁白', who: 'self' })
check('正常那条是热的', hot.action === 'new' && row(hot.id).temp_state !== 'cold', hot)
const n1 = writeExtractedItem(db, aid, { text: '用户正在整理潮汐表的顺序，希望按风险排序', who: 'self' })
const n1r = row(n1.id)
check('旁白 self 落冷而不是丢', !!n1r && n1r.temp_state === 'cold' && n1.cold === true, { n1, state: n1r && n1r.temp_state })
// 冷层只挡 S1 常规注入；S1 命中太弱时会自动升级 S3（深查），那里本来就该看得到。
const q1 = retrieve(db, aid, '潮汐表 顺序 风险', { k: 6, scene: 'S1', noUpgrade: true })
check('冷层不进常规召回', !q1.items.some((x) => x.id === n1.id), q1.items.map((x) => x.id))
const d1 = deepRecall(db, aid, '潮汐表 顺序 风险', { k: 5 })
check('冷层深查能翻到', d1.some((x) => x.id === n1.id), d1.map((x) => x.id))

// ---- 3. 拿不准的：没判 → 落冷；判留 → 热 ----
const unsureText = '面板的冲突页面目前还没显示哪些旧纸条被替换'
const u1 = writeExtractedItem(db, aid, { text: unsureText, who: 'self' })
check('拿不准且没判 → 冷层不丢', u1.action === 'drop' && u1.cold === true && !!u1.id, u1)
const u2 = writeExtractedItem(db, aid, { text: unsureText + '，只差界面显示', who: 'self' }, { selfDecision: () => ({ keep: true }) })
check('模型判留 → 正常落库', u2.action === 'new' && !!u2.id && row(u2.id).temp_state !== 'cold', u2)
const u3 = writeExtractedItem(db, aid, { text: '旧纸条替换记录在账本里', who: 'self' }, { selfDecision: () => ({ keep: false }) })
check('模型判扔 → 冷层 + 记原因 model', u3.action === 'drop' && u3.cold === true, u3)
const gj = events('memory.self_rejected').filter((e) => String(e.payload).includes('"model"'))
check('判扔记了 model 原因', gj.length >= 1, events('memory.self_rejected').map((e) => e.payload))

// ---- 4. 配额：超了落冷，不丢 ----
setParam(db, aid, 'self.per_window', { value: 1 })
setParam(db, aid, 'self.per_day', { value: 50 })
const w = selfWindowState(db, aid)
check('窗口状态可读', w.cap === 1 && w.left === 0, w)
const hotBefore = selfCountToday(db, aid)
const over = writeExtractedItem(db, aid, { text: '我把配额挡下来的那条也留成冷层了', who: 'self' })
check('超窗口 → cold 动作', over.action === 'cold' && over.cold === true, over)
check('冷条目不占配额', selfCountToday(db, aid) === hotBefore, { before: hotBefore, after: selfCountToday(db, aid) })
const coldRow = row(over.id)
check('超配额那条确实在冷层', coldRow && coldRow.temp_state === 'cold', coldRow && coldRow.temp_state)
const coldEv = events('memory.self_rejected').filter((e) => String(e.payload).includes('per_window'))
check('超配额记了 per_window', coldEv.length >= 1)
setParam(db, aid, 'self.per_window', { value: 2 })

// ---- 5. judgeSelf 批量解析（不真调模型） ----
{
  const fake = new ModelPort({
    available: () => true,
    chat: async () => '{"keep":[true,false,true]}',
  }, null)
  const got = await fake.judgeSelf(['我把阀门关上了', '面板还没刷新', '我数了三遍'])
  check('judgeSelf 批量解析', got && Array.isArray(got.keep) && got.keep.length === 3 && got.keep.join() === 'true,false,true', got)
  const short = await new ModelPort({ available: () => true, chat: async () => '{"keep":[true]}' }, null)
    .judgeSelf(['我把阀门关上了', '面板还没刷新'])
  check('模型少回时补 false 对齐条数', short && short.keep.length === 2 && short.keep[1] === false, short)
  const bad = await new ModelPort({ available: () => true, chat: async () => 'not json' }, null).judgeSelf(['x'])
  check('模型回垃圾 → null', bad === null, bad)
}

// ---- 6. 参数已登记且默认值对 ----
check('judge 默认开', getParam(db, aid, 'memory.write.self.judge') === 'on', getParam(db, aid, 'memory.write.self.judge'))
check('窗口小时默认 3', Number(getParam(db, aid, 'self.window_hours')) === 3)

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
