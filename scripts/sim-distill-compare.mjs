/**
 * 蒸馏前后对比：同一剧本跑两遍（关 distill / 开 distill），比召回命中与事实来源。
 * 不调真实 LLM：夜巡用 mock summarize + extract。
 *
 * 用法：node scripts/sim-distill-compare.mjs [天数]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { appendTurn, buildEpisodes } from '../src/modules/archive.js'
import { runNightly, localDay } from '../src/modules/nightly.js'
import { retrieve } from '../src/modules/retrieve.js'
import { writeParam } from '../src/kernel.js'
import { addMemory } from '../src/modules/memory.js'
import { applyWrite } from '../src/modules/gate.js'
import { entityForText } from '../src/modules/entities.js'

const DAYS = Math.max(20, Math.min(120, Number(process.argv[2]) || 60))
const DAY = 86400000
const RealDate = Date
let fakeNow = RealDate.parse('2026-03-01T09:00:00+08:00')
class FakeDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(fakeNow); else super(...args) }
  static now() { return fakeNow }
}
globalThis.Date = FakeDate

/** 只埋在对话里的「金标事实」——基线不走 applyWrite，全靠纪要蒸馏才能进 T1 */
const GOLD = [
  { day: 3, talk: '我们定了：部署一律用方案甲，别再改回乙。', fact: '部署一律用方案甲', probe: '方案甲' },
  { day: 8, talk: '记住我喜欢深色主题写代码，界面也要深色。', fact: '喜欢深色主题', probe: '深色' },
  { day: 15, talk: '我的猫叫团子，是橘猫，以后别叫错。', fact: '猫叫团子', probe: '团子' },
  { day: 22, talk: '每周二晚上去游泳，这是决定。', fact: '每周二游泳', probe: '游泳' },
  { day: 35, talk: '项目名叫意识体插件，记到长期记忆里。', fact: '意识体插件', probe: '意识体' },
]

const CHATTER = ['今天天气还不错', '有点累早点睡', '刚开完会', '晚上想吃点好的']

async function runMode(label, { distill }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-cmp-'))
  const db = openDb(path.join(dir, 'app.db'))
  attachDb(db)
  const aid = 'agt_' + label
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, label, 'daily', 'active', now())
  writeParam(db, aid, 'memory.episode.distill', distill ? 'on' : 'off')
  writeParam(db, aid, 'memory.episode.distill.daily_cap', 6)
  writeParam(db, aid, 'memory.episode.refine', 'off')
  writeParam(db, aid, 'memory.episode.cluster_at', 0)

  fakeNow = RealDate.parse('2026-03-01T09:00:00+08:00')
  let distillWritten = 0

  for (let d = 0; d < DAYS; d++) {
    fakeNow += DAY
    const day = d + 1
    const dayStr = localDay(new Date())
    const gold = GOLD.find((g) => g.day === day)

    for (let i = 0; i < 2; i++) {
      const user = gold && i === 0
        ? gold.talk
        : CHATTER[(day + i) % CHATTER.length]
      appendTurn(db, aid, {
        sessionId: 's_' + dayStr, role: 'user', text: user,
        at: new Date(fakeNow - 3600000 + i * 2000).toISOString(),
      })
      appendTurn(db, aid, {
        sessionId: 's_' + dayStr, role: 'assistant',
        text: gold && i === 0 ? '好，我记下了：' + gold.fact : '嗯。',
        at: new Date(fakeNow - 3598000 + i * 2000).toISOString(),
      })
    }

    // 基线与实验都不对 GOLD 做按轮 applyWrite；只偶尔写入无关噪声，模拟 extract 噪音
    if (day % 9 === 0) {
      const noise = '今天开会开到很晚'
      const ent = entityForText(db, aid, noise)
      applyWrite(db, aid, { text: noise, entity_id: ent ? ent.id : null }, (cand) => addMemory(db, aid, {
        text: cand.text, type: 'fact', entity_id: cand.entity_id, source: 'extract',
      }))
    }

    const yDay = localDay(new Date(fakeNow - DAY))
    // 先压出纪要，再夜巡（含蒸馏）
    try { buildEpisodes(db, aid, { session: 's_' + yDay, day: yDay }) } catch { /* ignore */ }
    // 抬高金标天纪要 importance，确保过蒸馏阈值
    try {
      db.prepare("UPDATE episodes SET importance=0.85, summary=COALESCE(NULLIF(summary,''), title) WHERE agent_id=? AND day=?")
        .run(aid, yDay)
    } catch { /* ignore */ }

    const night = await runNightly(db, aid, {
      day: yDay,
      summarize: async (turns) => {
        const blob = JSON.stringify(turns || [])
        if (/日记|第一人称/.test(blob) || (Array.isArray(turns) && turns[0]?.text?.includes?.('日记'))) {
          return '这一天有些决定和偏好，值得记住。'
        }
        return '对方谈了重要决定与偏好。'
      },
      extract: async () => {
        // 用 yDay 原文匹配金标（模拟「从纪要材料抽事实」）
        const texts = db.prepare('SELECT text FROM raw_turns WHERE agent_id=? AND day=?').all(aid, yDay).map((r) => r.text).join('\n')
        const hit = GOLD.filter((x) => texts.includes(x.talk) || texts.includes(x.fact))
        if (!hit.length) return '[]'
        return JSON.stringify(hit.map((x) => ({ text: '用户' + x.fact, type: 'fact' })))
      },
    })
    const step = (night.steps || []).find((s) => s.step === 'episode_distill')
    if (step && step.written) distillWritten += Number(step.written) || 0
  }

  const probeList = GOLD.map((g) => ({ q: g.probe, want: g.probe }))
  let hit = 0
  const detail = []
  for (const p of probeList) {
    const r = retrieve(db, aid, p.q, { k: 8, scene: 'S1', noUpgrade: true })
    const ok = r.items.some((x) => String(x.text).includes(p.want))
    if (ok) hit++
    detail.push({ q: p.q, ok, top: r.items[0] ? String(r.items[0].text).slice(0, 36) : null, n: r.items.length })
  }

  const facts = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL").get(aid).n
  const fromEp = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND source='episode' AND status='active'").get(aid).n
  const fromEx = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND source='extract' AND status='active'").get(aid).n
  const diaries = db.prepare('SELECT COUNT(*) n FROM diaries WHERE agent_id=?').get(aid).n
  const eps = db.prepare('SELECT COUNT(*) n FROM episodes WHERE agent_id=?').get(aid).n

  const out = {
    label, distill, hit, total: probeList.length,
    rate: hit / probeList.length,
    facts, fromEp, fromEx, diaries, eps, distillWritten, detail,
  }
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
  return out
}

