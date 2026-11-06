/**
 * 生活流零件 · 考卷
 *
 * 管的是「她离开对话之后，有没有自己的事」：选一件她在意的事 → 出门看 / 只想想 → 写回记忆和事件。
 * 不管情绪怎么算（情绪动力）、不管记忆怎么召回（召回）、不管该不该开口（主动开口）。
 *
 * 运行：node test/exam-life.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { lifeTick, lifeLine, latestShare, pickLifeSubject, lifeCountToday, looksFabricated, LIFE } from '../src/modules/life.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const iso = (ms) => new Date(ms).toISOString()
const atDay = (h = 15) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.getTime() }
const wake = (w, at) => w.db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date(at - 60000).toISOString(), w.aid)
const pin = (w, key, value) => w.db.prepare(`INSERT INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)
  ON CONFLICT(agent_id,key) DO UPDATE SET value=excluded.value`).run(w.aid, key, JSON.stringify(value), new Date().toISOString())

function seedSubject(w, { text = '有点好奇，好感度到底是怎么慢慢涨上去的', source = 'self', type = 'appraisal' } = {}) {
  const id = 'mem_life_' + Math.random().toString(36).slice(2, 8)
  w.db.prepare(`INSERT INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,last_decay_at,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, w.aid, type, 'normal', text, source,
    0.5, 0.5, 1, 5, iso(Date.now()), 'active', iso(Date.now()))
  return id
}
function insEvent(w, type, payload, at) {
  const id = 'evt_' + Math.random().toString(36).slice(2, 10)
  w.db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(id, w.aid, type, JSON.stringify(payload), iso(at))
  return id
}
const eventsOf = (w, type) => w.db.prepare('SELECT payload FROM events WHERE agent_id=? AND type=? ORDER BY created_at DESC').all(w.aid, type).map((r) => JSON.parse(r.payload))
/** 清掉 makeWorld 铺的那三条记忆，留一张白纸测「选事」。 */
const clearMem = (w) => w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
const browseOk = async () => ({ items: [{ title: '看海攻略', url: 'https://example.com/sea', snippet: '海边风大，早晚凉。' }], answer: '带件外套。' })
const modelOk = { chat: async () => '海边风大，得带件外套。' }

// ================================================================ 选事：只从她自己在意的记忆里挑
{
  const w = makeWorld()
  try {
    const at = Date.now()
    clearMem(w)
    check('没有候选 → 选不出', pickLifeSubject(w.db, w.aid, at) === null)
    const id = seedSubject(w)
    const subj = pickLifeSubject(w.db, w.aid, at)
    check('有自述候选 → 选中', !!subj && subj.subject_id === id, subj)
    check('第一次选：不算续看', subj && subj.repeat === false, subj)

    insEvent(w, 'life.done', { id: 'lf_r1', kind: 'think', subject_id: id, subject: '那件事', summary: '想了想', share: false }, at - 86400000)
    const again = pickLifeSubject(w.db, w.aid, at)
    check('做过一次 → 标成续看', again && again.subject_id === id && again.repeat === true, again)

    insEvent(w, 'life.done', { id: 'lf_r2', kind: 'think', subject_id: id, subject: '那件事', summary: '又想了想', share: false }, at - 2 * 86400000)
    check('同一件做过两次 → 不再选', pickLifeSubject(w.db, w.aid, at) === null)
  } finally { w.close() }
}

{
  const w = makeWorld()
  try {
    const at = Date.now()
    clearMem(w)
    seedSubject(w, { text: '用户说过想看海' })
    check('「用户…」的候选不选', pickLifeSubject(w.db, w.aid, at) === null)
    seedSubject(w, { text: '有点好奇这件事', source: 'summary' })
    check('摘要腔（source=summary）不选', pickLifeSubject(w.db, w.aid, at) === null)
    seedSubject(w, { text: '想看' })
    check('太短的候选不选', pickLifeSubject(w.db, w.aid, at) === null)
    seedSubject(w, { text: '有点好奇，那阵子的风是怎么来的' })
    const ok = pickLifeSubject(w.db, w.aid, at)
    check('正常的「好奇」候选能选', !!ok, ok)
  } finally { w.close() }
}

// ================================================================ 什么时候不醒：门与预算
{
  const w = makeWorld()
  try {
    const at = atDay(15)
    seedSubject(w)
    pin(w, 'life.enabled', 'off')
    const off = await lifeTick(w.db, w.aid, { at, model: modelOk })
    check('开关关掉 → off', off.ok === false && off.skipped === 'off', off)
    check('开关关掉时选事也为空', pickLifeSubject(w.db, w.aid, at) === null)
    pin(w, 'life.enabled', 'on')
    w.db.prepare("UPDATE agents SET status='paused' WHERE id=?").run(w.aid)
    const inactive = await lifeTick(w.db, w.aid, { at, model: modelOk })
    check('人不在（paused）→ inactive', inactive.ok === false && inactive.skipped === 'inactive', inactive)
  } finally { w.close() }
}

