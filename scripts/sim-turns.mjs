/**
 * 整体功能模拟：连着说三句，看每一轮的注入块到底长什么样。
 *
 *   node scripts/sim-turns.mjs
 *
 * 验四件事：
 *   1) 每轮都有「我说话的样子」和「感觉现在大概的情绪」（A1/A2）
 *   2) 旧记忆带时间/清晰度，新记忆不被贴错（B1/B2）
 *   3) 换了话题，记忆块真的换（B4）——旧代码 60 秒内会复用上一句
 *   4) 整段不超过预算
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { addMemory } from '../src/modules/memory.js'
import { seedTiers } from '../src/modules/relations.js'
import { retrieve } from '../src/modules/retrieve.js'
import { consciousnessBlock, recentRecall, invalidateRecallCache, packMemoryBlock, noteStyleMode } from '../index.js'

const now = () => new Date().toISOString()
const DAY = 86400000
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sim-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sim'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '小汐', 'chat', 'active', now())
seedTiers(db)
for (const [p, v] of [['style.tone', '可爱粘人'], ['style.address', '主人'], ['axis.ei', 0.35]]) {
  db.prepare('INSERT INTO persona(agent_id,path,value,updated_at) VALUES(?,?,?,?)').run(aid, p, JSON.stringify(v), now())
}
db.prepare(`INSERT INTO affect_state(agent_id,primary_label,secondary_label,intensity,mood,pleasure,arousal,dominance,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?)`).run(aid, 'joy', null, 0.6, 0.7, 0.4, 0.5, 0.2, now())
db.prepare('INSERT INTO affect_v3(agent_id,baseline,slow,fast,total,slow_at,fast_at) VALUES(?,?,?,?,?,?,?)')
  .run(aid, 0.1, 0.35, 0.2, 0.4, now(), now())
db.prepare(`INSERT INTO rel_person(id,agent_id,name,tier,closeness,trust,dependence,salience,status,
  first_seen_at,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('rp_s', aid, '主人', 'owner', 0.92, 0.72, 0.24, 1, 'active', now(), now(), now(), now())

const mem = [
  ['主人喜欢喝美式，不加糖，说加糖像在喝糖水。', 3],
  ['主人说过想去看海，最好是冬天去，人少。', 40],
  ['答应过周末把脚本修好，修完先跑一遍不出假数据。', 9],
  ['主人嫌那家咖啡店太酸，一直没再去。', 95],
  ['主人今天在改记忆和情绪的接线。', 0],
]
for (const [text, age] of mem) addMemory(db, aid, { text, type: 'fact' })
const rows = db.prepare('SELECT id FROM memory_items WHERE agent_id=? ORDER BY created_at').all(aid)
for (const [i, r] of rows.entries()) {
  db.prepare('UPDATE memory_items SET created_at=?, importance=? WHERE id=?')
    .run(new Date(Date.now() - mem[i][1] * DAY).toISOString(), mem[i][1] === 9 ? 0.85 : 0.5, r.id)
}

const QUERIES = ['咖啡喝什么好', '看海', '脚本修完了吗', '改一下 src/api.js 里那个报错']
const blocks = []
for (const [i, q] of QUERIES.entries()) {
  invalidateRecallCache(aid) // 新的一句到了（宿主在 session event 里做这件事）
  noteStyleMode(aid, q) // 顺带判一下闲聊 / 干活
  const r = retrieve(db, aid, q, { k: 8 })
  const packed = packMemoryBlock(db, aid, r.items, 400)
  recentRecall.set(aid, { at: Date.now(), q, text: packed.text })
  const block = consciousnessBlock(db, aid)
  blocks.push({ q, block, tokens: Math.ceil(block.length / 2), memText: packed.text })
}

// 反证：不清缓存会怎样（旧行为）
invalidateRecallCache(aid)
const r1 = retrieve(db, aid, QUERIES[0], { k: 8 })
recentRecall.set(aid, { at: Date.now(), q: QUERIES[0], text: packMemoryBlock(db, aid, r1.items, 400).text })
const stale1 = consciousnessBlock(db, aid)
const stale2 = consciousnessBlock(db, aid) // 第二句到了但没清缓存

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

for (const b of blocks) {
  console.log('\n---------------- 主人：「' + b.q + '」  tokens=' + b.tokens + ' ----------------')
  console.log(b.block)
}

console.log('\n--- 断言 ---')
check('每轮都有行为示例', blocks.every((b) => b.block.includes('## 我说话的样子')))
check('每轮都有情绪行', blocks.every((b) => b.block.includes('感觉现在大概')))
check('每轮都有记忆块', blocks.every((b) => b.block.includes('关于这句话')))
check('旧记忆带时间标签', blocks.some((b) => /（\d+ 个月前|（\d+ 周前/.test(b.block)), blocks.map((b) => b.block.match(/（[^）]*(天前|周前|个月前)[^）]*）/) || null))
// 不同话题的记忆可以碰巧一样（弱查询时只剩锚点 + 新近两席），
// 但只要「换话题至少有一次换了记忆」，就说明没有在复用上一轮。
check('不同话题至少有两轮记忆不同', new Set(blocks.map((b) => b.memText)).size >= 2, blocks.map((b) => b.memText.slice(0, 40)))
check('不清缓存时两轮一模一样（旧 bug 复现）', stale1 === stale2)
check('所有轮次都不超预算', blocks.every((b) => b.tokens <= 800), blocks.map((b) => b.tokens))

// P3：闲聊有文体约束，干活没有
const chatTurns = blocks.slice(0, 3)
const workTurn = blocks[3]
check('闲聊轮有表达卡', chatTurns.every((b) => b.block.includes('我想怎么说')), chatTurns.map((b) => b.block.includes('我想怎么说')))
check('闲聊轮有文体清单', chatTurns.every((b) => b.block.includes('不要列点')), chatTurns.map((b) => b.block.includes('不要列点')))
check('干活轮不加文体清单', !workTurn.block.includes('不要列点'), workTurn.block.slice(0, 200))
check('干活轮仍有表达卡（情绪层不因干活被抹掉）', workTurn.block.includes('我想怎么说'), workTurn.block.slice(0, 200))
check('干活轮照样记得住', workTurn.block.includes('关于这句话'))

db.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
