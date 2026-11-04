/**
 * 三观 · 收口（P7）：三列打开后，J1 不再抽 W/L；它们的入口是夜巡归纳与周章。
 * 运行：node test/sangguan-j1-lane.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sgj1-'))
process.env.DSH_HOME = home
const { openDb } = await import('../src/db.js')
const { setSangguanConfig } = await import('../src/modules/sangguan/config.js')
const { append } = await import('../src/modules/sangguan/ledger.js')
const fast = await import('../src/modules/sangguan/fast.js')
await import('../src/modules/sangguan/templates.js')
const { fakeChat } = await import('./sangguan-fake-llm.mjs')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 800)) }
}

const db = openDb(path.join(home, 'app.db'))
let n = 0
const agent = (name, lanes) => {
  const id = 'ag_j1_' + (++n) + '_' + name
  db.prepare('INSERT OR IGNORE INTO agents(id,name,created_at) VALUES(?,?,?)').run(id, name, new Date().toISOString())
  setSangguanConfig(db, id, { enabled: true, lanes: lanes || {} })
  return id
}
const T = (h) => '2026-11-02T0' + h + ':00:00.000Z'
const CANDS = [
  { layer: 'W', kind: 'belt', text: '大多数人愿意把道理讲清楚' },
  { layer: 'L', kind: 'chapter', text: '这一年学着把话说清楚，不绕弯' },
  { layer: 'V', kind: 'norm', text: '诚实比体面更重要，哪怕当场难看' },
]
const mkChat = () => fakeChat({
  J1: () => ({ candidates: CANDS.map((x) => ({ ...x })), evidence: [], tradeoffs: [], answers: [] }),
  J2: (input) => ({ pairs: input.neighbors.map((x) => ({ c_id: x.id, rel: 'unrelated' })) }),
})
const textsOf = (aid) => db.prepare('SELECT text FROM persona_claims WHERE agent_id=?').all(aid).map((r) => r.text)

// 三列都关：旧行为，三条都抽
{
  const aid = agent('off')
  const chat = mkChat()
  await fast.runFast({ db, aid, at: T(1), chat, embed: async () => null }, [{ role: 'user', text: '聊聊' }])
  const t = textsOf(aid)
  check('三列关着：W/L/V 三条都照旧抽', CANDS.every((c) => t.includes(c.text)), t)
  const j1 = chat.calls.filter((c) => c.id === 'J1').pop()
  check('三列关着：J1 输入仍给三层链头', j1 && j1.input.heads && Array.isArray(j1.input.heads.W), j1 && j1.input)
}

// W + L 打开：只剩 V 能进；J1 输入不再给 W/L 链头
{
  const aid = agent('wl', { W: true, L: true })
  // 先放一条 W 命题，确认它不会出现在 heads 里
  append(db, aid, [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: T(0), payload: { claims: [{ layer: 'W', kind: 'belt', text: '世界大体可以被理解', origin: 'extract' }] } }])
  const chat = mkChat()
  await fast.runFast({ db, aid, at: T(1), chat, embed: async () => null }, [{ role: 'user', text: '聊聊' }])
  const t = textsOf(aid)
  check('W/L 打开：W 候选不再入账', !t.includes(CANDS[0].text), t)
  check('W/L 打开：L 候选不再入账', !t.includes(CANDS[1].text), t)
  check('W/L 打开：V 候选照常入账', t.includes(CANDS[2].text), t)
  const j1 = chat.calls.filter((c) => c.id === 'J1').pop()
  check('W/L 打开：J1 输入只列 V', j1 && JSON.stringify(j1.input.only_layers) === '["V"]', j1 && j1.input.only_layers)
  check('W/L 打开：J1 不再给 W/L 链头', j1 && j1.input.heads.W === undefined && j1.input.heads.L === undefined, j1 && j1.input.heads)
}

// 只开 W：W 不进，L/V 照旧
{
  const aid = agent('w', { W: true })
  const chat = mkChat()
  const rep = await fast.runFast({ db, aid, at: T(1), chat, embed: async () => null }, [{ role: 'user', text: '聊聊' }])
  const t = textsOf(aid)
  check('只开 W：W 不进', !t.includes(CANDS[0].text), t)
  check('只开 W：L / V 照旧进', t.includes(CANDS[1].text) && t.includes(CANDS[2].text), t)
  check('只开 W：J1 只列 L / V', (() => {
    const j1 = chat.calls.filter((c) => c.id === 'J1').pop()
    return j1 && JSON.stringify(j1.input.only_layers) === '["L","V"]'
  })(), chat.calls.filter((c) => c.id === 'J1').pop() && chat.calls.filter((c) => c.id === 'J1').pop().input.only_layers)
  check('只开 W：没有留下 W 的候选占位', !(rep.items || []).some((x) => x && x.layer === 'W'), (rep.items || []).map((x) => x && x.layer))
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