const off = await runMode('off', { distill: false })
const on = await runMode('on', { distill: true })

function pct(x) { return (Math.round(x * 1000) / 10) + '%' }

console.log('=== 纪要蒸馏对比 · ' + DAYS + ' 天 ===')
console.log('')
console.log('指标'.padEnd(18), '关 distill'.padStart(12), '开 distill'.padStart(12), '提升'.padStart(12))
console.log('-'.repeat(56))
const rows = [
  ['召回命中', off.hit + '/' + off.total, on.hit + '/' + on.total, (on.hit - off.hit) + ' 题'],
  ['命中率', pct(off.rate), pct(on.rate), pct(on.rate - off.rate)],
  ['活跃事实', String(off.facts), String(on.facts), String(on.facts - off.facts)],
  ['source=episode', String(off.fromEp), String(on.fromEp), String(on.fromEp - off.fromEp)],
  ['source=extract', String(off.fromEx), String(on.fromEx), String(on.fromEx - off.fromEx)],
  ['纪要条数', String(off.eps), String(on.eps), String(on.eps - off.eps)],
  ['日记篇数', String(off.diaries), String(on.diaries), String(on.diaries - off.diaries)],
  ['蒸馏写入次数', String(off.distillWritten), String(on.distillWritten), String(on.distillWritten - off.distillWritten)],
]
for (const r of rows) console.log(r[0].padEnd(18), r[1].padStart(12), r[2].padStart(12), r[3].padStart(12))
console.log('')
console.log('关 distill 分题：')
for (const d of off.detail) console.log(' ', d.ok ? '✓' : '✗', d.q, '→', d.top || '(空)')
console.log('开 distill 分题：')
for (const d of on.detail) console.log(' ', d.ok ? '✓' : '✗', d.q, '→', d.top || '(空)')

const improved = on.hit > off.hit
console.log('')
console.log(improved
  ? '结论：蒸馏打开后，金标事实召回命中 +' + (on.hit - off.hit) + '（' + pct(off.rate) + ' → ' + pct(on.rate) + '）'
  : '结论：未观察到命中提升（请检查 mock extract / 日界）')

if (on.hit < off.hit) process.exitCode = 1
if (on.fromEp < 1) process.exitCode = 1
