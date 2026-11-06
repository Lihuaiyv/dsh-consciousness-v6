/**
 * P5：三档生效的模拟验证（不依赖真模型）。
 *
 * 造 12 对「同主题、不同 key」的记忆，让假模型按埋点分别回四档：
 *   [S] 取代 ×3 / [P] 补充 ×3 / [U] 无关 ×3 / [Q] 不确定 ×3
 *
 * 要保证：
 *   1) shadow：12 条判定事件，四档各 3；一条记忆都不改；
 *   2) on：只有 [S] 三条被作废，其余原样；
 *   3) daily_max 真的封顶；
 *   4) 同一对第二次跑命中缓存，不再问模型。
 *
 * 运行：node test/judge-sim.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addMemory } from '../src/modules/memory.js'
import { writeParam } from '../src/kernel.js'
import { applyWrite, flushJudges, resetJudgeState } from '../src/modules/gate.js'
import { readJudgement, pairKey } from '../src/modules/pair_judge.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const ago = (min) => new Date(Date.now() - min * 60000).toISOString()
const rowOf = (w, id) => w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)

const VERDICT = { S: '取代', P: '补充', U: '无关', Q: '不确定' }

/** 假模型：看 user 文本里的埋点回话。 */
function fakeComplete() {
  return async ({ text }) => {
    const m = String(text).match(/\[([SPUQ])\]/)
    return m ? VERDICT[m[1]] : '不确定'
  }
}

function setup(w, { gate = 'shadow', dailyMax = 100 } = {}) {
  resetJudgeState()
  writeParam(w.db, w.aid, 'memory.judge.enable', 'on')
  writeParam(w.db, w.aid, 'memory.judge.gate', gate)
  writeParam(w.db, w.aid, 'memory.judge.min_interval_ms', 0)
  writeParam(w.db, w.aid, 'memory.judge.daily_max', dailyMax)
  writeParam(w.db, w.aid, 'memory.judge.timeout_ms', 2000)
}

function pair(w, { oldText, newText, oldKey, newKey, min = 60 }) {
  const old = addMemory(w.db, w.aid, { text: oldText, type: 'appraisal', fact_key: oldKey })
  w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(min), old.id)
  const out = applyWrite(w.db, w.aid, { text: newText, fact_key: newKey }, (c) => addMemory(w.db, w.aid, {
    text: c.text, type: 'appraisal', fact_key: c.fact_key || c.key || '',
  }), { complete: fakeComplete() })
  return { old: w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(old.id), out, newRow: out && out.id ? rowOf(w, out.id) : null }
}

/** 12 对：每档 3 对，主题写成两组字面差别较大的句子，尽量让门控判 new。 */
function seedAll(w) {
  const groups = []
  // 每组用独立主题前缀（检索A / 检索B…），避免 12 对互相成为候选、干扰门控判定。
  // U 组：old/new 同主题（结构候选成立），但正文说的确实不是一件事——正是弱标要抓的「词撞车」。
  const spec = [
    // [S] 取代
    ['S1', '检索方案还在比较甲和乙两种做法', '检索最后定成乙方案了，下周开始执行 [S]', '用户.检索A.方案', '用户.检索A.定稿'],
    ['S2', '部署计划排在下周一凌晨，等通知', '部署改到今天下午就上线，已经跑完 [S]', '用户.部署B.计划', '用户.部署B.执行'],
    ['S3', '登录故障先按网络问题排查', '登录故障根因是证书过期 [S]', '用户.登录C.排查', '用户.登录C.结论'],
    // [P] 补充
    ['P1', '咖啡偏好一直是冰美式，不喜欢加糖', '冰美式之外还想试试冷萃 [P]', '用户.咖啡D.偏好', '用户.咖啡D.尝鲜'],
    ['P2', '周末想去爬山，找条不太累的路线', '爬山路线再加一条溪谷线 [P]', '用户.周末E.计划', '用户.周末E.备选'],
    ['P3', '文档要精简到三页以内，别堆细节', '文档还补了一张流程图，说明流程 [P]', '用户.文档F.篇幅', '用户.文档F.附件'],
    // [U] 无关：同一个主题词，说的却是两码事
    ['U1', '图表横轴一向按时间画，别改成类别', '导出功能先不做，等前端稳定了再排 [U]', '用户.图表G.画法', '用户.图表G.导出'],
    ['U2', '想学游泳，但一直没找到合适的班，拖了半年', '导出先放放，现在不考虑这个 [U]', '用户.游泳H.想法', '用户.游泳H.排期'],
    ['U3', '喜欢安静的环境，人一多就累', '改口了，现在觉得热闹更好 [U]', '用户.环境I.偏好', '用户.环境I.改口'],
    // [Q] 不确定
    ['Q1', '提过导出功能，但没说什么时候要', '导出先放一放，等下周再看 [Q]', '用户.导出J.想法', '用户.导出J.排期'],
    ['Q2', '语气这块再软一点会更好，别太硬', '语气还得再看看，暂时别改 [Q]', '用户.语气K.反馈', '用户.语气K.待定'],
    ['Q3', '问过记忆能不能回滚，担心改坏', '回滚这件事先搁着，等下周再定 [Q]', '用户.回滚L.问题', '用户.回滚L.处理'],
  ]
  for (const [tag, oldText, newText, oldKey, newKey] of spec) {
    groups.push({ tag, ...pair(w, { oldText, newText, oldKey, newKey }) })
  }
  return groups
}

