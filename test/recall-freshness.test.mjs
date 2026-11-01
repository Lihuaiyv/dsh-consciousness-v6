/**
 * P2 事实失效 + P3 二跳扩散。
 * 运行：node test/recall-freshness.test.mjs
 *
 * 覆盖：
 *   - 同 fact_key 来了新说法 → 旧说法 invalid_at + superseded_by 指向新条目；
 *   - S1（每轮）不再带旧说法，S3（深查）能看到但标 stale，注入文本带「已更新」；
 *   - 不同 key、以及 reflection 这类流水账，不会被 fact_key 顶掉；
 *   - 图扩散：一跳 0.45、二跳 0.45×0.65≈0.29；S1 恒一跳，S3 才放二跳。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { addMemory } from '../src/modules/memory.js'
import { retrieve, expandByLinks } from '../src/modules/retrieve.js'
import { packInjection } from '../src/modules/pack.js'
import { applyCard } from '../src/modules/enrich.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-fresh-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_fresh'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'fresh', 'daily', 'active', new Date().toISOString())

// ---------------------------------------------------------------- P2
{
  const old = addMemory(db, aid, { text: '默认头像用鲸鱼', type: 'fact', fact_key: '用户.头像.默认' })
  const neu = addMemory(db, aid, { text: '默认头像换成二次元形象', type: 'fact', fact_key: '用户.头像.默认' })
  const row = db.prepare('SELECT invalid_at, superseded_by FROM memory_items WHERE id=?').get(old.id)
  check('旧说法被标失效', !!row.invalid_at, row)
  check('旧说法指向新说法', row.superseded_by === neu.id, { got: row.superseded_by, want: neu.id })
  check('写入返回 superseded_ids', Array.isArray(neu.superseded_ids) && neu.superseded_ids.includes(old.id), neu.superseded_ids)

  const s1 = retrieve(db, aid, '默认头像是鲸鱼吗', { k: 6, floor: 0, scene: 'S1' })
  check('S1 不再想起旧说法', !s1.items.some((x) => x.id === old.id), s1.items.map((x) => x.id))
  check('S1 能想起新说法', s1.items.some((x) => x.id === neu.id), s1.items.map((x) => x.id))

  const s3 = retrieve(db, aid, '记不记得默认头像是鲸鱼', { k: 6, floor: 0, scene: 'S3' })
  const stale = s3.items.find((x) => x.id === old.id)
  check('S3 深查看得到旧说法', !!stale, s3.items.map((x) => x.id))
  check('旧说法标了 stale', !!stale && stale.stale === true, stale && stale.stale)
  const packed = packInjection({ items: s3.items }, { budget: 400 })
  check('注入文本标「已更新」', packed.text.includes('已更新'), packed.text)

  const other = addMemory(db, aid, { text: '头像不要占满', type: 'fact', fact_key: '用户.头像.占比' })
  const otherRow = db.prepare('SELECT invalid_at FROM memory_items WHERE id=?').get(other.id)
  check('不同 key 不受牵连', !otherRow.invalid_at, otherRow)

  const flow = addMemory(db, aid, { text: '今天想了很多关于头像的事', type: 'reflection', fact_key: '用户.头像.默认' })
  const flowRow = db.prepare('SELECT invalid_at FROM memory_items WHERE id=?').get(flow.id)
  check('reflection 不被 fact_key 顶掉', !flowRow.invalid_at, flowRow)

  // 旧说法还能被 lookup 到（不是软删）：状态仍 active
  const st = db.prepare('SELECT status FROM memory_items WHERE id=?').get(old.id)
  check('旧说法只是失效，不是删除', st.status === 'active', st)

  // 卡片补出来的 key 不判生死：回填一遍不能把一整类记忆标成过期
  const keep = addMemory(db, aid, { text: '按钮要圆角', type: 'fact', fact_key: '用户.按钮.形状' })
  applyCard(db, keep.id, { key: '用户.按钮.形状', terms: ['按钮', '圆角'] }, '按钮要圆角')
  const keepRow = db.prepare('SELECT invalid_at, terms FROM memory_items WHERE id=?').get(keep.id)
  check('卡片写入不触发失效', !keepRow.invalid_at, keepRow)
  check('卡片写进去了', !!keepRow.terms, keepRow)
}

// ---------------------------------------------------------------- P3
{
  const a = addMemory(db, aid, { text: '小周是我的朋友' })
  const b = addMemory(db, aid, { text: '他喜欢篮球' })
  const c = addMemory(db, aid, { text: '住在城东' })
  const link = db.prepare('INSERT OR IGNORE INTO memory_links VALUES(?,?,?,?)')
  link.run(a.id, b.id, 'same_entity', 1.0)
  link.run(b.id, c.id, 'same_entity', 1.0)

  const hops = expandByLinks(db, aid, [{ partition: 'T1', id: a.id }], { hops: 2, decay: 0.65 })
  const hb = hops.find((x) => x.id === b.id)
  const hc = hops.find((x) => x.id === c.id)
  check('一跳邻居被扩散到', !!hb && hb.hop === 1, hb && hb.hop)
  check('二跳邻居被扩散到', !!hc && hc.hop === 2, hc && hc.hop)
  check('一跳分 0.45', !!hb && Math.abs(Number(hb._linkE) - 0.45) < 1e-6, hb && hb._linkE)
  check('二跳按 decay 打折', !!hc && Math.abs(Number(hc._linkE) - 0.2925) < 0.001, hc && hc._linkE)

  const one = expandByLinks(db, aid, [{ partition: 'T1', id: a.id }], { hops: 1 })
  check('hops=1 只走一跳', one.length === 1 && one[0].id === b.id, one.map((x) => x.id))

  const s3 = retrieve(db, aid, '小周', { k: 6, floor: 0, scene: 'S3', linkHops: 2 })
  check('S3 里一跳邻居进得来', s3.items.some((x) => x.id === b.id), s3.items.map((x) => `${x.id}:${x.via}`))

  const s1 = retrieve(db, aid, '小周', { k: 6, floor: 0, scene: 'S1' })
  check('S1 不扩二跳', !s1.items.some((x) => x.id === c.id), s1.items.map((x) => `${x.id}:${x.via}`))
}

db.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
