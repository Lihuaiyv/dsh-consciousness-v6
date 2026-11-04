/**
 * 生活流：每天一次、只读浏览、失败不编造、来源可区分。
 * 运行：node test/selfhood-life.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { lifeTick, lifeLine, latestShare, pickLifeSubject, lifeCountToday, LIFE } from '../src/modules/life.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}
// 测试用「今天」而不是写死的 2026-11-02：life.done 的 created_at 走真实时钟，
// 写死日期会在第二天变成「查的是昨天、事件记在今天」，整组用例无端变红。
const atDay = (h = 15) => {
  const d = new Date()
  d.setHours(h, 0, 0, 0)
  return d.getTime()
}
const browseOk = async () => ({ items: [{ title: '看海攻略', url: 'https://example.com/sea', snippet: '海边风大，要带外套。' }] })
const modelOk = { chat: async () => '嗯，海边风大，得带件外套。' }
const modelBad = { chat: async () => { throw new Error('no model') } }

function seedAgent(w) {
  w.db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date(atDay(12) - 60000).toISOString(), w.aid)
}

/** 按实例改生活流参数：默认值已经开大（一天 4 次、夜里也能想），这些用例要的是老口径。 */
function pin(w, key, value) {
  w.db.prepare(`INSERT INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(agent_id,key) DO UPDATE SET value=excluded.value`)
    .run(w.aid, key, JSON.stringify(value), new Date().toISOString())
}

// ---- 1. 夜间不生活（这一条测的是关掉「夜里想一想」时的老行为）
{
  const w = makeWorld()
  try {
    seedAgent(w)
    pin(w, 'life.night_think', 'off')
    const out = await lifeTick(w.db, w.aid, { at: atDay(3), browse: browseOk, model: modelOk })
    check('夜里 3 点不跑', out.ok === false && out.skipped === 'night', out)
  } finally { w.close() }
}

// ---- 2. 太久没互动：不替一个不理她的人过日子
{
  const w = makeWorld()
  try {
    w.db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date(atDay(15) - 20 * 86400000).toISOString(), w.aid)
    const out = await lifeTick(w.db, w.aid, { at: atDay(15), browse: browseOk, model: modelOk })
    check('20 天没互动 → dormant', out.ok === false && out.skipped === 'dormant', out)
  } finally { w.close() }
}

