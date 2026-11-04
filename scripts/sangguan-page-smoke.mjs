/**
 * 页面改造 · 真库副本冒烟（P8）：不碰线上库，只读一份一致的快照，然后在副本上：
 * 开三列 → 看常驻 / 召回 / 草稿 / 收口后的 intake，再走一遍「手写一条 → 入库」。
 *
 * 用法：node scripts/sangguan-page-smoke.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const LIVE = process.env.SG_DB || join(homedir(), '.dsh', 'consciousness', 'app.db')
const dir = mkdtempSync(join(tmpdir(), 'dshc-page-smoke-'))
const copy = join(dir, 'app.db')

const src = new DatabaseSync(LIVE)
src.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`)
src.close()

process.env.DSH_HOME = dir
const { openDb } = await import('../src/db.js')
const { setSangguanConfig, sangguanConfig } = await import('../src/modules/sangguan/config.js')
const { loadState } = await import('../src/modules/sangguan/projection.js')
const { intakeCandidates } = await import('../src/modules/sangguan/intake.js')
const { mineEpisodes } = await import('../src/modules/sangguan/draftfeed.js')
const { createDraft, patchDraft, markCommitted } = await import('../src/modules/sangguan/draftstore.js')
const { commitDraft } = await import('../src/modules/sangguan/draft.js')
const { buildConstitution } = await import('../src/modules/sangguan/constitution.js')
const { injectView } = await import('../src/modules/sangguan/inject.js')

const db = openDb(copy)
const pick = db.prepare("SELECT agent_id, COUNT(*) n FROM raw_turns WHERE text IS NOT NULL GROUP BY agent_id ORDER BY n DESC LIMIT 1").get()
const aid = pick.agent_id
const s0 = loadState(db, aid)
const byLayer = (l) => Object.values(s0.claims).filter((c) => c.layer === l && c.status === 'active').length
const ev = db.prepare('SELECT kind, COUNT(*) n FROM claim_evidence WHERE agent_id=? GROUP BY kind').all(aid)

const before = {
  agent: aid,
  turns: pick.n,
  claims: { W: byLayer('W'), L: byLayer('L'), V: byLayer('V') },
  evidence: Object.fromEntries(ev.map((r) => [r.kind, r.n])),
  lanes: sangguanConfig(db, aid).lanes,
  inject: injectView(db, aid, { cache: false, mark: false }),
}

// 副本上开三列
setSangguanConfig(db, aid, { lanes: { W: true, L: true, V: true } })

// 收口：L 开着时，日记/志向不再进候选
const intake = intakeCandidates(db, aid)
// 取料：真历史里的取舍现场
const feed = mineEpisodes(db, aid, { limit: 3000, max: 60 })
// 常驻宪章 + 按句召回
const con = buildConstitution(db, aid)
const pv = injectView(db, aid, { query: '今天有点累，不太想说话', cache: false, mark: false })

// 草稿：手写一条，补齐五闸，再入库
const d0 = createDraft(db, aid, {
  source: 'manual',
  kind: '准确',
  text: '拿不准的时候我会说拿不准，不编一个听起来像样的答案',
  alt: '先给一个大概的答案，把场面撑住',
  foregone: '会显得自己不够可靠',
  exclusion: '不会用猜测冒充实测',
  evidence: [{ at: new Date().toISOString().slice(0, 10), quote: '冒烟测试：一句示例原话' }],
  vouch: true,
}, {})
const d1 = patchDraft(db, aid, d0.id, { counterexample: '还没有被违反过' })
let claimId = null
let commitErr = null
try { claimId = commitDraft(db, aid, d1, { human: true }) } catch (e) { commitErr = String(e.message || e) }
if (claimId) markCommitted(db, aid, d0.id, claimId)
const s1 = loadState(db, aid)

const after = {
  lanes: sangguanConfig(db, aid).lanes,
  intake_by_layer: intake.reduce((m, x) => ((m[x.layer] = (m[x.layer] || 0) + 1), m), {}),
  feed: feed.meta,
  constitution: { lines: con.lines.length, tokens: con.tokens },
  inject: {
    lines: pv.lines.length,
    tokens: pv.tokens,
    text: pv.text,
    lane_slots: pv.sources && pv.sources.lanes ? pv.sources.lanes : null,
  },
  draft: {
    gates: d1.gates,
    committed: !!claimId,
    claim: claimId ? { layer: s1.claims[claimId] && s1.claims[claimId].layer, kind: s1.claims[claimId] && s1.claims[claimId].kind, origin: s1.claims[claimId] && s1.claims[claimId].origin } : null,
    error: commitErr,
  },
  claims_after: { W: Object.values(s1.claims).filter((c) => c.layer === 'W' && c.status === 'active').length, L: Object.values(s1.claims).filter((c) => c.layer === 'L' && c.status === 'active').length, V: Object.values(s1.claims).filter((c) => c.layer === 'V' && c.status === 'active').length },
}

console.log(JSON.stringify({ before, after }, null, 2))
try { db.close() } catch { /* ignore */ }
try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