{
  const w = makeWorld()
  try {
    const at = atDay(15)
    seedSubject(w)
    wake(w, at)
    w.db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(iso(at - 8 * 86400000), w.aid)
    const dormant = await lifeTick(w.db, w.aid, { at, model: modelOk })
    check('七天没说话 → dormant', dormant.ok === false && dormant.skipped === 'dormant', dormant)
  } finally { w.close() }
}

{
  const w = makeWorld()
  try {
    const at = atDay(3) // 凌晨三点：夜里
    seedSubject(w)
    wake(w, at)
    pin(w, 'life.night_think', 'off')
    const night = await lifeTick(w.db, w.aid, { at, model: modelOk })
    check('夜里且关了「想一想」→ night', night.ok === false && night.skipped === 'night', night)
  } finally { w.close() }
}

{
  const w = makeWorld()
  try {
    const at = atDay(15)
    seedSubject(w)
    wake(w, at)
    pin(w, 'life.per_day', 1)
    insEvent(w, 'life.done', { id: 'lf_done', kind: 'think', subject: '那件事', summary: '想了想', share: false }, at)
    const done = await lifeTick(w.db, w.aid, { at: at + 60000, model: modelOk })
    check('今天次数用完 → done_today', done.ok === false && done.skipped === 'done_today', done)
  } finally { w.close() }
}

{
  const w = makeWorld()
  try {
    const at = atDay(15)
    seedSubject(w)
    wake(w, at)
    pin(w, 'life.per_day', 8)
    pin(w, 'life.min_gap_hours', 1.5)
    insEvent(w, 'life.done', { id: 'lf_soon', kind: 'think', subject: '那件事', summary: '想了想', share: false }, at)
    const soon = await lifeTick(w.db, w.aid, { at: at + 10 * 60000, model: modelOk })
    check('十分钟前刚跑过 → too_soon', soon.ok === false && soon.skipped === 'too_soon', soon)
  } finally { w.close() }
}

{
  const w = makeWorld()
  try {
    const at = atDay(15)
    seedSubject(w)
    wake(w, at)
    insEvent(w, 'life.fail', { reason: 'empty' }, at)
    insEvent(w, 'life.fail', { reason: 'empty' }, at)
    const paused = await lifeTick(w.db, w.aid, { at: at + 60000, model: modelOk })
    check('今天连着失败两次 → paused', paused.ok === false && paused.skipped === 'paused', paused)
  } finally { w.close() }
}

{
  const w = makeWorld()
  try {
    const at = atDay(15)
    seedSubject(w)
    wake(w, at)
    pin(w, 'life.global_per_day', 2)
    // 另一个实例今天已经跑了两次：全局预算要挡住
    for (const aid of ['agt_a', 'agt_b']) {
      w.db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
        .run('evt_g_' + aid, aid, 'life.done', JSON.stringify({ id: 'lf_' + aid, summary: 'x' }), iso(at))
    }
    const global = await lifeTick(w.db, w.aid, { at: at + 60000, model: modelOk })
    check('全局预算用完 → global_budget', global.ok === false && global.skipped === 'global_budget', global)
  } finally { w.close() }
}

{
  const w = makeWorld()
  try {
    const at = atDay(15)
    clearMem(w)
    const nothing = await lifeTick(w.db, w.aid, { at, model: modelOk })
    check('没有在意的事 → nothing', nothing.ok === false && nothing.skipped === 'nothing', nothing)
  } finally { w.close() }
}

// ================================================================ 出门：看了就写，写不出就承认失败
{
  const w = makeWorld()
  try {
    const at = atDay(15)
    const sid = seedSubject(w)
    wake(w, at)
    let browsed = 0
    const browse = async (q) => { browsed++; return browseOk() }
    const out = await lifeTick(w.db, w.aid, { at, browse, model: modelOk })
    check('出门成功：interest', out.ok === true && out.kind === 'interest', out)
    check('真的调了浏览', browsed === 1, browsed)
    check('带回来源网址', Array.isArray(out.sources) && out.sources.some((s) => s.url), out.sources)
    const mem = w.db.prepare("SELECT id,text,type,source FROM memory_items WHERE agent_id=? AND source='life'").get(w.aid)
    check('写回一条记忆（source=life, episode）', !!mem && mem.type === 'episode', mem)
    const done = eventsOf(w, 'life.done')[0]
    check('事件带 summary / sources / subject_id', !!done && !!done.summary && done.subject_id === sid, done)
    check('有网址 + 冷却过 → 可分享', done && done.share === true, done)
    check('事件里记下记忆 id', done && !!done.memory_id, done)
  } finally { w.close() }
}

{
  const w = makeWorld()
  try {
    const at = atDay(15)
    seedSubject(w)
    wake(w, at)
    const browse = async () => { throw new Error('断网了') }
    const out = await lifeTick(w.db, w.aid, { at, browse, model: modelOk })
    check('浏览失败 → browse_failed', out.ok === false && out.skipped === 'browse_failed', out)
    const fails = eventsOf(w, 'life.fail')
    check('失败留痕 life.fail（不编「我去了」）', fails.length === 1 && /断网/.test(fails[0].reason || ''), fails)
    check('失败时不写生活事件', eventsOf(w, 'life.done').length === 0)
  } finally { w.close() }
}

