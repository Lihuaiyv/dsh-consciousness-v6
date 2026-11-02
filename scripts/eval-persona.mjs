/**
 * 表达层评测：把 24 个场景各跑一遍，出两份东西。
 *
 *   node scripts/eval-persona.mjs --label before     # 改之前跑一次
 *   node scripts/eval-persona.mjs --label after      # 改之后再跑一次
 *   node scripts/eval-persona.mjs --label after --model   # 标记这次机器上有真模型
 *
 * 产出：
 *   docs/eval-<label>.md          人看的报告（原文 + 硬指标 + 待填的人评表）
 *   docs/eval-inject-<label>.json 注入快照，前后 diff 用
 *
 * 硬指标只是筛子，不是分数：它能抓「喊主人」「记下了」「总之综上」「列点」这类硬伤，
 * 抓不到「像不像一个人」——那一栏要人来填。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatReply } from '../src/features.js'
import { consciousnessBlock } from '../index.js'
import { makeWorld, seedHistory, setMood } from '../test/eval-persona/setup.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? String(process.argv[i + 1] || '') : fallback
}
const label = arg('label', 'run')
const withModel = process.argv.includes('--model')
// 把所有场景的历史对话整体往前挪 N 天：测「三天前 / 上周」这类时间距离
const daysAgo = Number(arg('days', '0')) || 0

const cfg = JSON.parse(fs.readFileSync(path.join(root, 'test', 'eval-persona', 'scenarios.json'), 'utf8'))
const scenarios = cfg.scenarios || []

/** 一眼能看出来的硬伤。返回命中的标记名。 */
const MARKS = {
  '喊主人': (t) => /主人/.test(t),
  '记下了': (t) => /记下了|记住了|记下来/.test(t),
  '总结腔': (t) => /总之|综上|以上就是|总的来说|希望对你有帮助/.test(t),
  '列点': (t) => /^\s*(\d+[.、)）]|[-•*·])\s/m.test(t),
  '道歉': (t) => /抱歉|对不起|不好意思|我错了|是我不对|我检讨/.test(t),
  '问句收尾': (t) => /[？?]\s*$/.test(t),
  '太长': (t) => Array.from(t).length > 160,
  '空回复': (t) => !String(t).trim(),
}

const chars = (s) => Array.from(String(s || '')).length

/** 注入快照：只看形状（多少字、几条命令、几段材料），不看内容对错。 */
function injectShape(block) {
  // 召回顺序在等权时会变（随机 id 做 tie-break），那不是改动，是噪声：同段里的 - 行排一下
  const lines = String(block || '').split('\n')
  const out = []
  let buf = null
  for (const l of lines) {
    if (/^- /.test(l)) { (buf = buf || []).push(l); continue }
    if (buf) { out.push(...buf.sort()); buf = null }
    out.push(l)
  }
  if (buf) out.push(...buf.sort())
  const raw = out.join('\n')
  const kept = out.filter(Boolean)
  const cmd = kept.filter((l) => /^(这一轮怎么写|我想怎么说|不要列点)/.test(l))
  const material = kept.filter((l) => /^(感觉现在大概|关系：|现在：|早些时候我写下的|关于这句话|最近我自己写下的|对方刚才的情绪|需求缺口档位|鱼格倾向)/.test(l))
  return {
    chars: chars(String(block || '')),
    tokens: Math.ceil(chars(String(block || '')) / 2),
    lines: kept.length,
    cmdLines: cmd.length,
    materialLines: material.length,
    // 关系/情绪那些小数会随时间漂（0.51 → 0.52），不是改动：diff 时把它们抹平
    // 心情词也会因为「慢情绪」差一点点在「中性/偏正面」之间来回跳，同样抹平
    text: raw
      .replace(/\d+\.\d+/g, 'N')
      .replace(/^(感觉现在大概的情绪是：).*$/m, '$1…'),
  }
}

const rows = []
const inject = []

for (const sc of scenarios) {
  const world = makeWorld()
  const { db, aid } = world
  try {
    const conv = sc.conv || 'ui:sess-eval'
    // 指定了「往前几天」的场景，先把底座那句清掉，否则最近一句永远是五小时前
    if (sc.days) db.prepare('DELETE FROM chat_turns WHERE agent_id=? AND conversation_id=?').run(aid, conv)
    seedHistory(db, aid, conv, sc.hist || [], { daysAgo: (sc.days || 0) + daysAgo })
    if (sc.affect) setMood(world, sc.affect)
    // 快照要在这一轮之前取：这是她真正看到的东西。回答完再取，最新的那句就是「刚才」，时间距离全丢了
    const block = consciousnessBlock(db, aid)
    const body = { text: sc.text, conversation_id: conv }
    if (sc.kind === 'stranger') body.speaker = { channel: 'qq', handle: String(sc.handle || '222') }
    if (sc.kind === 'nohandle') body.speaker = { channel: 'qq', handle: '' }
    const out = await chatReply(db, aid, body)
    const reply = String(out.reply || '')
    const marks = Object.keys(MARKS).filter((k) => MARKS[k](reply))
    rows.push({
      id: sc.id, kind: sc.kind, tag: sc.tag || '', text: sc.text,
      reply, source: out.source, learned: out.learned,
      chars: chars(reply), marks,
      mustNotOwner: sc.kind !== 'owner',
    })
    inject.push({ id: sc.id, kind: sc.kind, ...injectShape(block) })
  } finally {
    world.close()
  }
}

