/**
 * 召回零件 · 考卷
 *
 * 管的是「这一轮该想起什么」：路由 → 证据门 → 分区 → 融合 → 重排 → 配额 → 截 k。
 * 这里不测界面、不测注入预算（那是别的零件/零件外的事），只喂数据考零件本身。
 *
 * 运行：node test/exam-recall.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import {
  GATE, S1_UPGRADE, routeScene, stripSceneWords, overlap, evidenceOf,
  searchFacts, searchByEntity, searchByTerms, expandByLinks,
  importanceAnchors, freshFacts, addQuotaItems, fuseRRF, rerank, mmrSelect,
  selfCandidates, patternCandidates, wantsDeep, deepRecall, oldAccountQuery,
  contextualQuery, retrieve,
} from '../src/modules/retrieve.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-recall-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const today = now().slice(0, 10)
const iso = (h) => new Date(Date.now() - h * 3600000).toISOString()

function newAgent(name) {
  const aid = 'agt_' + name
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, name, 'daily', 'active', now())
  return aid
}
const add = (aid, text, extra = {}) => addMemory(db, aid, { text, type: 'fact', importance: 0.5, ...extra }).id

// ================================================================ 路由与查询清洗
{
  check('S1 默认', routeScene('今天吃什么').scene === 'S1', routeScene('今天吃什么'))
  check('S2 回看关键词', routeScene('你上次说的那个').scene === 'S2', routeScene('你上次说的那个'))
  check('S3 深检索关键词', routeScene('我是不是说过这件事').scene === 'S3', routeScene('我是不是说过这件事'))
  check('S3 优先于 S2', routeScene('上次说的事我都想不起来了').scene === 'S3')

  check('触发词不参与检索', stripSceneWords('你上次说的那个检索骨架') === '检索骨架', stripSceneWords('你上次说的那个检索骨架'))
  check('全被去光时退回原句', stripSceneWords('上次') === '上次')
  check('指代句拼上一句', contextualQuery('我在改那个检索文件', '那个库连上了吗').includes('我在改那个检索文件'), contextualQuery('我在改那个检索文件', '那个库连上了吗'))
  check('没有指代不拼', contextualQuery('我在改检索文件', '咖啡好喝吗') === '咖啡好喝吗')
  check('空上句不拼', contextualQuery('', '那个呢') === '那个呢')
  check('wantsDeep 认「记不记得」', wantsDeep('你还记不记得那件事') === true)
  check('wantsDeep 不认普通句', wantsDeep('今天吃什么') === false)
  check('oldAccountQuery 认「很久以前」', oldAccountQuery('很久以前我们聊过') === true)
  check('oldAccountQuery 不认普通句', oldAccountQuery('今天吃什么') === false)
}

// ================================================================ 证据分（纯函数）
{
  check('自重叠为 1', overlap('用户明天要早起体检', '用户明天要早起体检') === 1)
  check('虚词不稀释分母', overlap('这只猫粮', '我买了猫粮') === 1, overlap('这只猫粮', '我买了猫粮'))
  check('完全命中 E=1', evidenceOf({ text: '用户喜欢喝美式咖啡', fts: 0 }, '咖啡') === 1)
  check('无关 E=0', evidenceOf({ text: '用户喜欢猫', fts: 0 }, '咖啡') === 0)
  const broken = evidenceOf({ text: '没更新上去', fts: 0 }, '库没上去')
  check('三字对不上就打折', broken < 0.5, broken)
  check('实体点名有保底分', evidenceOf({ text: '他喜欢打篮球', via: 'entity', entity: '小周' }, '小周') === 0.55,
    evidenceOf({ text: '他喜欢打篮球', via: 'entity', entity: '小周' }, '小周'))
  check('一跳邻居 0.45', evidenceOf({ text: '完全无关的一句', via: 'link', _linkE: 0.45 }, '检索') === 0.45)
  const byTerm = evidenceOf({ text: '他爱喝拿铁', terms: '咖啡 拿铁' }, '咖啡')
  check('检索卡同义词命中 0.85', Math.abs(byTerm - 0.85) < 1e-6, byTerm)
}

// ================================================================ 分区检索（T1 / 实体 / 扩词）
const rec = newAgent('rec')
const coffee = add(rec, '用户喜欢喝美式咖啡，不加糖', { importance: 0.9 })
const cat = add(rec, '用户养了一只叫团子的猫', { importance: 0.5 })
const latteOld = add(rec, '用户说他喜欢喝拿铁', { importance: 0.6 })
db.prepare('UPDATE memory_items SET invalid_at=? WHERE id=?').run(now(), latteOld)
const swimCold = add(rec, '用户提过想学游泳', { importance: 0.7, cold: true })
db.prepare("INSERT INTO entities(id,agent_id,name,kind,aliases,hits,created_at,updated_at) VALUES('ent_zhou',?,'小周','person','[\"老周\"]',0,?,?)")
  .run(rec, now(), now())
const zhouA = add(rec, '他喜欢打篮球', { entity_id: 'ent_zhou', importance: 0.4 })
const zhouB = add(rec, '他住在地铁沿线', { entity_id: 'ent_zhou', importance: 0.4 })
const linkA = add(rec, '检索骨架分三段：路由、门、融合', { importance: 0.6 })
const linkB = add(rec, '分区归谁管：T1 事实、T2 纪要', { importance: 0.6 })
db.prepare('INSERT OR IGNORE INTO memory_links VALUES(?,?,?,?)').run(linkA, linkB, 'related', 1.0)
{
  const facts = searchFacts(db, rec, '咖啡')
  check('两字查询也能召回（LIKE 兜底）', facts.length >= 1 && /咖啡/.test(facts[0].text), facts.map((x) => x.text))
  check('S1 默认不含冷层', searchFacts(db, rec, '游泳').length === 0)
  check('回看时能翻冷层', searchFacts(db, rec, '游泳', { includeCold: true }).length === 1)
  check('S1 默认不含旧说法', searchFacts(db, rec, '拿铁').length === 0)
  const oldRows = searchFacts(db, rec, '拿铁', { includeSuperseded: true })
  check('回看时带旧说法且标 stale', oldRows.length === 1 && oldRows[0].stale === true, oldRows.map((x) => x.stale))

  const byAlias = searchByEntity(db, rec, '老周')
  check('实体别名也能圈人', byAlias.length >= 2 && byAlias.every((x) => x.via === 'entity'), byAlias.length)
  check('实体圈人不需要字面重合', byAlias.some((x) => !String(x.text).includes('老周')), byAlias.map((x) => x.text))

  const terms = searchByTerms(db, rec, ['篮球', '足球'])
  check('扩词按覆盖率打折', terms.length === 1 && Math.abs(terms[0]._termE - 0.601) < 0.01, terms.map((x) => x._termE))

  const linked = expandByLinks(db, rec, [{ partition: 'T1', id: linkA }], { hops: 2, decay: 0.65 })
  const hop1 = linked.find((x) => x.id === linkB)
  check('一跳邻居 e=0.45', hop1 && hop1._linkE === 0.45, linked.map((x) => ({ id: x.id, e: x._linkE, hop: x.hop })))
  check('一跳邻居在 S1 门内', hop1 && hop1._linkE >= GATE.S1)
}

// ================================================================ 锚点 / 新近 / 自己 / 模式
const anchorAid = newAgent('anchor')
const aLocked = add(anchorAid, '答应周末把记忆面板的图重画', { importance: 1.0 })
db.prepare("UPDATE memory_items SET mark='locked', last_hit_at=? WHERE id=?").run(now(), aLocked)
const aFact = add(anchorAid, '身份：小汐，是个意识体', { importance: 0.92 })
db.prepare('UPDATE memory_items SET last_hit_at=? WHERE id=?').run(iso(24 * 7), aFact)
const aFact2 = add(anchorAid, '边界：不替主人做决定', { importance: 0.88 })
db.prepare('UPDATE memory_items SET last_hit_at=? WHERE id=?').run(iso(48), aFact2)
const aReflection = add(anchorAid, '今天聊了很多代码', { type: 'reflection', importance: 0.96 })
{
  const anchors = importanceAnchors(db, anchorAid, { limit: 2 })
  check('锚点第一条是钉住的', anchors[0] && anchors[0].id === aLocked, anchors.map((x) => x.id))
  check('锚点第二条给最久没想起的', anchors[1] && anchors[1].id === aFact, anchors.map((x) => x.id))
  check('高重要度的流水账不进锚点', !anchors.some((x) => x.id === aReflection), anchors.map((x) => x.id))
  const single = importanceAnchors(db, anchorAid, { limit: 1 })
  check('锚点限额', single.length === 1)

  const fresh = freshFacts(db, anchorAid, { hours: 24, limit: 3 })
  check('24h 内新近能翻出来', fresh.some((x) => x.id === aFact2), fresh.map((x) => x.id))
  check('新近不要流水账', !fresh.some((x) => x.id === aReflection), fresh.map((x) => x.id))

  const selfAid = newAgent('self')
  const mine = add(selfAid, '我今天把取数补了上界', { source: 'self', importance: 0.6 })
  const pat = add(selfAid, '我好像一被夸就紧张', { source: 'self', importance: 0.8, fact_key: 'self.pattern.praise' })
  const life = add(selfAid, '我在窗台看了一会儿雨', { source: 'life', importance: 0.5 })
  const selfs = selfCandidates(db, selfAid, '取数', 2)
  check('自己的事能硬补', selfs.length >= 1 && selfs[0].id === pat, selfs.map((x) => x.id))
  check('模式排在流水账前', selfs.some((x) => x.id === mine) && selfs.findIndex((x) => x.id === pat) < selfs.findIndex((x) => x.id === mine))
  const pats = patternCandidates(db, selfAid, 1)
  check('模式位只收模式', pats.length === 1 && pats[0].id === pat, pats.map((x) => x.id))

  const quota = addQuotaItems([{ id: 'x', text: '甲' }], [{ id: 'x', text: '甲' }, { id: 'y', text: '甲' }, { id: 'z', text: '乙' }], 3)
  check('配额补位按 id 去重', quota.length === 2 && quota[1].id === 'z', quota.map((x) => x.id))
  const capped = addQuotaItems([{ id: 'a', text: '甲' }], [{ id: 'b', text: '乙' }, { id: 'c', text: '丙' }], 2)
  check('配额补位不超 k', capped.length === 2)
  const lifeRow = selfCandidates(db, selfAid, '窗台', 3)
  check('life 也算自己的事', lifeRow.some((x) => x.id === life), lifeRow.map((x) => x.id))
}

// ================================================================ 融合与重排（纯函数）
{
  const fused = fuseRRF({
    T1: [{ id: 'a', text: 'a', e: 0.9 }, { id: 'b', text: 'b', e: 0.5 }],
    T2: [{ id: 'c', text: 'c', e: 0.8 }],
  }, { T1: 1, T2: 0.7 })
  check('双路命中排第一', fused[0].id === 'a', fused.map((x) => x.id))
  check('RRF 只混名次', Math.abs(fused[0].rrf - 1 / 61) < 1e-6, fused[0].rrf)
  const c = fused.find((x) => x.id === 'c')
  check('RRF 按场景权重缩放', c && Math.abs(c.rrf - 0.7 / 61) < 1e-6, c && c.rrf)
  check('空权重的分区不参与', fuseRRF({ T1: [{ id: 'x', text: 'x', e: 0.1 }] }, { T2: 1 }).length === 0)

  const reranked = rerank([
    { id: 'hot', partition: 'T2', text: '甲', rrf: 0.01, heat: 0.9 },
    { id: 'cold', partition: 'T2', text: '乙', rrf: 0.01, heat: 0.1 },
  ], { selfFreshBoost: 0 })
  check('同样的名次，热的排前面', reranked[0].id === 'hot', reranked.map((x) => x.id))

  const selfFresh = rerank([
    { id: 'mine', partition: 'T1', text: '甲', rrf: 0.01, heat: 0, source: 'self', created_at: now(), last_decay_at: now(), stability: 1 },
    { id: 'other', partition: 'T1', text: '乙', rrf: 0.01, heat: 0, source: 'user', created_at: now(), last_decay_at: now(), stability: 1 },
  ], { selfFreshBoost: 0.5 })
  check('48h 内的自己优先', selfFresh[0].id === 'mine', selfFresh.map((x) => x.id))

  const picked = mmrSelect([
    { id: 'a', text: '用户喜欢喝美式咖啡，不加糖', _score: 1 },
    { id: 'b', text: '用户喜欢喝美式咖啡，不加糖', _score: 1 },
    { id: 'c', text: '用户养了一只叫团子的猫', _score: 0.8 },
  ], 2)
  check('MMR 不连着要同一句', picked.length === 2 && picked[0].id === 'a' && picked[1].id === 'c', picked.map((x) => x.id))
}

// ================================================================ 端到端：场景 / 门 / 升级 / k
{
  const r1 = retrieve(db, rec, '咖啡', { k: 5, float: false })
  check('S1 场景', r1.scene === 'S1', r1.scene)
  check('S1 门是 0.35', r1.debug.gate === GATE.S1, r1.debug.gate)
  check('S1 只想起咖啡那条', r1.items.length === 1 && /咖啡/.test(r1.items[0].text), r1.items.map((x) => x.text))
  check('结果带证据分与名次', Number(r1.items[0].e) > 0 && Number(r1.items[0].rrf) > 0, r1.items[0])

  const r2 = retrieve(db, rec, '量子色动力学的正则化', { k: 5, float: false })
  check('一条都够不着就升级 S3', r2.scene === 'S3', r2.scene)
  check('升级写进理由', (r2.why || []).some((w) => /升级/.test(w)), r2.why)
  check('升级线是 ' + S1_UPGRADE, S1_UPGRADE === 0.25)

  const r3 = retrieve(db, rec, '你上次说的那个量子色动力学', { k: 5 })
  check('S2 空 → 升级 S3', r3.scene === 'S3' && (r3.why || []).some((w) => /S2 无命中/.test(w)), { scene: r3.scene, why: r3.why })

  const r4 = retrieve(db, rec, '团子的猫', { k: 1, float: false })
  check('高分不升级', r4.scene === 'S1' && r4.items.length >= 1, { scene: r4.scene, n: r4.items.length })
  check('k 封顶', r4.items.length <= 1)

  const oldRow = retrieve(db, rec, '拿铁', { scene: 'S3', k: 5, float: false })
  const oldItem = oldRow.items.find((x) => x.id === latteOld)
  check('深查带旧说法', !!oldItem, oldRow.items.map((x) => x.text))
  check('旧说法分数打七折', oldItem && Math.abs(oldItem.e - 0.7) < 0.05, oldItem && oldItem.e)
  check('旧说法标 stale', oldItem && oldItem.stale === true, oldItem && oldItem.stale)

  const empty = retrieve(db, rec, '', { k: 3 })
  check('空查询不炸', Array.isArray(empty.items) && (empty.why || []).some((w) => /空查询/.test(w)), empty.why)
  const deep = deepRecall(db, rec, '检索骨架', { k: 3 })
  check('深翻带 via=deep', deep.every((x) => x.via === 'deep'), deep.map((x) => x.via))
  check('深翻先翻非 T1', deep.length === 0 || deep[0].partition !== 'T1', deep.map((x) => x.partition))
}

// ================================================================ 端到端：T3 日记进 S1 / summary 过滤
{
  const aid = newAgent('diary')
  const mid = add(aid, '用户问过装修预算', { importance: 0.6 })
  db.prepare("INSERT INTO diaries(id,agent_id,day,text,mood,source,version,late,created_at,updated_at) VALUES('dia_x',?,?,?,'calm','model',2,0,?,?)")
    .run(aid, today, '今天聊了装修和客厅的灯', now(), now())
  const r = retrieve(db, aid, '装修', { k: 5, float: false })
  check('S1 也会翻日记（T3）', r.scene === 'S1' && r.items.some((x) => x.partition === 'T3'), r.items.map((x) => x.partition))
  check('日记正文带日期', r.items.some((x) => x.partition === 'T3' && String(x.text).includes(today)), r.items.map((x) => x.text))

  const said = add(aid, '写检索骨架这件事我来做', { importance: 0.7 })
  add(aid, '用户正在写检索骨架和召回', { source: 'summary', importance: 0.7 })
  const plain = retrieve(db, aid, '用户正在写检索骨架和召回', { k: 6, float: false })
  check('S1 不塞第三人称旁白', !plain.items.some((x) => String(x.text).includes('用户正在')), plain.items.map((x) => x.text))
  const shown = retrieve(db, aid, '用户正在写检索骨架和召回', { k: 6, float: false, summaryInjected: true })
  check('开关打开才带旁白', shown.items.some((x) => String(x.text).includes('用户正在')), shown.items.map((x) => x.text))
  check('自己的事仍在', plain.items.some((x) => String(x.text).includes('写检索骨架')))
  void said; void mid
}

// ================================================================ 端到端：配额位（锚点 / 新近）
{
  const aid = newAgent('quota')
  add(aid, '用户喜欢喝美式咖啡', { importance: 0.5 })
  const lock = add(aid, '答应过把那张图重画', { importance: 1.0 })
  db.prepare("UPDATE memory_items SET mark='locked' WHERE id=?").run(lock)
  const r = retrieve(db, aid, '咖啡', { k: 6 })
  check('锚点占一个固定名额', r.items.some((x) => x.via === 'anchor'), r.items.map((x) => x.via))
  check('配额项在 k 之内', r.items.length <= 6)
  const noFloat = retrieve(db, aid, '咖啡', { k: 6, float: false })
  check('关掉浮现就不补配额', !noFloat.items.some((x) => x.via === 'anchor'), noFloat.items.map((x) => x.via))
}

// ================================================================ 端到端：遗忘阈值对检索也生效
{
  const aid = newAgent('floor')
  const old = add(aid, '用户喜欢喝美式咖啡', { importance: 0.6 })
  db.prepare('UPDATE memory_items SET last_decay_at=?, stability=0.5 WHERE id=?').run(iso(24 * 200), old)
  const open = retrieve(db, aid, '咖啡', { k: 5, float: false })
  check('没过阈值时能想起', open.items.some((x) => x.id === old), open.items.map((x) => x.id))
  const blocked = retrieve(db, aid, '咖啡', { k: 5, float: false, floor: 0.5, decayVersion: 'v1', decayScale: 1 })
  check('过了阈值就不再想起', !blocked.items.some((x) => x.id === old), blocked.items.map((x) => x.id))
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