{
  const w = makeWorld()
  try {
    const at = atDay(15)
    seedSubject(w)
    wake(w, at)
    const browse = async () => ({ items: [], answer: '' })
    const out = await lifeTick(w.db, w.aid, { at, browse, model: modelOk })
    check('浏览回来的东西是空的 → 也算失败', out.ok === false && out.skipped === 'browse_failed', out)
  } finally { w.close() }
}

// ================================================================ 只想想：编经历的一律不算
{
  const w = makeWorld()
  try {
    const at = atDay(15)
    seedSubject(w)
    wake(w, at)
    const out = await lifeTick(w.db, w.aid, { at, model: { chat: async () => '我去了海边，风很大。' } })
    check('模型编出「我去了」→ 不写', out.ok === false && out.skipped === 'no_model', out)
    check('编出来的不落生活事件', eventsOf(w, 'life.done').length === 0)
    check('留一条 life.fail', eventsOf(w, 'life.fail').length === 1)
  } finally { w.close() }
}

{
  const w = makeWorld()
  try {
    const at = atDay(15)
    seedSubject(w)
    wake(w, at)
    const out = await lifeTick(w.db, w.aid, { at, model: modelOk })
    check('只想想也能成：think', out.ok === true && out.kind === 'think', out)
    const done = eventsOf(w, 'life.done')[0]
    check('没出门就不标可分享', done && done.share === false, done)
    check('没有来源网址', !out.sources || out.sources.length === 0, out.sources)
  } finally { w.close() }
}

{
  const w = makeWorld()
  try {
    const at = atDay(15)
    seedSubject(w)
    wake(w, at)
    const out = await lifeTick(w.db, w.aid, { at, model: null })
    check('没有模型 → no_model，不编', out.ok === false && out.skipped === 'no_model', out)
  } finally { w.close() }
}

// ================================================================ 夜里不出门
{
  const w = makeWorld()
  try {
    const at = atDay(3)
    seedSubject(w)
    wake(w, at)
    let browsed = 0
    const browse = async () => { browsed++; return browseOk() }
    const out = await lifeTick(w.db, w.aid, { at, browse, model: modelOk })
    check('夜里：只想想，不碰浏览', browsed === 0, browsed)
    check('夜里也能成：think', out.ok === true && out.kind === 'think', out)
  } finally { w.close() }
}

// ================================================================ 注入与分享：一条、不重复、别日更
{
  const w = makeWorld()
  try {
    const at = atDay(15)
    seedSubject(w)
    wake(w, at)
    const out = await lifeTick(w.db, w.aid, { at, browse: browseOk, model: modelOk })
    check('先跑出一条生活', out.ok === true, out)

    const line = lifeLine(w.db, w.aid, at + 1000)
    check('注入行：说清是自己去看的', line.includes('前不久我自己去看了'), line)
    check('注入行带上那件事与那点想法', line.includes('海边') || line.includes('外套'), line)

    insEvent(w, 'life.done', { id: 'lf_second', kind: 'think', subject: '那阵风', summary: '想起海边的风', share: false, sources: [] }, at + 500)
    const line2 = lifeLine(w.db, w.aid, at + 2000)
    check('放过的先不重复放（还有别的时）', line2 !== line && line2.includes('前不久我自己想了想'), { line, line2 })

    const share = latestShare(w.db, w.aid, at + 1000)
    check('可分享的一条能取到', !!share && !!share.title, share)

    w.db.prepare("INSERT INTO proactive(id,agent_id,text,reason,created_at) VALUES(?,?,?,?,?)")
      .run('pr_life_1', w.aid, '分享一条生活', 'share:' + share.id + ':life', iso(at + 1500))
    const share2 = latestShare(w.db, w.aid, at + 2000)
    check('已经排进开口的不再取', share2 === null, share2)

    pin(w, 'life.enabled', 'off')
    check('关掉后注入行也没有', lifeLine(w.db, w.aid, at + 3000) === '')
    check('关掉后分享也没有', latestShare(w.db, w.aid, at + 3000) === null)
  } finally { w.close() }
}

// ================================================================ 小件：判「像不像编的」与当天计数
{
  check('「我去看了」像编的', looksFabricated('我去看了海') === true)
  check('「把薄荷浇透了」像编的', looksFabricated('我把薄荷浇透了') === true)
  check('「想了想那阵风」不像编的', looksFabricated('想了想那阵风') === false)
  const w = makeWorld()
  try {
    const at = atDay(15)
    check('今天还没跑：计数 0', lifeCountToday(w.db, w.aid, at) === 0)
    insEvent(w, 'life.done', { id: 'lf_c1', summary: 'x' }, at)
    check('跑过一条：计数 1', lifeCountToday(w.db, w.aid, at) === 1)
    check('LIFE 默认一天四次', LIFE.perDay === 4)
  } finally { w.close() }
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
