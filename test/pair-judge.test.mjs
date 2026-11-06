/**
 * P1：模型窄门判定器（pair_judge）单测。
 *
 * 覆盖计划的 D1（结构候选）、D3（四档）、D5（缓存）、D6（失败不冒充）、D7（专名闸）。
 * 运行：node test/pair-judge.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addMemory } from '../src/modules/memory.js'
import {
  propers, sharedPropers, ruleGate, structureCandidates, pairKey,
  readJudgement, writeJudgement, judgePair, parseVerdict, looksLikeJudgement,
  verdictAction, dayLabel, JUDGE_SYS,
} from '../src/modules/pair_judge.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const ago = (min) => new Date(Date.now() - min * 60000).toISOString()

/** P2 才会把这句写进 db.js；测试里先建同样的表，验证缓存逻辑。 */
function makeCacheTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_pair_judge(
    pair_key TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
    old_id TEXT NOT NULL, new_id TEXT NOT NULL,
    verdict TEXT NOT NULL, confidence REAL, model TEXT, reason TEXT,
    judged_at TEXT NOT NULL, via TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0);`)
}

/**
 * 直接插一行 active 记忆。
 *
 * 为什么不用 addMemory：它对同 fact_key 会当场把旧条 invalidate（memory.js:228），
 * 于是「两条 active 同 key」在正常写入路径上永远不存在。窄门要兜的是历史脏数据，
 * 所以测试必须绕过写入层造这种行。
 */
function insertRaw(db, aid, { id, text, type = 'fact', fact_key = '', created_at = null, turn_id = null }) {
  db.prepare(`INSERT INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,
    last_decay_at,valid_at,invalid_at,status,created_at,deleted_at,version,fact_key,source_turn_id,search_text)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, aid, type, 'normal', text, 'test', 0.5, 0.5, 1.0, 5.0,
    new Date().toISOString(), null, null, 'active',
    created_at || new Date().toISOString(), null, 1, fact_key || null, turn_id || null, text)
}

function makePair(w, { oldText, newText, oldKey = '', newKey = '', gapMin = 60, oldType = 'fact', newType = 'fact', turnId = null }) {
  const oldRow = addMemory(w.db, w.aid, { text: oldText, type: oldType, fact_key: oldKey, turn_id: turnId })
  w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(gapMin), oldRow.id)
  const newRow = addMemory(w.db, w.aid, { text: newText, type: newType, fact_key: newKey, turn_id: turnId })
  const rowOf = (id) => w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)
  return { old: rowOf(oldRow.id), newer: rowOf(newRow.id) }
}

// ── ① 专名抽取 ─────────────────────────────────────────────
{
  check('反引号里的英文算专名', propers('配置在 `app.db` 里').includes('app.db'), propers('配置在 `app.db` 里'))
  check('驼峰算专名', propers('chatReply 按 conversation_id 取').includes('chatReply'), propers('chatReply 按 conversation_id 取'))
  check('文件名算专名', propers('改了 gate.js 和 kernel.js').includes('gate.js'), propers('改了 gate.js 和 kernel.js'))
  check('中文引号算专名', propers('「情绪快照」还没做完').includes('情绪快照'), propers('「情绪快照」还没做完'))
  check('普通英文停用词不算', propers('the user said hello').length === 0, propers('the user said hello'))
  check('纯中文普通词不算', propers('今天天气不错').length === 0, propers('今天天气不错'))
  check('共享专名能认出来', sharedPropers('改 `gate.js`', '`gate.js` 少了判空').includes('gate.js'))
  check('无专名不误报', sharedPropers('喜欢咖啡', '喜欢喝茶').length === 0)
}

// ── ② 规则闸 ───────────────────────────────────────────────
{
  const a = { text: '考试正式环境数据库为 `204/knowledge_inner`', fact_key: '用户.考试.环境' }
  const b = { text: '要求删除 `204/knowledge_inner` 里今天创建的考试', fact_key: '用户.项目.配置' }
  const g = ruleGate(a, b)
  check('共享专名 + 主题不同 → unrelated', g && g.verdict === 'unrelated', g)
  const same = ruleGate(a, { text: '`204/knowledge_inner` 还是连不上', fact_key: '用户.考试.环境' })
  check('共享专名 + 同主题 → 不拦', same === null, same)
  check('没有专名 → 不拦', ruleGate({ text: '喜欢咖啡', fact_key: '' }, { text: '喜欢喝茶', fact_key: '' }) === null)
}

