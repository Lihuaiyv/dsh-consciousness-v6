#!/usr/bin/env node
/**
 * 日记 v2 回放：在真实库的【临时副本】上重跑某几天的选料/成文，打印前后对照。
 * 只读原库：先 copy 到 tmp，再在副本上改；不写 ~/.dsh/consciousness/app.db。
 *
 *   node scripts/diary-replay.mjs --agent agt_xxx --days 2026-11-01,2026-11-02
 *   node scripts/diary-replay.mjs --agent agt_xxx --days 2026-11-02 --mode prompt
 *   node scripts/diary-replay.mjs --agent agt_xxx --days 2026-11-01,2026-11-02 --mode fixture --fixture scripts/fixtures/diary-fixtures.json
 *   node scripts/diary-replay.mjs --agent agt_xxx --days 2026-11-02 --mode v1
 *
 * 参数：
 *   --db       原库路径（默认 ~/.dsh/consciousness/app.db）
 *   --agent    agent id（默认：库里第一个 active）
 *   --days     逗号分隔；默认取有原料的最近 2 天
 *   --mode     select（默认，只看选料）/ prompt（只打印成文提示词）/ fixture（夹具当模型）/
 *              full（真模型，需插件宿主内的 llm；脚本里通常不可用）/ v1（旧模板对照）
 *   --fixture  夹具 JSON：{"2026-11-02":"日记正文", "__default":"…"}
 *   --out      输出 markdown（默认 docs/diary-replay-<时间>.md）；同名 .json 存指标
 */
import fs from 'node:fs'

const msgText = (m) => String((m && (m.content != null ? m.content : m.text)) || '')
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { createModel } from '../src/model.js'
import {
  collectCandidates, scoreScene, selectForDay, fetchSceneLines, diaryParams,
  diaryContext, diaryTone, buildDiaryV2, checkDiary, prepareDiary, writePrompt,
} from '../src/modules/diary.js'
import { buildDiaryV1 } from '../src/modules/archive.js'

const argv = process.argv.slice(2)
function flag(name, def) {
  const i = argv.indexOf('--' + name)
  if (i < 0) return def
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const SRC = String(flag('db', path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'consciousness', 'app.db')))
const MODE = String(flag('mode', 'select'))
const OUT = String(flag('out', path.join('docs', 'diary-replay-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.md')))
if (!fs.existsSync(SRC)) {
  console.error('找不到库：' + SRC)
  process.exit(1)
}

