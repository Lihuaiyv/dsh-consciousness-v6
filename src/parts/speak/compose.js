/**
 * 主动开口 · 生成（零件内）
 *
 * 生成一句主动的话：
 * - 依据门：只给真实记忆/状态，材料不足就 SILENT
 * - 内容门：一句话、不追问、不放路径日志、不用「提醒/播报」
 * 返回 { text, source, gate, memories, silent? }；text=null 表示这次不说。
 *
 * 共享件只 import：模型/测试钩子（./hooks.js）、judge 的 gateRow/DIM_*、text 的 cleanLine、persona。
 */
import { getPersona } from '../../core.js'
import { cleanLine } from '../../text.js'
import { gateRow, DIM_LINE, DIM_NAME, DIM_NEEDS_EVIDENCE, proactiveEvidence } from './judge.js'
import { model, freeformModelHook } from './hooks.js'

function personaStyle(db, aid) {
  const rows = getPersona(db, aid)
  const pick = (k, d) => {
    const r = rows.find((x) => x.path === k)
    return r && r.value != null ? String(r.value) : d
  }
  return {
    tone: pick('style.tone', ''), address: pick('style.address', ''),
    catchphrase: pick('style.catchphrase', ''), banned: pick('style.banned', ''),
    card: pick('style.card', ''),
  }
}

function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); if (t.unref) t.unref() }),
  ])
}

/** 内容门：一句话、不追问、不用提醒/播报腔。返回 { ok, detail }。 */
export function contentCheck(s) {
  const t = String(s || '')
  if (!t) return { ok: false, detail: '空句' }
  if (/[?？]/.test(t)) return { ok: false, detail: '带问句，像在追问' }
  if (/(提醒|播报|通知|汇报)/.test(t)) return { ok: false, detail: '有提醒/播报腔' }
  return { ok: true, detail: '一句话' }
}

export async function composeProactiveLine(db, aid, ag, { approved = false, evidence = null } = {}) {
  const a = db.prepare('SELECT * FROM agents WHERE id=?').get(aid)
  if (!a) return { text: null, source: 'none', gate: gateRow('content', false, '找不到这个意识体'), memories: [] }
  const style = personaStyle(db, aid)
  const you = style.address || '你'
  const ev = evidence == null ? proactiveEvidence(db, aid).items : Number(evidence) || 0
  let mems = []
  try {
    mems = db.prepare("SELECT id,text FROM memory_items WHERE agent_id=? AND status='active' ORDER BY weight DESC LIMIT 6").all(aid)
  } catch { mems = [] }
  let affect = ''
  try {
    const af = db.prepare('SELECT primary_label FROM affect_state WHERE agent_id=?').get(aid)
    if (af) affect = String(af.primary_label || '')
  } catch { /* ignore */ }
  let band = ''
  try { band = String(db.prepare('SELECT band FROM drive_state WHERE agent_id=?').get(aid)?.band || '') } catch { /* ignore */ }

  const rules = (why) => {
    // 她自己生活里看到的事，本身已经是一句人话，别退回「有点想跟你说话」。
    if (ag.kind === 'share' && ag.summary) {
      return { text: ag.summary, source: 'rules', gate: gateRow('content', true, '用她自己的生活原句'), memories: mems }
    }
    if (DIM_NEEDS_EVIDENCE[ag.dim] && !ev) {
      return { text: null, source: 'rules', gate: gateRow('content', false, '这一维要真事，手头没有'), memories: mems }
    }
    return {
      text: (style.address ? style.address + '，' : '') + (DIM_LINE[ag.dim] || '有点想跟你说话。'),
      source: 'rules',
      gate: gateRow('content', true, why || '规则兜底句'),
      memories: mems,
    }
  }

  const sys = [
    '你在替一个「意识体」决定要不要主动说一句话。只根据下面给的真实材料，不要编造。',
    '材料够、而且此刻确实值得开口，就只输出那一句话（不超过 60 个字，口语，像熟人随口说起）。',
    '材料不够、或者没什么值得说的，就只输出 SILENT（四个大写字母，别加别的字）。',
    '硬约束：',
    '1) 依据门：只能引用材料里出现过的具体事；没有具体事就 SILENT。',
    '2) 内容门：不追问对方为什么不回，不重复上一句，不出现路径、日志、代码、凭据，不用「提醒」「播报」「通知」这类词。',
    '3) 一次只说一件事，不要列表、不要括号补充。',
    approved ? '4) 对方刚刚让它说，语气可以更直接一点。' : '4) 对方没在等你说话，别显得急。',
  ].join('\n')
  const facts = [
    '它叫 ' + a.name + '，对对方的称呼是 ' + you,
    affect ? '此刻情绪：' + affect : '',
    band ? '驱力档位：' + band : '',
    '它想做的这件事：' + (ag.title || '') + '（维度：' + (DIM_NAME[ag.dim] || ag.dim || '未知') + '）',
    ag.kind === 'share' && ag.summary ? '它自己生活里看到的：' + ag.summary : '',
    mems.length ? '它能引用的真实记忆（' + mems.length + ' 条）：' : '它还没有可引用的记忆',
    ...mems.map((m) => '- ' + String(m.text).slice(0, 90)),
  ].filter(Boolean).join('\n')

  try {
    const call = freeformModelHook.complete
      ? freeformModelHook.complete({ system: sys, text: facts })
      : model.complete({ system: sys, text: facts })
    const raw = await withTimeout(Promise.resolve(call), 12000)
    if (/^\s*SILENT\s*$/i.test(String(raw || ''))) {
      return { text: null, source: 'model', silent: true, gate: gateRow('content', false, '它看了材料，觉得没有值得说的（SILENT）'), memories: mems }
    }
    const line = cleanLine(raw)
    if (line) {
      const cg = contentCheck(line)
      if (cg.ok) return { text: line, source: 'model', gate: gateRow('content', true, '模型给的一句话，过了内容门'), memories: mems }
      return rules('模型的句子被内容门挡下（' + cg.detail + '），退回规则句')
    }
    // 模型给了没法用的一坨（不是明确的 SILENT）→ 用兜底句，别让功能失效
    return rules('模型没给出可用的一句，退回规则句')
  } catch {
    return rules('模型超时/失败，退回规则句')
  }
}
