// 情绪链端到端验收（真库副本）：压句先于总结、料是每句摘要、会话隔离、判断两行、失败回退、宿主优先级
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { summarizeAffairs, appraiseTurnNow } from '../src/modules/affect_v4_shadow.js'
import { hostComplete } from '../src/modules/host_llm.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.resolve(ROOT, '..', 'runtime', 'consciousness', 'app.db')
const DST = path.join(ROOT, 'scratch', 'e2e-chain.db')

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log('ok ' + name) } else { fail++; console.log('FAIL ' + name + (extra ? '  ' + String(extra).slice(0, 200) : '')) }
}

// ── 准备：真库副本 ──
for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(DST + s, { force: true }) } catch { /* 忽略 */ } }
fs.copyFileSync(SRC, DST)
for (const s of ['-wal', '-shm']) { if (fs.existsSync(SRC + s)) fs.copyFileSync(SRC + s, DST + s) }
const db = new DatabaseSync(DST)
// 2026-11-19：副本是从真库拷的，真库可能还没跑过新列的 ALTER（要重启插件才跑）。
// 这里按 db.js 的同一套补齐，保证副本结构和代码期望的一致；幂等，已经有了就跳过。
for (const sql of [
  'ALTER TABLE affect_v4_shadow ADD COLUMN goal_delta REAL',
  'ALTER TABLE affect_v4_shadow ADD COLUMN expect_delta REAL',
  'ALTER TABLE affect_v4_shadow ADD COLUMN future_delta REAL',
  'ALTER TABLE affect_v4_shadow ADD COLUMN severity TEXT',
]) { try { db.exec(sql) } catch { /* 已存在 */ } }
const aid = db.prepare("SELECT id FROM agents WHERE status='active' ORDER BY created_at LIMIT 1").get().id

const T = '2026-11-17T12:00:00.000Z'
function addLastSentence(turnId, conv, you, text, at = T) {
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(
    'evt_' + turnId, aid, 'presence.last_sentence',
    JSON.stringify({ text, you, turn_id: turnId, conv, max: 24, ms: 0, source: 'model' }), at,
  )
}

// 旧「事」：故意放一个像总结的帧，验证总结不再拿它当料
db.prepare('INSERT INTO affect_v4_shadow (id,agent_id,turn_id,conversation_id,at,frame_json,s,n,d,label,primary_json,secondary_json,confidence,conf_primary,label_tie,source,latency_ms,freeframe,rev,judgment_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
  'av4_old', aid, 'old_turn', 'convA', T,
  JSON.stringify({ summary: '旧事的总结不该进材料', material: {}, target: 'me' }),
  0.5, 0.2, 0.5, '无聊', '[]', '[]', 0.3, 0.3, 0, 'rules', 0, 1, 1, '{}',
)

// A 会话两轮压句 + B 会话一轮压句
addLastSentence('a1', 'convA', '你先试 14b', '我试了，慢')
addLastSentence('a2', 'convA', '换成 2.5 吧', '已换')
addLastSentence('b1', 'convB', 'B 会话在聊别的', 'B 会话的回话')

// ── 1) 料是「每句话的摘要」，不是旧「事」；且按会话隔离 ──
let cap = {}
const sumText = '· 我试了 14b，慢\n· 主人让我换 2.5'
await summarizeAffairs(db, aid, {
  conversationId: 'convA',
  complete: async (req) => { cap = req; return sumText },
})
check('料头是「最近这几句」', /最近这几句/.test(String(cap.text)), String(cap.text).slice(0, 80))
check('料含 A 会话压句', String(cap.text).includes('你先试 14b'), '')
check('料不含 B 会话压句', !String(cap.text).includes('B 会话在聊别的'), '')
check('料不再拿旧「事」', !String(cap.text).includes('旧事的总结不该进材料'), '')
check('料里有原话', /最近原话/.test(String(cap.text)), '')
const affairsA = JSON.parse(db.prepare("SELECT value FROM flags WHERE key='affect.v4.affairs|convA'").get()?.value || '{}')
check('A 会话的事写进自己的键', String(affairsA.text || '').startsWith('· '), JSON.stringify(affairsA).slice(0, 100))
check('总结最多三条、每条≤30', affairsA.text.split('\n').length <= 3 && affairsA.text.split('\n').every((l) => l.length <= 32), '')

