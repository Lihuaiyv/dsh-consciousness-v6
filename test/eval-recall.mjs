/**
 * 召回评测：Recall@k / MRR@k / 误注入，按「记忆 id」判分（不是按子串）。
 *
 * 两种用法：
 *
 * 1) 真实库 + 标注（推荐先跑这个）：
 *    node test/eval-recall.mjs --dump                 从 retrieval_log 导出 query 清单
 *    node test/eval-recall.mjs labels.jsonl           标注：{"query":"…","must_ids":["mem_x"]}
 *      可选字段：terms:["…"]（模拟扩词）、vec:"topic"（模拟查询向量，需要 fixture 才有意义）
 *      只读打开 app.db，不写库、不调模型。
 *
 * 2) 内置语料（证明四条通道各自解决什么，不依赖模型）：
 *    node test/eval-recall.mjs --fixture
 *
 * 判定：召回结果的 id 命中 must_ids 即相关；负例（must_ids 为空）只要返回了任何条目就算一次误注入。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import { retrieve, clearVectorCache } from '../src/modules/retrieve.js'

const DB = path.join(process.env.USERPROFILE || os.homedir(), '.dsh', 'consciousness', 'app.db')
const K = 6

function metrics(gold, items) {
  const got = items.map((x) => x.id)
  const covered = gold.filter((id) => got.includes(id)).length
  let rank = 0
  for (let i = 0; i < got.length; i++) {
    if (gold.includes(got[i])) { rank = i + 1; break }
  }
  return {
    recall: gold.length ? covered / gold.length : null,
    mrr: rank ? 1 / rank : 0,
    fp: gold.length === 0 && got.length > 0 ? 1 : 0,
    n: items.length,
  }
}

function summarize(rows) {
  const valid = rows.filter((r) => !r.skip)
  const scored = valid.filter((r) => r.gold > 0)
  const neg = valid.filter((r) => r.gold === 0)
  const avg = (list, key) => (list.length ? list.reduce((s, r) => s + Number(r[key] || 0), 0) / list.length : 0)
  return {
    queries: valid.length,
    recall: +avg(scored, 'recall').toFixed(3),
    mrr: +avg(scored, 'mrr').toFixed(3),
    empty: valid.filter((r) => !r.n).length,
    falseInjection: neg.length ? +(neg.reduce((s, r) => s + r.fp, 0) / neg.length).toFixed(3) : null,
  }
}

// ---------------------------------------------------------------- 真实库
function runLive(labels) {
  if (!fs.existsSync(DB)) { console.error('找不到数据库：' + DB); process.exit(1) }
  const db = new DatabaseSync(DB, { readOnly: true })
  const agent = db.prepare("SELECT id FROM agents WHERE status<>'soft_deleted' ORDER BY COALESCE(last_interaction_at,created_at) DESC LIMIT 1").get()
  if (!agent) { console.error('没有可用的意识体'); process.exit(1) }
  const rows = []
  for (const lab of labels) {
    if (!lab.query) { rows.push({ q: lab.query, skip: true }); continue }
    const gold = (lab.must_ids || []).filter(Boolean)
    const opt = { k: K, floor: 0 }
    if (Array.isArray(lab.terms) && lab.terms.length) opt.terms = lab.terms
    const r = retrieve(db, agent.id, lab.query, opt)
    const m = metrics(gold, r.items)
    rows.push({ q: lab.query, scene: r.scene, gold: gold.length, ...m, got: r.items.map((x) => x.id) })
  }
  db.close()
  return rows
}

function dumpLive() {
  if (!fs.existsSync(DB)) { console.error('找不到数据库：' + DB); process.exit(1) }
  const db = new DatabaseSync(DB, { readOnly: true })
  const rows = db.prepare("SELECT query, COUNT(*) n, SUM(items) hits FROM retrieval_log WHERE query<>'' GROUP BY query ORDER BY n DESC LIMIT 100").all()
  for (const r of rows) console.log(JSON.stringify({ query: r.query, must_ids: [], seen: Number(r.n), hits: Number(r.hits) || 0 }))
  console.error('\n共 ' + rows.length + ' 条 query。填好 must_ids 后：node test/eval-recall.mjs 文件名.jsonl')
  db.close()
}

// ---------------------------------------------------------------- 内置语料
const TOPICS = ['coffee', 'cat', 'budget', 'plugin', 'relation', 'address', 'basketball', 'diary', 'vault', 'peanut', 'name']
const topicVec = (topic) => {
  const v = new Array(TOPICS.length).fill(0)
  const i = TOPICS.indexOf(topic)
  if (i >= 0) v[i] = 1
  return v
}

const CORPUS = [
  { id: 'm1', text: '用户喜欢喝美式咖啡，不加糖', type: 'fact', key: '用户.咖啡.偏好', terms: ['咖啡', '美式', '不加糖', '饮品', '喝什么'], topic: 'coffee' },
  { id: 'm2', text: '用户养了一只叫团子的猫', type: 'fact', key: '用户.宠物.团子', terms: ['团子', '猫', '宠物', '养猫'], topic: 'cat' },
  { id: 'm3', text: '注入预算是 800 token', type: 'fact', key: '记忆.注入预算', terms: ['注入预算', 'token', '配额', '预算', '设置'], topic: 'budget' },
  { id: 'm4', text: '用户在做 DSH 意识体插件', type: 'fact', key: '用户.项目.DSH', terms: ['插件', '意识体', 'DSH', '项目'], topic: 'plugin' },
  { id: 'm5', text: '关系图用三维：亲近、信任、安全', type: 'fact', key: '关系.三维', terms: ['关系图', '亲近', '信任', '安全'], topic: 'relation' },
  { id: 'm6', text: '用户住城东', type: 'fact', key: '用户.住址', terms: ['住', '城东', '地址', '家在哪'], topic: 'address' },
  { id: 'm7', text: '小周喜欢篮球', type: 'fact', key: '小周.运动', terms: ['小周', '篮球', '运动'], topic: 'basketball' },
  { id: 'm8', text: '用户讨厌别人催进度', type: 'fact', key: '用户.偏好.催', terms: ['催', '讨厌', '进度'], topic: 'plugin' },
  { id: 'm9', text: '日记每天 23:55 生成', type: 'fact', key: '日记.生成时间', terms: ['日记', '生成时间', '半夜'], topic: 'diary' },
  { id: 'm10', text: '记忆仓库有五个分区', type: 'fact', key: '记忆.分区', terms: ['记忆仓库', '分区', '五个房间'], topic: 'vault' },
  { id: 'm11', text: '用户对花生过敏', type: 'fact', key: '用户.忌口.花生', terms: ['花生', '过敏', '忌口', '不能吃'], topic: 'peanut' },
  { id: 'm12', text: '用户叫阿念', type: 'fact', key: '用户.称呼', terms: ['名字', '称呼', '阿念', '叫什么'], topic: 'name' },
]

const QUERIES = [
  { q: '我平时喝什么饮品', gold: ['m1'], terms: ['咖啡', '美式', '饮品', '喝'], topic: 'coffee' },
  { q: '预算设多大', gold: ['m3'], terms: ['注入预算', 'token', '配额', '预算'], topic: 'budget' },
  { q: '我忌口什么', gold: ['m11'], terms: ['花生', '过敏', '忌口', '不能吃'], topic: 'peanut' },
  { q: '团子是谁', gold: ['m2'], terms: ['团子', '猫', '宠物'], topic: 'cat' },
  { q: '我住哪', gold: ['m6'], terms: ['城东', '地址', '家在哪'], topic: 'address' },
  { q: '小周最近怎么样', gold: ['m7'], terms: ['小周', '篮球', '运动'], topic: 'basketball' },
  { q: '我的猫叫什么', gold: ['m2'], terms: ['猫', '团子', '宠物'], topic: 'cat' },
  { q: '日记几点生成', gold: ['m9'], terms: ['日记', '生成时间'], topic: 'diary' },
  { q: '五个分区是哪几个', gold: ['m10'], terms: ['记忆仓库', '分区'], topic: 'vault' },
  { q: '我叫什么名字', gold: ['m12'], terms: ['名字', '称呼', '阿念'], topic: 'name' },
  { q: '量子色动力学的正则化', gold: [], terms: [], topic: null },
]

function seed(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-eval-'))
  const db = openDb(path.join(dir, 'app.db'))
  attachDb(db)
  const aid = 'agt_eval_' + cfg.name
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, cfg.name, 'daily', 'active', new Date().toISOString())
  const map = new Map()
  for (const m of CORPUS) {
    const body = { text: m.text, type: m.type, importance: 0.6 }
    if (cfg.cards) { body.fact_key = m.key; body.terms = m.terms }
    const r = addMemory(db, aid, body)
    map.set(m.id, r.id)
  }
  if (cfg.vectors) {
    for (const m of CORPUS) {
      const v = Float32Array.from(topicVec(m.topic))
      db.prepare('INSERT INTO memory_vec(memory_id,agent_id,dim,model,vec,at) VALUES(?,?,?,?,?,?)')
        .run(map.get(m.id), aid, v.length, 'fixture', Buffer.from(v.buffer), new Date().toISOString())
    }
    clearVectorCache()
  }
  return { db, aid, map }
}

function runFixture() {
  const configs = [
    { name: 'A 纯词法', cards: false, expand: false, vectors: false },
    { name: 'B +写入卡片', cards: true, expand: false, vectors: false },
    { name: 'C +查询扩词', cards: true, expand: true, vectors: false },
    { name: 'D +向量通道', cards: false, expand: false, vectors: true },
  ]
  const table = []
  for (const cfg of configs) {
    const { db, aid, map } = seed(cfg)
    const rows = []
    for (const item of QUERIES) {
      const gold = item.gold.map((id) => map.get(id))
      const opt = { k: K, floor: 0 }
      if (cfg.expand && item.terms.length) opt.terms = item.terms
      if (cfg.vectors && item.topic) opt.queryVec = topicVec(item.topic)
      const r = retrieve(db, aid, item.q, opt)
      rows.push({ q: item.q, gold: gold.length, ...metrics(gold, r.items), scene: r.scene })
    }
    table.push({ name: cfg.name, ...summarize(rows), rows })
    db.close()
  }
  for (const t of table) {
    console.log('\n== ' + t.name + ' ==')
    console.log('  Recall@' + K + '=' + t.recall + '  MRR@' + K + '=' + t.mrr
      + '  空手=' + t.empty + '/' + t.queries + '  误注入=' + (t.falseInjection == null ? 'n/a' : t.falseInjection))
    for (const r of t.rows) {
      const mark = r.gold === 0 ? (r.fp ? 'FP' : 'ok') : r.recall === 1 ? '✓' : r.recall > 0 ? '½' : '✗'
      if (mark !== '✓') console.log('   ' + mark + ' ' + r.q + '  scene=' + r.scene + ' n=' + r.n)
    }
  }
  console.log('\n== 汇总 ==')
  for (const t of table) console.log(t.name.padEnd(12), 'Recall@' + K + '=' + t.recall, ' MRR=' + t.mrr)
  console.log('\n说明：内置语料只证明四条通道的接线与打分，不代表线上效果；线上效果用真实标注集（--dump）量。')
}

// ---------------------------------------------------------------- 入口
const arg = process.argv[2] || ''
if (arg === '--dump') {
  dumpLive()
} else if (arg === '--fixture') {
  runFixture()
} else if (arg) {
  if (!fs.existsSync(arg)) { console.error('标注文件不存在：' + arg); process.exit(1) }
  const labels = fs.readFileSync(arg, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
  const rows = runLive(labels)
  for (const r of rows) {
    if (r.skip) continue
    console.log(JSON.stringify(r))
  }
  const s = summarize(rows)
  console.log('\n== 汇总 ==')
  console.log('query=' + s.queries + '  Recall@' + K + '=' + s.recall + '  MRR@' + K + '=' + s.mrr
    + '  空手=' + s.empty + '  误注入=' + (s.falseInjection == null ? 'n/a' : s.falseInjection))
} else {
  console.error('用法：node test/eval-recall.mjs --fixture | --dump | labels.jsonl')
  process.exit(2)
}