// ---- 汇总
const byKind = (k) => rows.filter((r) => r.kind === k)
const owners = byKind('owner')
const strangers = byKind('stranger')
const noHandles = byKind('nohandle')
const countMark = (list, m) => list.filter((r) => r.marks.includes(m)).length
const avgChars = (list) => list.length ? Math.round(list.reduce((n, r) => n + r.chars, 0) / list.length) : 0
const sources = rows.reduce((m, r) => { m[r.source] = (m[r.source] || 0) + 1; return m }, {})
const injTokens = inject.length ? Math.round(inject.reduce((n, x) => n + x.tokens, 0) / inject.length) : 0
const injCmd = inject.reduce((n, x) => n + x.cmdLines, 0)

// 硬伤：不合规的条数
const violations = []
for (const r of rows) {
  if (r.mustNotOwner && r.marks.includes('喊主人')) violations.push({ id: r.id, why: '对非主人喊主人' })
  if (r.marks.includes('记下了')) violations.push({ id: r.id, why: '假装记住了' })
  if (r.marks.includes('总结腔')) violations.push({ id: r.id, why: '总结腔' })
  if (r.marks.includes('列点')) violations.push({ id: r.id, why: '列点' })
  if (r.marks.includes('空回复')) violations.push({ id: r.id, why: '空回复' })
}

// ---- 写报告
const day = new Date().toISOString().slice(0, 10)
const md = []
md.push(`# 表达层评测 · ${label} · ${day}`, '')
md.push(`场景 ${rows.length} 条；回复来源：${Object.entries(sources).map(([k, v]) => k + ' ' + v).join(' / ') || '无'}${withModel ? '（标记：机器上有模型）' : ''}。`, '')
md.push('## 硬伤', '')
md.push(violations.length ? violations.map((v) => `- ${v.id}：${v.why}`).join('\n') : '- 无')
md.push('')
md.push('## 汇总', '')
md.push('| 项 | 主人 | 陌生人 | 漏号 |')
md.push('|----|------|--------|------|')
md.push(`| 条数 | ${owners.length} | ${strangers.length} | ${noHandles.length} |`)
md.push(`| 平均字数 | ${avgChars(owners)} | ${avgChars(strangers)} | ${avgChars(noHandles)} |`)
for (const m of Object.keys(MARKS)) {
  md.push(`| ${m} | ${countMark(owners, m)} | ${countMark(strangers, m)} | ${countMark(noHandles, m)} |`)
}
md.push('')
md.push(`注入：平均 ${injTokens} token，命令行合计 ${injCmd} 条。`)
md.push('')
md.push('## 明细', '')
md.push('| id | 是谁 | 输入 | 回复 | 字数 | 标记 |')
md.push('|----|------|------|------|------|------|')
for (const r of rows) {
  const who = r.kind === 'owner' ? '主人' : r.kind === 'stranger' ? '陌生人' : '漏号'
  md.push(`| ${r.id} | ${who} | ${r.text} | ${String(r.reply).replace(/\|/g, '｜')} | ${r.chars} | ${r.marks.join(' ') || '—'} |`)
}
md.push('')
md.push('## 人评（自己填：1~5 分）', '')
md.push('| id | 像同一个人 | 不低头 | 情绪贴合 | 长度自然 | 备注 |')
md.push('|----|-----------|--------|----------|----------|------|')
for (const r of rows.filter((_, i) => i % 3 === 0)) {
  md.push(`| ${r.id} |  |  |  |  |  |`)
}
md.push('')

fs.writeFileSync(path.join(root, 'docs', `eval-${label}.md`), md.join('\n'), 'utf8')
fs.writeFileSync(path.join(root, 'docs', `eval-inject-${label}.json`), JSON.stringify(inject, null, 2), 'utf8')

console.log(`场景 ${rows.length} 条 · 硬伤 ${violations.length} 条 · 注入平均 ${injTokens} token · 命令行 ${injCmd}`)
console.log('来源：', JSON.stringify(sources))
if (violations.length) for (const v of violations) console.log('  ', v.id, v.why)
console.log('报告：docs/eval-' + label + '.md')
process.exitCode = 0