// ---- 3. 选事：只选她自己的偏好/在意，不碰 task 开环
{
  const w = makeWorld()
  try {
    seedAgent(w)
    const subj = pickLifeSubject(w.db, w.aid, atDay())
    check('选到「想去看海」那条', !!subj && subj.text.includes('看海'), subj)
    w.db.prepare(`INSERT INTO open_loops(id,agent_id,kind,text,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run('lp_task_1', w.aid, 'task', '去修那个脚本', 'open', new Date(atDay()).toISOString(), new Date(atDay()).toISOString())
    const again = pickLifeSubject(w.db, w.aid, atDay())
    check('task 开环不会被当成她自己的事', !again || !String(again.text).includes('修那个脚本'), again)
    // 第三人称摘要里即便出现「喜欢」，也不是她在意的事
    w.db.prepare(`INSERT INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,last_decay_at,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('mem_summary_like', w.aid, 'reflection', 'normal',
      '用户在这段对话中只说了「好了」，事实层面是给出确认信号，没有展开说明用户是否喜欢人格轴自动调整。', 'summary', 0.5, 0.5, 1, 5, new Date(atDay()).toISOString(), 'active', new Date(atDay()).toISOString())
    const third = pickLifeSubject(w.db, w.aid, atDay())
    check('摘要腔不会被当成她自己的事', !third || third.subject_id !== 'mem_summary_like', third)
  } finally { w.close() }
}

// ---- 4. 正常生活一次：事件 + 记忆来源 + 注入
{
  const w = makeWorld()
  try {
    seedAgent(w)
    const out = await lifeTick(w.db, w.aid, { at: atDay(), browse: browseOk, model: modelOk })
    check('生活成功', out.ok === true && out.kind === 'interest', out)
    check('有来源', Array.isArray(out.sources) && out.sources.length === 1, out.sources)
    check('当天计数 1', lifeCountToday(w.db, w.aid, atDay()) === 1)
    const mem = w.db.prepare("SELECT text,source FROM memory_items WHERE agent_id=? AND source='life'").get(w.aid)
    check('写进记忆且 source=life', !!mem && mem.text.includes('外套'), mem)
    const line = lifeLine(w.db, w.aid, atDay())
    check('注入里说「我自己去看了」', line.includes('我自己去看了') && line.includes('看海'), line)
    check('可分享', !!latestShare(w.db, w.aid, atDay()))
  } finally { w.close() }
}

// ---- 5. 每天只一次
{
  const w = makeWorld()
  try {
    seedAgent(w)
    pin(w, 'life.per_day', 1) // 这条测的是「一天一次」的老口径；默认已经开大到 4
    await lifeTick(w.db, w.aid, { at: atDay(), browse: browseOk, model: modelOk })
    const second = await lifeTick(w.db, w.aid, { at: atDay() + 3600000, browse: browseOk, model: modelOk })
    check('同一天第二次跳过', second.ok === false && second.skipped === 'done_today', second)
    const next = await lifeTick(w.db, w.aid, { at: atDay() + 86400000, browse: browseOk, model: modelOk })
    check('第二天没有被 done_today 挡', next.skipped !== 'done_today', next)
    // 铺一件新在意的事，第二天就能真的再生活
    w.db.prepare(`INSERT INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,last_decay_at,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('mem_new_like', w.aid, 'appraisal', 'normal', '主人好奇潮汐是怎么涨落的。', 'manual', 0.5, 0.5, 1, 5, new Date(atDay()).toISOString(), 'active', new Date(atDay() + 86400000).toISOString())
    const next2 = await lifeTick(w.db, w.aid, { at: atDay() + 86400000, browse: browseOk, model: modelOk })
    check('有新事 → 第二天可以再生活', next2.ok === true, next2)
  } finally { w.close() }
}

// ---- 6. 浏览失败：写 fail，不编造「我去看了」
{
  const w = makeWorld()
  try {
    seedAgent(w)
    const out = await lifeTick(w.db, w.aid, { at: atDay(), browse: async () => { throw new Error('网络断了') }, model: modelBad })
    check('失败返回 browse_failed', out.ok === false && out.skipped === 'browse_failed', out)
    check('没有 life.done', w.db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='life.done'").get(w.aid).n === 0)
    check('有 life.fail 留痕', w.db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='life.fail'").get(w.aid).n === 1)
    check('失败后注入为空', lifeLine(w.db, w.aid, atDay()) === '')
  } finally { w.close() }
}

// ---- 7. 没有浏览器但有模型：只能「想一想」，不能假装看了
{
  const w = makeWorld()
  try {
    seedAgent(w)
    const out = await lifeTick(w.db, w.aid, { at: atDay(), browse: null, model: modelOk })
    check('无浏览 → kind=think', out.ok === true && out.kind === 'think', out)
    const line = lifeLine(w.db, w.aid, atDay())
    check('注入说「想了想」不是说「看了」', line.includes('想了想') && !line.includes('去看了'), line)
  } finally { w.close() }
}

// ---- 8. 7 天内同一条最多续看一次
{
  const w = makeWorld()
  try {
    seedAgent(w)
    await lifeTick(w.db, w.aid, { at: atDay(), browse: browseOk, model: modelOk })
    const out2 = await lifeTick(w.db, w.aid, { at: atDay() + 86400000, browse: browseOk, model: modelOk })
    check('第二天可以续看一次', out2.ok === true && out2.kind === 'think', out2)
    const out3 = await lifeTick(w.db, w.aid, { at: atDay() + 2 * 86400000, browse: browseOk, model: modelOk })
    check('第三次 → nothing（同一条最多两次）', out3.ok === false && out3.skipped === 'nothing', out3)
  } finally { w.close() }
}

// ---- 9. 分享排过队就不再来
{
  const w = makeWorld()
  try {
    seedAgent(w)
    const out = await lifeTick(w.db, w.aid, { at: atDay(), browse: browseOk, model: modelOk })
    const share = latestShare(w.db, w.aid, atDay())
    check('先有可分享的', !!share && share.id === out.id, share)
    w.db.prepare('INSERT INTO proactive(id,agent_id,text,reason,dim,state,created_at,delivered_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('prc_share_1', w.aid, '海边风大', 'share:' + out.id, 'R', 'pending', new Date(atDay()).toISOString(), null)
    check('排过队后不再分享', latestShare(w.db, w.aid, atDay()) === null)
  } finally { w.close() }
}

// ---- 10. 开关能关
{
  const w = makeWorld()
  try {
    seedAgent(w)
    w.db.prepare('INSERT OR REPLACE INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)').run(w.aid, 'life.enabled', JSON.stringify('off'), new Date(atDay()).toISOString())
    const out = await lifeTick(w.db, w.aid, { at: atDay(), browse: browseOk, model: modelOk })
    check('life.enabled=off 时不动', out.ok === false && out.skipped === 'off', out)
    check('关掉后注入也没有', lifeLine(w.db, w.aid, atDay()) === '')
  } finally { w.close() }
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exit(1)