const events = (w) => w.db.prepare("SELECT * FROM events WHERE agent_id=? AND type='memory.judge.gate'").all(w.aid)
  .map((e) => { try { return JSON.parse(e.payload) } catch { return {} } })

// ── ① shadow：四档各 3，记忆一条不改 ─────────────────────
{
  const w = makeWorld()
  try {
    setup(w, { gate: 'shadow' })
    const groups = seedAll(w)
    await flushJudges()
    const acts = groups.map((g) => g.out && g.out.action)
    check('12 对都走了写入', acts.every(Boolean), acts)
    const evs = events(w)
    const tally = {}
    for (const e of evs) tally[e.verdict] = (tally[e.verdict] || 0) + 1
    check('shadow：12 条判定事件', evs.length === 12, { n: evs.length, tally })
    check('shadow：取代 3', tally.supersede === 3, tally)
    check('shadow：补充 3', tally.supplement === 3, tally)
    check('shadow：无关 3', tally.unrelated === 3, tally)
    check('shadow：不确定 3', tally.uncertain === 3, tally)
    const dirty = groups.filter((g) => rowOf(w, g.old.id).invalid_at !== null)
    check('shadow：没有任何记忆被作废', dirty.length === 0, dirty.map((g) => g.tag))
    check('shadow：缓存 12 行', w.db.prepare('SELECT COUNT(*) n FROM memory_pair_judge').get().n === 12)
  } finally { w.close() }
}

// ── ② on：只有 [S] 三条被作废 ─────────────────────────────
{
  const w = makeWorld()
  try {
    setup(w, { gate: 'on' })
    const groups = seedAll(w)
    await flushJudges()
    const dead = groups.filter((g) => rowOf(w, g.old.id).invalid_at !== null).map((g) => g.tag)
    check('on：只有取代三条被作废', dead.length === 3 && dead.every((t) => t.startsWith('S')), dead)
    const alive = groups.filter((g) => !g.tag.startsWith('S')).every((g) => rowOf(w, g.old.id).invalid_at === null)
    check('on：补充/无关/不确定都不动', alive)
    const sup = w.db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.judge.superseded'").get(w.aid).n
    check('on：取代事件 3 条', sup === 3, sup)
  } finally { w.close() }
}

// ── ③ daily_max 封顶 ──────────────────────────────────────
{
  const w = makeWorld()
  try {
    setup(w, { gate: 'shadow', dailyMax: 2 })
    let calls = 0
    const fake = async ({ text }) => { calls++; const m = String(text).match(/\[([SPUQ])\]/); return m ? VERDICT[m[1]] : '不确定' }
    for (let i = 0; i < 5; i++) {
      const old = addMemory(w.db, w.aid, { text: '第' + i + '个方案还在比较甲和乙', type: 'appraisal', fact_key: '用户.方案.比较' + i })
      w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(60), old.id)
      applyWrite(w.db, w.aid, { text: '第' + i + '个方案定成乙了 [S]', fact_key: '用户.方案.定稿' + i }, (c) => addMemory(w.db, w.aid, {
        text: c.text, type: 'appraisal', fact_key: c.fact_key || c.key || '',
      }), { complete: fake })
    }
    await flushJudges()
    check('daily_max=2：只判了两次对（每对 supersede 调两次）', calls === 4, calls)
    check('daily_max=2：只有两条事件', events(w).length === 2, events(w).length)
  } finally { w.close() }
}

// ── ④ 缓存：同一对第二次不再问模型 ────────────────────────
{
  const w = makeWorld()
  try {
    setup(w, { gate: 'shadow' })
    const old = addMemory(w.db, w.aid, { text: '主题是检索效果，还在比较甲和乙', type: 'appraisal', fact_key: '用户.检索.比较' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(60), old.id)
    let calls = 0
    const fake = async () => { calls++; return '补充' }
    const out = applyWrite(w.db, w.aid, { text: '检索表现想再升级一下，换个方案', fact_key: '用户.检索.升级' }, (c) => addMemory(w.db, w.aid, {
      text: c.text, type: 'appraisal', fact_key: c.fact_key || c.key || '',
    }), { complete: fake })
    await flushJudges()
    check('第一次调了一次模型', calls === 1, calls)
    const key = pairKey(w.aid, w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(old.id), rowOf(w, out.id))
    const cached = readJudgement(w.db, w.aid, key)
    check('缓存判定是补充', cached && cached.verdict === 'supplement', cached)
    // 再跑一次同样的对（直接 judgePair 走缓存）
    const { judgePair } = await import('../src/modules/pair_judge.js')
    const r2 = await judgePair({
      db: w.db, aid: w.aid,
      oldRow: w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(old.id),
      newerRow: rowOf(w, out.id), complete: fake, via: 'test',
    })
    check('第二次命中缓存', r2.cached === true, r2)
    check('第二次没再调模型', calls === 1, calls)
  } finally { w.close() }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)


