/**
 * 降级留痕：模型调不到时不许静默退回规则。
 * 运行：node test/fallback.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { seedAffect, appraise, fallbackStats } from '../src/modules/affect.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-fb-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_fb'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '降级', 'daily', 'active', now())
seedAffect(db, aid)

const LABELS = ['joy', 'peaceful', 'curious', 'calm', 'confused', 'lost', 'irritated', 'frustrated']
const fallbacks = () => db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='affect.fallback' ORDER BY rowid").all(aid).map((r) => JSON.parse(r.payload))

// ---------- 一、传了空 hint 也算降级 ----------
await appraise(db, aid, '随便一句', { labels: LABELS, hint: null })
const f1 = fallbacks()
check('空 hint 记了一条', f1.length === 1, { n: f1.length })
check('原因是 empty-hint', f1[0] && f1[0].reason === 'empty-hint', f1[0])
check('记下了原话片段', f1[0] && String(f1[0].text).includes('随便一句'), f1[0])

// ---------- 二、模型抛错要记下原因 ----------
/* 临时把 appraise 的 hint 走不到，用 hint 抛错的路径模拟不了；
   换成直接造一条 error 事件，验证统计能分类。 */
db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
  .run('evt_err', aid, 'affect.fallback', JSON.stringify({ reason: 'error: model offline', text: '第二句', formula: 'v1' }), now())
let st = fallbackStats(db, aid, { days: 1 })
check('统计把两条都算上', st.total === 2, st)
check('按原因归类', st.byReason['empty-hint'] === 1 && st.byReason['error'] === 1, st.byReason)
check('最近几条带原话', st.recent.some((r) => String(r.text).includes('第二句')), st.recent)

// ---------- 三、正常有 hint 时不记 ----------
const before = fallbacks().length
await appraise(db, aid, '还是不对', {
  labels: LABELS,
  hint: {
    label: 'irritated', kind: 'eval', polarity: -0.5,
    goal_relevance: 0.6, goal_congruence: -0.4,
    certainty: 0.8, novelty: 0.3, source: 'model',
    why: '在纠错', target: 'me', receive: 'hold',
  },
})
const after = fallbacks().length
check('正常判断不留降级痕', after === before, { before, after })

// ---------- 四、时间窗 ----------
const old = new Date(Date.now() - 10 * 86400000).toISOString()
db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
  .run('evt_old', aid, 'affect.fallback', JSON.stringify({ reason: 'error: old' }), old)
check('7 天窗里看不见十天前的', fallbackStats(db, aid, { days: 7 }).total === 2, fallbackStats(db, aid, { days: 7 }))
check('30 天窗里能看见', fallbackStats(db, aid, { days: 30 }).total === 3, fallbackStats(db, aid, { days: 30 }))

// ---------- 五、空库不炸 ----------
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-fb2-'))
const db2 = openDb(path.join(dir2, 'app.db'))
const empty = fallbackStats(db2, 'agt_none', { days: 7 })
check('空库返回零', empty.total === 0 && Array.isArray(empty.recent), empty)
try { fs.rmSync(dir2, { recursive: true, force: true }) } catch { /* ignore */ }

try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