// ── ③ 结构候选（D1）────────────────────────────────────────
{
  const w = makeWorld()
  try {
    insertRaw(w.db, w.aid, { id: 'mem_raw_old', text: '用户喜欢冰美式', fact_key: '用户.咖啡.偏好', created_at: ago(120) })
    insertRaw(w.db, w.aid, { id: 'mem_raw_new', text: '用户还是喜欢冰美式', fact_key: '用户.咖啡.偏好', created_at: ago(10) })
    const c1 = structureCandidates(w.db, w.aid, { newRow: w.db.prepare('SELECT * FROM memory_items WHERE id=?').get('mem_raw_new') })
    check('同 fact_key 进候选', c1.some((x) => x.row.id === 'mem_raw_old' && x.reason === 'same_key'), c1.map((x) => x.reason))

    // LIKE 子串陷阱：咖啡 / 咖啡因 不是同一个主题
    const w2 = makeWorld()
    try {
      const caffeine = addMemory(w2.db, w2.aid, { text: '用户对咖啡因敏感', type: 'fact', fact_key: '用户.咖啡因.偏好' })
      w2.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(90), caffeine.id)
      const coffee = addMemory(w2.db, w2.aid, { text: '用户喜欢咖啡', type: 'fact', fact_key: '用户.咖啡.偏好' })
      const c2 = structureCandidates(w2.db, w2.aid, { newRow: w2.db.prepare('SELECT * FROM memory_items WHERE id=?').get(coffee.id) })
      check('同主题 LIKE 子串不误配（咖啡 ≠ 咖啡因）', !c2.some((x) => x.row.id === caffeine.id), c2.map((x) => x.reason))
    } finally { w2.close() }

    // 同轮
    const w3 = makeWorld()
    try {
      const a = addMemory(w3.db, w3.aid, { text: '用户说要把特效改成红色', type: 'fact', turn_id: 'turn_x1' })
      const b = addMemory(w3.db, w3.aid, { text: '用户说要加一点发光', type: 'fact', turn_id: 'turn_x1' })
      const c3 = structureCandidates(w3.db, w3.aid, { newRow: w3.db.prepare('SELECT * FROM memory_items WHERE id=?').get(b.id) })
      check('同 turn 进候选', c3.some((x) => x.row.id === a.id && x.reason === 'same_turn'), c3.map((x) => x.reason))
    } finally { w3.close() }

    // 同 episode（用两个不同主题，避免被 same_topic 先收进候选）
    const w4 = makeWorld()
    try {
      const a = addMemory(w4.db, w4.aid, { text: '用户问检索效果', type: 'fact', fact_key: '用户.检索.效果' })
      const b = addMemory(w4.db, w4.aid, { text: '用户说图表太挤了', type: 'fact', fact_key: '用户.图表.布局' })
      const at = ago(30)
      // addMemory 自己已经看过 fact_archive，这里只补 payload（同一个 memory_id 只能有一行）
      for (const mid of [a.id, b.id]) {
        const has = w4.db.prepare('SELECT id FROM fact_archive WHERE agent_id=? AND memory_id=?').get(w4.aid, mid)
        if (has) w4.db.prepare('UPDATE fact_archive SET payload=? WHERE id=?').run(JSON.stringify({ episode_id: 'ep_42' }), has.id)
        else w4.db.prepare(`INSERT INTO fact_archive(id,agent_id,memory_id,text,type,mark,fact_key,source,payload,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run('fa_' + mid, w4.aid, mid, 'x', 'fact', 'normal', '', 'model', JSON.stringify({ episode_id: 'ep_42' }), at)
      }
      const c4 = structureCandidates(w4.db, w4.aid, { newRow: w4.db.prepare('SELECT * FROM memory_items WHERE id=?').get(b.id) })
      check('同 episode 进候选', c4.some((x) => x.row.id === a.id && x.reason === 'same_episode'), c4.map((x) => x.reason))
    } finally { w4.close() }
  } finally { w.close() }
}

// ── ④ 缓存键与解析 ─────────────────────────────────────────
{
  const row = { id: 'a', version: 1 }
  const row2 = { id: 'b', version: 1 }
  check('pairKey 稳定', pairKey('agt', row, row2) === pairKey('agt', row, row2))
  check('version 变了 key 就变', pairKey('agt', { ...row, version: 2 }, row2) !== pairKey('agt', row, row2))
  check('不同 agent 不同 key', pairKey('x', row, row2) !== pairKey('y', row, row2))

  check('解析：取代', parseVerdict('取代') === 'supersede')
  check('解析：是补充', parseVerdict('是补充') === 'supplement')
  check('解析：与前面无关', parseVerdict('这两条无关') === 'unrelated')
  check('解析：两个档 → 不确定', parseVerdict('取代，也可能无关') === 'uncertain')
  check('解析：都不含 → 不确定', parseVerdict('好的') === 'uncertain')
  check('空串 → 不确定', parseVerdict('') === 'uncertain')

  check('形状：纯判断通过', looksLikeJudgement('取代') === true)
  check('形状：规则兜底 JSON 不算', looksLikeJudgement('{"overlap":"unknown","key":"","name":"","definition":""}') === false)
  check('形状：空不算', looksLikeJudgement('') === false)
  check('形状：超长不算', looksLikeJudgement('取代'.repeat(100)) === false)

  check('动作：supersede 才作废', verdictAction('supersede') === 'invalidate')
  check('动作：supplement 只记', verdictAction('supplement') === 'note')
  check('动作：unrelated 不动', verdictAction('unrelated') === 'none')
  check('动作：uncertain 不动', verdictAction('uncertain') === 'none')
  check('日期标签', dayLabel('2026-11-04T10:00:00.000Z') === '2026-11-04')
  check('提示词有四档', ['取代', '补充', '无关', '不确定'].every((x) => JUDGE_SYS.includes(x)))
}

// ── ⑤ judgePair 各分支 ────────────────────────────────────
{
  const w = makeWorld()
  makeCacheTable(w.db)
  try {
    // （a）同 fact_key 不再规则直判：交给模型，且 supersede 要两次一致
    let calls = 0
    insertRaw(w.db, w.aid, { id: 'mem_k_old', text: '用户咖啡偏好一直是冰美式，不加糖', fact_key: '用户.咖啡.偏好', created_at: ago(120) })
    insertRaw(w.db, w.aid, { id: 'mem_k_new', text: '用户咖啡偏好现在改成手冲，不加糖', fact_key: '用户.咖啡.偏好', created_at: ago(5) })
    const a = { old: w.db.prepare('SELECT * FROM memory_items WHERE id=?').get('mem_k_old'), newer: w.db.prepare('SELECT * FROM memory_items WHERE id=?').get('mem_k_new') }
    const r1 = await judgePair({ db: w.db, aid: w.aid, oldRow: a.old, newerRow: a.newer, complete: async () => { calls++; return '取代' }, via: 'test' })
    check('同 key 交给模型 → 取代', r1.verdict === 'supersede', r1)
    check('同 key 不再规则直判（判 + 复核两次）', calls === 2, calls)

    // （a2）复核不一致 → uncertain，宁可不改
    calls = 0
    const r1b = await judgePair({ db: w.db, aid: w.aid, oldRow: a.old, newerRow: a.newer, useCache: false, complete: async () => { calls++; return calls === 1 ? '取代' : '补充' }, via: 'test' })
    check('复核不一致 → uncertain', r1b.verdict === 'uncertain' && r1b.reason === 'supersede-unconfirmed', r1b)

    // （a3）同 key 没模型 → uncertain
    const r1c = await judgePair({ db: w.db, aid: w.aid, oldRow: a.old, newerRow: a.newer, useCache: false, complete: null, via: 'test' })
    check('同 key 没模型 → uncertain', r1c.verdict === 'uncertain' && r1c.reason === 'no-model', r1c)

    // （a4）短文本不花模型（真数据里「嗯嗯很好了」被判成取代）
    const short = makePair(w, { oldText: '嗯嗯很好了', newText: '这样是不是有点暴力了', oldKey: '用户.评价.短', newKey: '用户.评价.质疑', oldType: 'appraisal', newType: 'appraisal' })
    let shortCalls = 0
    const r1d = await judgePair({ db: w.db, aid: w.aid, oldRow: short.old, newerRow: short.newer, complete: async () => { shortCalls++; return '取代' }, via: 'test' })
    check('短文本 → uncertain(too-short)', r1d.verdict === 'uncertain' && r1d.reason === 'too-short', r1d)
    check('短文本不调模型', shortCalls === 0, shortCalls)

    // （b）专名闸：不调模型直接 unrelated
    calls = 0
    const b = makePair(w, {
      oldText: '考试正式环境数据库为 `204/knowledge_inner`', newText: '删除 `204/knowledge_inner` 里今天建的考试',
      oldKey: '用户.考试.环境', newKey: '用户.项目.配置', oldType: 'appraisal', newType: 'appraisal',
    })
    const r2 = await judgePair({ db: w.db, aid: w.aid, oldRow: b.old, newerRow: b.newer, complete: async () => { calls++; return '取代' }, via: 'test' })
    check('专名闸 → unrelated', r2.verdict === 'unrelated', r2)
    check('专名闸不调模型', calls === 0, calls)

    // （c）模型说取代
    calls = 0
    const c = makePair(w, { oldText: '检索算法效果，有没有更好的方案', newText: '关注检索算法表现，问能否升级', oldKey: '用户.检索.方案', newKey: '用户.检索.升级', oldType: 'appraisal', newType: 'appraisal' })
    const r3 = await judgePair({ db: w.db, aid: w.aid, oldRow: c.old, newerRow: c.newer, complete: async () => { calls++; return '取代' }, via: 'test' })
    check('模型判取代', r3.verdict === 'supersede', r3)
    check('模型判取代调了两次（判 + 复核）', calls === 2, calls)

    // （d）缓存命中：同一对再判不再调模型
    calls = 0
    const r3b = await judgePair({ db: w.db, aid: w.aid, oldRow: c.old, newerRow: c.newer, complete: async () => { calls++; return '补充' }, via: 'test' })
    check('第二次命中缓存', r3b.cached === true, r3b)
    check('命中缓存不再调模型', calls === 0, calls)

    // （e）模型不可用 → uncertain，且不写缓存（下次还会问）
    const d = makePair(w, { oldText: '用户提到想学游泳，但一直没找到合适的班', newText: '用户已经报了游泳班，下周三开始上课', oldKey: '用户.游泳.计划', newKey: '用户.游泳.进展', oldType: 'appraisal', newType: 'appraisal' })
    const r4 = await judgePair({ db: w.db, aid: w.aid, oldRow: d.old, newerRow: d.newer, complete: null, via: 'test' })
    check('没模型 → uncertain', r4.verdict === 'uncertain' && r4.reason === 'no-model', r4)
    const k4 = pairKey(w.aid, d.old, d.newer)
    check('no-model 不写缓存', readJudgement(w.db, w.aid, k4) === null)

    // （f）规则兜底假 JSON → bad-shape，不缓存、不冒充
    const r5 = await judgePair({ db: w.db, aid: w.aid, oldRow: d.old, newerRow: d.newer, complete: async () => '{"overlap":"unknown","key":"","name":"","definition":""}', via: 'test' })
    check('假 JSON → bad-shape', r5.verdict === 'uncertain' && r5.reason === 'bad-shape', r5)
    check('bad-shape 不写缓存', readJudgement(w.db, w.aid, k4) === null)

    // （g）超时 → uncertain
    const r6 = await judgePair({ db: w.db, aid: w.aid, oldRow: d.old, newerRow: d.newer, complete: () => new Promise(() => {}), timeoutMs: 30, via: 'test' })
    check('超时 → uncertain', r6.verdict === 'uncertain' && /timeout/.test(r6.reason), r6)

    // （h）入参时间顺序反了也能纠正
    const e = makePair(w, { oldText: '用户说特效要改成红色，再亮一点', newText: '用户说特效先别改，等这版定下来再说', oldKey: '用户.特效.颜色', newKey: '用户.特效.颜色' })
    const r7 = await judgePair({ db: w.db, aid: w.aid, oldRow: e.newer, newerRow: e.old, complete: async () => '取代', via: 'test' })
    check('时间顺序颠倒也能判取代', r7.verdict === 'supersede', r7)

    // （i）模型自己说「不确定」→ 缓存 7 天
    const f = makePair(w, { oldText: '用户提过导出功能，但没说什么时候要', newText: '用户说导出先不做，等前端稳定了再排', oldKey: '用户.导出.想法', newKey: '用户.导出.决定', oldType: 'appraisal', newType: 'appraisal' })
    const r8 = await judgePair({ db: w.db, aid: w.aid, oldRow: f.old, newerRow: f.newer, complete: async () => '不确定', via: 'test' })
    check('模型不确定 → uncertain', r8.verdict === 'uncertain', r8)
    const cacheRow = readJudgement(w.db, w.aid, pairKey(w.aid, f.old, f.newer))
    check('模型不确定会缓存（7 天）', !!cacheRow && cacheRow.verdict === 'uncertain', cacheRow)
    const expired = readJudgement(w.db, w.aid, pairKey(w.aid, f.old, f.newer), { now: Date.now() + 8 * 86400000 })
    check('8 天后不确定缓存过期', expired === null)

    // （j）缓存表不存在也不炸
    const w2 = makeWorld()
    // P2 之后新库一建就带表；这里手动删掉，模拟「老库还没升级 / 表被删」的容错路径。
    w2.db.exec('DROP TABLE IF EXISTS memory_pair_judge')
    try {
      const g = makePair(w2, { oldText: '用户喜欢猫，家里养了两只橘猫', newText: '用户家里已经养了一只猫，叫年糕', oldKey: '用户.宠物.偏好', newKey: '用户.宠物.现状', oldType: 'appraisal', newType: 'appraisal' })
      const r9 = await judgePair({ db: w2.db, aid: w2.aid, oldRow: g.old, newerRow: g.newer, complete: async () => '补充', via: 'test' })
      check('没缓存表也能判', r9.verdict === 'supplement', r9)
      check('没缓存表 readJudgement 返回 null', readJudgement(w2.db, w2.aid, 'whatever') === null)
      check('没缓存表 writeJudgement 返回 false', writeJudgement(w2.db, w2.aid, { pair_key: 'k', verdict: 'supplement', old_id: 'a', new_id: 'b', via: 'test' }) === false)
    } finally { w2.close() }
  } finally { w.close() }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
