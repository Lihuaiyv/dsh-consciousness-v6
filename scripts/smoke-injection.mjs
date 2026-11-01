/**
 * 注入冒烟：真的把一段系统提示拼出来看一眼（不接宿主）。
 *
 *   node scripts/smoke-injection.mjs
 *
 * 验证三件事：
 *   1) 有「此刻我 / 我想怎么说」，没有旧的「这一轮的说话分寸」命令；
 *   2) 心跳排的候选会以「心里忽然浮上来」进上下文；
 *   3) 同一轮只出现一个语气出口（关系只给温度，不给句长命令）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { addMemory } from '../src/modules/memory.js'
import { surfaceQueueTick, pendingSurface } from '../src/modules/pulse.js'
import { consciousnessBlock } from '../index.js'
import { seedTiers } from '../src/modules/relations.js'

const now = () => new Date().toISOString()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-smoke-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_smoke_1'

db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '小汐', 'chat', 'active', now())

const putPersona = db.prepare('INSERT INTO persona(agent_id,path,value,updated_at) VALUES(?,?,?,?)')
putPersona.run(aid, 'style.tone', JSON.stringify('可爱粘人'), now())
putPersona.run(aid, 'style.address', JSON.stringify('主人'), now())
putPersona.run(aid, 'axis.ei', JSON.stringify(0.35), now())

db.prepare(`INSERT INTO affect_state(agent_id,primary_label,secondary_label,intensity,mood,pleasure,arousal,dominance,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?)`).run(aid, 'frustrated', null, 0.62, 0.4, -0.3, 0.3, -0.2, now())
db.prepare('INSERT INTO affect_v3(agent_id,baseline,slow,fast,total,slow_at,fast_at) VALUES(?,?,?,?,?,?,?)')
  .run(aid, -0.1, -0.45, 0.1, -0.41, now(), now())

seedTiers(db)
db.prepare(`INSERT INTO rel_person(id,agent_id,name,tier,closeness,trust,dependence,salience,status,
  first_seen_at,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('rp_1', aid, '主人', 'owner', 0.94, 0.74, 0.22, 1, 'active', now(), now(), now(), now())

addMemory(db, aid, { text: '主人今天在改情绪和记忆的接线。', type: 'fact' })
addMemory(db, aid, { text: '主人喜欢先给结论再解释。', type: 'fact' })
addMemory(db, aid, { text: '主人说过想去看海。', type: 'fact' })

// 排一条自发浮现
surfaceQueueTick(db, aid)
const queued = pendingSurface(db, aid)

const block = consciousnessBlock(db, aid)
const hasFelt = block.includes('感觉现在大概')
const hasWish = block.includes('我想怎么说')
const hasOldCommand = block.includes('这一轮的说话分寸') || block.includes('只说 1 句')
const hasSpontaneous = block.includes('心里忽然浮上来')
const toneLines = block.split('\n').filter((l) => l.startsWith('感觉现在大概') || l.startsWith('此刻我') || l.startsWith('我想怎么说') || l.startsWith('此刻情绪') || l.includes('说话分寸'))

console.log(block)
console.log('\n--- 断言 ---')
console.log(JSON.stringify({
  queued: !!queued,
  hasFelt, hasWish, hasOldCommand, hasSpontaneous,
  tone_line_count: toneLines.length,
  ok: hasFelt && hasWish && !hasOldCommand && hasSpontaneous && toneLines.length === 2,
}, null, 2))

db.close()
if (!(hasFelt && hasWish && !hasOldCommand && hasSpontaneous && toneLines.length === 2)) process.exitCode = 1