const FIX = flag('fixture', null)
let fixtureMap = null
if (MODE === 'fixture') {
  if (!FIX || FIX === true || !fs.existsSync(String(FIX))) { console.error('fixture 模式需要 --fixture <file.json>'); process.exit(1) }
  fixtureMap = JSON.parse(fs.readFileSync(String(FIX), 'utf8'))
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-diarep-'))
const dbPath = path.join(tmpDir, 'app.db')
fs.copyFileSync(SRC, dbPath)
const db = openDb(dbPath)
attachDb(db)

const aid = String(flag('agent', '') || (db.prepare("SELECT id FROM agents WHERE status='active' ORDER BY created_at LIMIT 1").get() || {}).id || '')
if (!aid) { console.error('库里没有 agent'); process.exit(1) }

function daysWithMaterial(n = 2) {
  const rows = db.prepare(`SELECT day, COUNT(*) c FROM raw_turns WHERE agent_id=? GROUP BY day ORDER BY day DESC LIMIT ?`).all(aid, n)
  return rows.map((r) => r.day)
}
const days = String(flag('days', '') || '').split(',').map((s) => s.trim()).filter(Boolean)
const useDays = days.length ? days : daysWithMaterial(2)

function makeFixtureChat(map) {
  return async (messages) => {
    const sys = String((messages[0] && msgText(messages[0])) || '')
    const user = String((messages[1] && msgText(messages[1])) || '')
    if (sys.includes('你在帮')) {
      const raw = user.replace(/^材料：\s*/, '')
      let o = {}
      try { o = JSON.parse(raw) } catch { o = {} }
      const top = (o.candidates || []).slice().sort((a, b) => Number(b.score) - Number(a.score)).slice(0, 2)
        .map((c, i) => ({ id: c.id, score: Number(c.score) || (8 - i), why: '夹具' }))
      return JSON.stringify({ scenes: top, insight: map.__insight || '我在意的不是事本身，是被怎么对待。', arc: '低落' })
    }
    const m = user.match(/"day":"(\d{4}-\d{2}-\d{2})"/)
    const day = m ? m[1] : ''
    const t = map[day] || map.__default
    if (!t) throw new Error('fixture missing: ' + day)
    return t
  }
}

let chat = null
let modelStatus = '未使用'
if (MODE === 'fixture') {
  modelStatus = '夹具（不是真模型）'
  chat = makeFixtureChat(fixtureMap)
} else if (MODE === 'full') {
  const m = createModel()
  const st = m.status()
  modelStatus = `primary=${st.primary} adapter=${st.adapter || '-'}`
  if (st.primary === 'ok') {
    chat = (messages, opt = {}) => m.chatPrimary(messages, opt.maxTokens ?? 900, !!opt.json, opt.temperature ?? 0.8)
  } else {
    console.error('模型不可用（' + st.primary + '），full 模式会只走选料 + 记录失败。')
  }
}

const lines = []
const rows = []
const log = (s = '') => { lines.push(s); console.log(s) }
const clip = (s, n) => { const x = String(s || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n) + '…' : x }
const countOf = (body, re) => (String(body).match(re) || []).length
function metrics(text) {
  const body = String(text || '').replace(/^\d{4}-\d{2}-\d{2}[^\n]*\n+/, '').trim()
  const paras = body.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
  return {
    chars: body.replace(/\s/g, '').length,
    paragraphs: paras.length,
    enumWords: countOf(body, /首先|其次|然后|接着|另外|还有一件事|第一|第二/g),
    reportWords: countOf(body, /处理了|完成了|优化了|修复了|接好了|改好了|搞定了/g),
  }
}

log(`# 日记 v2 回放`)
log('')
log(`- agent：${aid}`)
log(`- 源库：${SRC}（已复制到临时库）`)
log(`- 日期：${useDays.join('、')}`)
log(`- 模式：${MODE}${MODE === 'full' || MODE === 'fixture' ? '（' + modelStatus + '）' : ''}`)
log(`- 时间：${now()}`)
log('')

for (const day of useDays) {
  log(`## ${day}`)
  log('')
  const params = diaryParams(db, aid)
  const ctx = diaryContext(db, aid, day)
  const cands = collectCandidates(db, aid, day)
  const scored = cands.map((c) => ({ ...c, score: c.poignancy != null ? Number(c.poignancy) : scoreScene(db, aid, c) }))
    .sort((a, b) => b.score - a.score)
  log(`- 材料：候选 ${cands.length} 条；情绪 ${ctx.affect ? ctx.affect.label + ' ' + Number(ctx.affect.intensity).toFixed(2) : '无'}（${ctx.mood_source}）；口吻 ${diaryTone(ctx)}`)
  log(`- 参数：scenes=${params.scenes} min=${params.sceneMin} select=${params.sceneModel} maxChars=${params.maxChars}`)
  log('')
  log('候选（前 8）：')
  log('')
  log('| # | 分 | 标题 | 开环 | 轮数 |')
  log('|---|----|------|------|------|')
  scored.slice(0, 8).forEach((c, i) => {
    log(`| ${i + 1} | ${Number(c.score).toFixed(2)} | ${String(c.title).replace(/\|/g, '／').slice(0, 36)} | ${c.open_loops.length} | ${c.turns} |`)
  })
  log('')

  const prep = await prepareDiary(db, aid, day, chat ? { chat } : { chat: null })
  const picked = prep ? prep.picked : { scenes: [], select: '-', arc: '-', insight: '' }
  log(`选中（${picked.select}，${picked.arc || '-'}）：`)
  log('')
  if (prep) {
    prep.picked.scenes.forEach((s, i) => log(`${i + 1}. [${Number(s.score).toFixed(2)}] ${s.title}（${s.session_id || s.id}）`))
    if (picked.insight) log(`\n> 洞察：${picked.insight}`)
    log('')
    for (const s of prep.scenes) {
      log(`- ${s.title}：${s.grounding === 'raw' ? `原话 ${s.turns} 轮` : '没有原话，用纪要摘要'}；样例：${clip((s.lines[1] || s.lines[0] || {}).text, 60)}`)
    }
  } else {
    log('（没有可用材料）')
  }
  log('')

  if (MODE === 'prompt' && prep) {
    const p = writePrompt({
      name: prep.name,
      day,
      date: `${day.slice(0, 4)}年${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日 ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(Date.parse(day + 'T12:00:00Z')).getUTCDay()]}`,
      other: prep.other, tone: prep.tone, mood: prep.mood, mood_source: prep.ctx.mood_source,
      arc: prep.picked.arc, insight: prep.picked.insight, maxChars: prep.params.maxChars,
      scenes: prep.scenes.map((s) => ({
        when: String(s.start_at || s.created_at || '').slice(11, 16),
        gist: clip(s.title, 40),
        lines: s.lines.map((l) => ({ who: l.who === 'user' ? prep.other : '我', text: l.text })),
      })),
    })
    log('### system')
    log('```')
    log(p.system)
    log('```')
    log('### user')
    log('```json')
    log(p.user)
    log('```')
    log('')
    rows.push({ day, candidates: cands.length, scenes: picked.scenes.length, prompt: p })
    continue
  }

  const old = db.prepare('SELECT text,source,version FROM diaries WHERE agent_id=? AND day=?').get(aid, day)
  const oldM = old ? metrics(old.text) : null
  log(`原篇：${old ? `${old.source} v${old.version}` : '（没有）'}`)
  if (old) {
    log('')
    log('```')
    log(String(old.text).slice(0, 1200))
    log('```')
    log('')
    log(`原篇指标：${oldM.chars} 字 / ${oldM.paragraphs} 段 / 列举词 ${oldM.enumWords} / 汇报词 ${oldM.reportWords}`)
  }
  log('')

  let res = null
  let newM = null
  let gate = null
  if (MODE === 'v1') {
    res = await buildDiaryV1(db, aid, day, { force: true, summarize: chat ? (m) => chat(m, { maxTokens: 900 }) : null })
  } else if (MODE === 'select') {
    res = null
  } else {
    res = await buildDiaryV2(db, aid, day, { force: true, chat })
  }
  if (res && res.text) {
    newM = metrics(res.text)
    gate = checkDiary(res.text, { episodeTitles: cands.map((c) => c.title) })
  }
  if (res) {
    if (res.pending) {
      log(`结果：没写成（${res.fail_reason}），按 v2 不落假日记。候选场景 ${res.scenes ? res.scenes.length : 0} 条。`)
    } else {
      log(`新篇：${res.source} v${res.version}`)
      const w = res.context ? (JSON.parse(res.context).write || {}) : {}
      if (w.scenes) log(`用了：${w.scenes.map((s) => s.title).join('；')}`)
      if (newM) log(`新篇指标：${newM.chars} 字 / ${newM.paragraphs} 段 / 列举词 ${newM.enumWords} / 汇报词 ${newM.reportWords}`)
      log('')
      log('```')
      log(String(res.text).slice(0, 1600))
      log('```')
    }
  }
  rows.push({
    day, candidates: cands.length,
    old: oldM ? { source: old.source, ...oldM } : null,
    new: res ? {
      source: res.source, pending: !!res.pending, fail_reason: res.fail_reason || null,
      scenes: res.scenes ? res.scenes.length : 0, ...(newM || {}), gate: gate ? gate.ok : null,
    } : null,
  })
  log('')
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
fs.writeFileSync(OUT.replace(/\.md$/, '.json'), JSON.stringify(rows, null, 1), 'utf8')
console.log('\n写到 ' + OUT)
