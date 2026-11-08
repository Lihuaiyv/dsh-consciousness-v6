/**
 * 说话分寸 · 整体模拟（改前 vs 改后）
 *
 * 用假模型把「规则档 → 影子判断 → 词表生成 → 评委」整条链跑 40 轮，
 * 统计改前（24 句模板）和改后（生成句 + 夹边界）的差别：
 *   唯一句数 / AI 味词占比 / 重样率 / 夹边界率 / 评委偏好 / 影子落账数。
 *
 * 运行：node scripts/sim/sim-speech.mjs
 * 不改活库：临时目录建一份同样的 schema。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../../src/db.js'
import { feltLine, expressionState } from '../../src/modules/expression_state.js'
import { judgeSpeech, recordShadow, judgeCompare, recordCompare } from '../../src/modules/speech_judge.js'
import { generateVoice, recordVoice, recentVoices, latestVoice, validateVoice } from '../../src/modules/speech_words.js'

const TURNS = 40
const AI_FLAVOR = /有点|感觉|情绪/
const MOODS = [
  { label: 'joy', intensity: 0.8, slow: 0.3, warmth: 0.8 },
  { label: 'curious', intensity: 0.6, slow: 0.1, warmth: 0.6 },
  { label: 'lost', intensity: 0.3, slow: -0.3, warmth: 0.4 },
  { label: 'irritated', intensity: 0.5, slow: -0.1, warmth: 0.5 },
]

const VOICE_POOL = [
  '刚才那句我看了两遍',
  '话到嘴边没多说一句',
  '上一条回得比平时短',
  '把这件事在脑子里放了一会儿',
  '喝茶的时候想起这句话',
  '手指停在键盘上没动',
  '有点想追问',            // 禁词：应被挡
  '感觉心里发闷',          // 禁词：应被挡
  '刚才那句我看了两遍',    // 重样：应被挡
  '先听你说完再开口',
  '把窗子打开透了会儿气',
  '这句想换个说法再讲',
]

let voiceIdx = 0
const complete = async (messages) => {
  const sys = String(messages && messages[0] && messages[0].content || '')
  if (sys.includes('两版')) return '{"pick":"B","why":"更像","confidence":0.6}'
  if (sys.includes('"line"')) return JSON.stringify({ line: VOICE_POOL[voiceIdx++ % VOICE_POOL.length] })
  // 影子判断：故意爱往上抬，好检验「低落不许被抬」
  const m = /档位 (quiet|brief|normal|warm)/.exec(String(messages[1] && messages[1].content || ''))
  const up = { quiet: 'normal', brief: 'normal', normal: 'warm', warm: 'warm' }
  const level = up[m ? m[1] : 'normal'] || 'normal'
  return JSON.stringify({ level, sentences: 4, proactive: 2, tone: 'warm', why: '想多聊', confidence: 0.6 })
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sim-speech-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sim_speech'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,?)')
  .run(aid, '模拟', 'daily', 'active', now(), 13)

const before = { felt: [], shadow: 0, judge: 0, voice: 0 }
const after = { felt: [], shadow: 0, judge: 0, voice: 0, accepted: 0, attempts: 0, clamped: 0, judgePick: { rule: 0, model: 0, same: 0 } }

for (let i = 0; i < TURNS; i++) {
  const mood = MOODS[i % MOODS.length]
  const rule = { level: mood.slow <= -0.2 ? 'quiet' : mood.slow <= -0.05 ? 'brief' : mood.slow >= 0.25 ? 'warm' : 'normal' }
  // 完整规则档（跟 index.js 一样由 expressionState 算）
  const base = expressionState({ affect: { primary_label: mood.label, intensity: mood.intensity, v3: { slow: mood.slow, total: mood.slow } } })

  // ---- 改前：只有模板
  before.felt.push(base.felt)

  // ---- 改后：影子判断（只记）→ 词表（每 3 轮换一次）→ 合成
  const judged = await judgeSpeech({ complete, rule: { ...rule, sentences: base.sentences, proactive: base.proactive, tone: base.tone }, label: mood.label, intensity: mood.intensity, warmth: mood.warmth })
  if (judged.ok) {
    recordShadow(db, aid, { rule: base, verdict: judged.verdict, ms: judged.ms })
    after.shadow++
    if ((judged.verdict.clamped || []).length) after.clamped++
    const cmp = await judgeCompare({ complete, rule: base, suggest: judged.verdict, label: mood.label, intensity: mood.intensity })
    if (cmp.ok) { recordCompare(db, aid, { rule: base, suggest: judged.verdict, pick: cmp.pick, why: cmp.why, ms: cmp.ms }); after.judge++; after.judgePick[cmp.pick]++ }
  }

  if (i % 3 === 0) {
    after.attempts++
    const gen = await generateVoice({ complete, recent: recentVoices(db, aid), label: mood.label, intensity: mood.intensity, slow: mood.slow })
    if (gen.ok) { recordVoice(db, aid, { text: gen.text }); after.accepted++ }
  }
  const fresh = latestVoice(db, aid, { hours: 24 })
  const st = expressionState({
    affect: { primary_label: mood.label, intensity: mood.intensity, v3: { slow: mood.slow, total: mood.slow } },
    phrase: fresh ? fresh.text : '',
  })
  after.felt.push(st.felt)
}

const stat = (lines) => {
  const uniq = new Set(lines).size
  const ai = lines.filter((l) => AI_FLAVOR.test(l)).length
  return { total: lines.length, unique: uniq, aiFlavor: ai, aiRate: +(ai / lines.length).toFixed(3), repeatRate: +(1 - uniq / lines.length).toFixed(3) }
}
const b = stat(before.felt)
const a = stat(after.felt)
const voiceEvents = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='expr.phrase'").get(aid).n
const shadowEvents = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='expr.shadow'").get(aid).n
const judgeEvents = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='expr.judge'").get(aid).n
const bannedUsed = after.felt.filter((l) => /有点|感觉|情绪/.test(l)).length

const report = {
  turns: TURNS,
  before: b,
  after: a,
  voice: { attempts: after.attempts, accepted: after.accepted, served: after.accepted, events: voiceEvents, acceptRate: +(after.accepted / Math.max(1, after.attempts)).toFixed(3) },
  shadow: { events: shadowEvents, clamped: after.clamped, clampRate: +(after.clamped / Math.max(1, shadowEvents)).toFixed(3) },
  judge: { events: judgeEvents, pick: after.judgePick },
  bannedInPrompt: bannedUsed,
}
console.log(JSON.stringify(report, null, 2))

// 自检：改后不许出现 AI 味词、不许重样、事件数要对得上
let bad = 0
const must = (name, ok) => { if (!ok) { bad++; console.log('BAD ' + name) } }
must('改后没有 AI 味词', bannedUsed === 0)
must('改后比改前更多样', a.unique > b.unique)
must('改后重样率低于改前', a.repeatRate < b.repeatRate)
must('影子事件数与判断次数一致', shadowEvents === after.shadow)
must('评委事件数与判断次数一致', judgeEvents === after.judge)
must('词表事件数与接受数一致', voiceEvents === after.accepted)
console.log('bad', bad)
if (bad) process.exitCode = 1
