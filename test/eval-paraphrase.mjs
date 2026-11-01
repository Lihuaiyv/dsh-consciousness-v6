/**
 * 复述召回评测：同一批记忆，每种 8 句「换了说法、不带原句关键词」的提问。
 *
 *   node test/eval-paraphrase.mjs                      用现网库跑（需要本机 embedding 在线）
 *   node test/eval-paraphrase.mjs --no-vec              只跑词法（不调模型）
 *   node test/eval-paraphrase.mjs --labels 别的.jsonl --k 6 --pool 50
 *
 * 判分按记忆 id：命中 must_ids 记 1，否则 0。输出「词法 / 词法+向量」两列和分组小计，
 * 用来回答一个很具体的问题：改完检索之后，换个说法还找不找得回来。
 *
 * 不写库、不调聊天模型；embedding 走 model.json 里配的本地服务。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { retrieve, clearVectorCache } from '../src/modules/retrieve.js'

const HERE = new URL('.', import.meta.url)
const HOME = process.env.USERPROFILE || os.homedir()
const DB = path.join(HOME, '.dsh', 'consciousness', 'app.db')
const MODEL_JSON = path.join(HOME, '.dsh', 'consciousness', 'model.json')

const argv = process.argv.slice(2)
const flag = (name, dft) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dft
}
const has = (name) => argv.includes('--' + name)

const K = Number(flag('k', 6))
const POOL = Number(flag('pool', 50))
const LABELS = path.resolve(HERE.pathname.replace(/^\/([A-Za-z]:)/, '$1'), flag('labels', 'labels/paraphrase-32.jsonl'))

function embedCfg() {
  if (process.env.DSHC_EMBED_URL) {
    return { url: process.env.DSHC_EMBED_URL, model: process.env.DSHC_EMBED_MODEL || 'bge-m3' }
  }
  try {
    const j = JSON.parse(fs.readFileSync(MODEL_JSON, 'utf8'))
    if (j.embedding && j.embedding.url) return { url: j.embedding.url, model: j.embedding.model || 'bge-m3' }
  } catch { /* 没配就当没有 */ }
  return null
}

async function embed(cfg, text) {
  const r = await fetch(cfg.url.replace(/\/$/, '') + '/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, input: text }),
  })
  if (!r.ok) throw new Error('embed HTTP ' + r.status)
  return (await r.json()).data[0].embedding
}

const labels = fs.readFileSync(LABELS, 'utf8')
  .replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim())
  .map((l) => JSON.parse(l))

if (!fs.existsSync(DB)) {
  console.error('找不到数据库：' + DB)
  process.exit(1)
}
const db = new DatabaseSync(DB, { readOnly: true })
const agent = db.prepare("SELECT id FROM agents WHERE status<>'soft_deleted' ORDER BY COALESCE(last_interaction_at,created_at) DESC LIMIT 1").get()
if (!agent) {
  console.error('没有可用的意识体')
  process.exit(1)
}

// 词法基线：拷一份库、清掉向量，同一批查询再跑一遍。
let dbLex = null
if (!has('no-vec')) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-lex-'))
  const copy = path.join(tmp, 'app.db')
  fs.copyFileSync(DB, copy)
  const w = new DatabaseSync(copy)
  w.exec('DELETE FROM memory_vec')
  w.close()
  dbLex = new DatabaseSync(copy, { readOnly: true })
}

const cfg = has('no-vec') ? null : embedCfg()
const hit = (ids, must) => must.some((m) => ids.includes(m))
const ask = (conn, q, extra) => retrieve(conn, agent.id, q, { k: K, floor: 0, pool: POOL, ...extra }).items.map((x) => x.id)

const rows = []
for (const lab of labels) {
  const must = (lab.must_ids || []).filter(Boolean)
  if (!lab.query || !must.length) continue
  const lex = dbLex ? hit(ask(dbLex, lab.query, {}), must) : null
  let vec = null
  if (cfg) {
    const v = await embed(cfg, lab.query)
    clearVectorCache()
    vec = hit(ask(db, lab.query, { queryVec: v }), must)
  }
  rows.push({ g: lab.group || '-', q: lab.query, lex, vec })
  const mark = (x) => (x == null ? ' - ' : x ? '✓' : '✗')
  console.log(mark(lex) + ' ' + mark(vec) + '  ' + lab.query)
}

const groups = [...new Set(rows.map((r) => r.g))]
const rate = (list, key) => {
  const v = list.filter((r) => r[key] != null)
  return v.length ? v.filter((r) => r[key]).length + '/' + v.length : '-'
}
console.log('\n== 分组 ==')
for (const g of groups) {
  const rs = rows.filter((r) => r.g === g)
  console.log(g.padEnd(20), '词法 ' + rate(rs, 'lex') + '   词法+向量 ' + rate(rs, 'vec'))
}
console.log('\n== 总计 ==')
console.log('词法 ' + rate(rows, 'lex') + '   词法+向量 ' + rate(rows, 'vec') + '   (k=' + K + ', pool=' + POOL + ')')
if (!cfg && !has('no-vec')) console.log('提示：没有可用的 embedding 配置，这次只跑了词法。')
db.close()
if (dbLex) dbLex.close()
