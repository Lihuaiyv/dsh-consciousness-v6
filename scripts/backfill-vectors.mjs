/**
 * 向量回填：给已有记忆补上 embedding，落 memory_vec。
 *
 * 用法：
 *   node scripts/backfill-vectors.mjs                最近 100 条缺向量的
 *   node scripts/backfill-vectors.mjs --limit 2000   一次补完
 *   node scripts/backfill-vectors.mjs --force        全部重算（换 embedding 模型后用）
 *   node scripts/backfill-vectors.mjs --agent agt_x  指定实例
 *
 * 需要能算向量的模型：~/.dsh/consciousness/model.json 里配 url/key，
 * 或用环境变量 DSHC_MODEL_URL / DSHC_MODEL_KEY；embedding 模型默认 text-embedding-3-small，
 * 可用 DSHC_EMBED_MODEL 或 model.json 的 embeddingModel 覆盖。
 *
 * 只读写 app.db，不启 DSH、不碰 HTTP。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { backfillVectors, vectorStats, canEmbed } from '../src/modules/vector.js'

const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf('--' + name)
  if (i < 0) return def
  const v = args[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DB = String(argOf('db', path.join(home, 'consciousness', 'app.db')))
if (!fs.existsSync(DB)) {
  console.error('找不到数据库：' + DB)
  process.exit(1)
}

const db = openDb(DB)
const aid = argOf('agent', '')
  || (() => {
    const row = db.prepare("SELECT id FROM agents WHERE status<>'soft_deleted' ORDER BY COALESCE(last_interaction_at,created_at) DESC LIMIT 1").get()
    return row ? row.id : ''
  })()
if (!aid) { console.error('没有可用的意识体'); process.exit(1) }

if (!canEmbed()) {
  console.error('当前模型没有 embedding 能力：请在 model.json 配 url/key（含 /embeddings），或设 DSHC_MODEL_URL / DSHC_MODEL_KEY')
  console.error('提示：只配了 DSH 宿主模型时，embedding 不可用——向量通道会自动关闭，不影响词法召回。')
  process.exit(2)
}

const before = vectorStats(db, aid)
console.log('agent=' + aid + ' 已有向量 ' + before.vectors + ' / 记忆 ' + before.memories + ' 开始时间 ' + now())
const limit = Number(argOf('limit', 100)) || 100
const batch = Number(argOf('batch', 16)) || 16
const force = !!argOf('force', false)
let total = 0
for (let round = 0; round < 200; round++) {
  const r = await backfillVectors(db, aid, { limit, batch, force })
  total += r.done
  console.log('round ' + (round + 1) + ': +' + r.done + ' / ' + r.total)
  if (!r.total || r.done === 0) break
  if (!force && total >= limit) break
}
const after = vectorStats(db, aid)
console.log('done: +' + total + '，现在 ' + after.vectors + ' / ' + after.memories)
db.close()