// ── 2) 压句先于总结：总结会等这一轮的压句落库（最多等 3 秒） ──
const t0 = Date.now()
const waitP = summarizeAffairs(db, aid, {
  conversationId: 'convA', waitTurnId: 'a3',
  complete: async () => '· 我等到了这一句',
})
setTimeout(() => addLastSentence('a3', 'convA', '这一句刚压完', '这才对', new Date().toISOString()), 600)
await waitP
const waitMs = Date.now() - t0
check('总结等到了这一轮的压句（600ms 后才落库）', waitMs >= 500 && waitMs < 2600, 'waited=' + waitMs)
const affairsA2 = JSON.parse(db.prepare("SELECT value FROM flags WHERE key='affect.v4.affairs|convA'").get()?.value || '{}')
check('等到之后照常写事', String(affairsA2.text || '').includes('我等到了这一句'), String(affairsA2.text).slice(0, 80))

// ── 3) 判断：两行、事取上一轮总结、输入是「正在发生：」 ──
const judgeJson = JSON.stringify({ fact: '换模型', meaning: '技术调整，存在未被动到', by: 'other', to: 'me', goal_delta: 0.2, expect_delta: 0.2, future_delta: 0.3, severity: 'none', why: '换模型但还在', from: '原话' })
let appText = ''
await appraiseTurnNow(db, aid, {
  text: '继续吧', turnId: 'e2e_t1', conversationId: 'convA',
  complete: async (req) => { appText = String(req.text || ''); return judgeJson },
})
const rows = db.prepare("SELECT * FROM affect_v4_shadow WHERE agent_id=? AND turn_id='e2e_t1' ORDER BY rowid").all(aid)
check('本轮两行（rules+model）', rows.length === 2 && rows[0].source === 'rules' && rows[1].source === 'model', JSON.stringify(rows.map((r) => r.source)))
const f1 = JSON.parse(rows[1]?.frame_json || '{}')
check('事取的是上一轮总结', f1.summary === affairsA2.text || String(f1.summary || '').includes('我等到了这一句'), String(f1.summary).slice(0, 80))
check('判断输入按时间分「之前的事 / 当下的事」', appText.includes('【之前的事】') && appText.includes('【当下的事】'), appText.slice(0, 60))
check('判断行标 host', JSON.parse(rows[1]?.judgment_json || '{}').judge === 'host', '')

// ── 4) 判断失败：两行、回退规则、挂罢工标记 ──
db.prepare("DELETE FROM flags WHERE key LIKE 'affect.v4.strike%'").run()
await appraiseTurnNow(db, aid, {
  text: '再继续吧', turnId: 'e2e_t2', conversationId: 'convA',
  complete: async () => { throw new Error('judge down') },
})
const rows2 = db.prepare("SELECT * FROM affect_v4_shadow WHERE agent_id=? AND turn_id='e2e_t2' ORDER BY rowid").all(aid)
check('判断挂：仍两行', rows2.length === 2, JSON.stringify(rows2.map((r) => r.source)))
// 2026-11-22 主人定：不许规则兜底。缺参数 → 标 incomplete 报警，不补值。
const j2e = JSON.parse(rows2[1]?.judgment_json || '{}')
check('判断挂：model 行标 incomplete', j2e.judge === 'incomplete', JSON.stringify(j2e).slice(0, 100))
check('判断挂：报警记了缺哪几个', Array.isArray(j2e.missing) && j2e.missing.length > 0, j2e.missing)
check('判断挂：不补 by（不假装判出来了）', j2e.by === undefined, j2e.by)
check('判断挂：挂了罢工标记', !!db.prepare("SELECT value FROM flags WHERE key LIKE 'affect.v4.strike%' LIMIT 1").get(), '')

// ── 5) 宿主闸门：并发 1，同一时刻只跑一个；排队严格先来后到 ──
// 2026-11-22 主人定：聊天要按到达顺序，后到的急事也不许插队（能插的只有实验，走网关）。
const order = []
await Promise.all([
  hostComplete(db, {
    agent: String(aid), label: 'e2e-slow', priority: 5, timeoutMs: 10000,
    complete: async () => { await new Promise((r) => setTimeout(r, 700)); order.push('slow'); return 'slow' },
  }),
  new Promise((r) => setTimeout(r, 50)).then(() => hostComplete(db, {
    agent: String(aid), label: 'e2e-normal', priority: 5, timeoutMs: 10000,
    complete: async () => { order.push('normal'); return 'normal' },
  })),
  new Promise((r) => setTimeout(r, 60)).then(() => hostComplete(db, {
    agent: String(aid), label: 'e2e-fast', priority: 1, timeoutMs: 10000,
    complete: async () => { order.push('fast'); return 'fast' },
  })),
])
check('排队严格先来后到：后到的急事也不插队', order[0] === 'slow' && order[1] === 'normal' && order[2] === 'fast', JSON.stringify(order))

db.close()
console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
