/**
 * 帧 · 只读一段（设计-帧-v0.1 §7 第 2 步）
 *
 * 这是**帧的四道工序之一（读）**——帧是一个东西，不是四个。
 * 总入口和定义看 ./frame.js。
 *
 * 2026-11-14 修订（主人外部视角提的四条问题）：
 *  ① 带上 agent 键：同会话里换人说话，不串别人的帧；
 *  ② 不再硬裁 32 字（会把 markdown 的 ** 切一半）：先去掉符号，再裁到标点；
 *  ③ 不再挂在提示词最末（会被「收尾核对」那条硬规则盖住）：单独一小节，由调用方放靠前位置；
 *  ④ 有标题、有边界，不和「我想怎么说」那些混在尾部。
 *
 * 只给事实，不给指令：输出里绝不出现「请接上」这类话。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const FRAMES = path.join(ROOT, 'scratch', 'proto', 'frames_v2.jsonl')

/** 去掉 markdown 痕迹，别把 ** 、` 、> 切一半露在提示词里。 */
function plain(s) {
  return String(s == null ? '' : s)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 裁到标点为止：宁可短一点，也不要半句。 */
function clipAtPunct(s, n) {
  const t = plain(s)
  if (t.length <= n) return t
  const head = t.slice(0, n)
  const m = head.match(/^[\s\S]*[，。；：！？、,.!?;:]/)
  if (m && m[0].length >= Math.floor(n * 0.5)) return m[0].replace(/[，。；：！？、,.!?;:]$/, '')
  // 找不到标点就硬裁，但**留一个省略号**：让读的人知道是断了，不是话说完了
  return head.replace(/[，。；：！？、,.!?;:]$/, '') + '…'
}

/** 把一条帧记录格式化成提示词里那一段（纯函数，方便单测）。 */
export function formatFrame(fr, max = 60, { pull = 'normal', bias = 'on' } = {}) {
  // 拉力档位＝给多少原话。这是「紧/松」目前唯一能落地的代理量：
  // 给得越多，上一句拽得越紧；给个开头，就得我自己接。
  // tight 更紧、normal＝原样、loose 只给 12 字开头（详见 计划-帧-拉力器）。
  // 2026-11-18：这里改用 `in`（这一轮我被喂了什么），不再用 `focus`。
  // focus 本身就是用户那句话的摘要，却渲染成「停在「…」」（我的口吻），语义是错的；
  // in 才是「你说了什么、我才这么回」。老帧没有 in 时退回 focus，兼容。
  const inChars = pull === 'loose' ? 0 : 24
  const anchorChars = pull === 'tight' ? 80 : pull === 'loose' ? 12 : 40
  const said = inChars ? clipAtPunct(fr.in || fr.focus, inChars) : ''
  const anchor = clipAtPunct(fr.anchor, anchorChars)
  if (!said && !anchor) return ''

  const body = [said ? `上一句你说「${said}」` : '', anchor ? `锚是「${anchor}」` : '']
    .filter(Boolean)
    .join('，')
  // 偏得远的时候，把势阱中心也递上来——这就是「力」：
  // 不命令我回去，只是让中心出现在我看得见的地方。
  const drift = Number(fr.drift)
  const centerText = plain(fr.center_text || '')
  let forceLine = ''
  if (bias !== 'off' && Number.isFinite(drift) && drift >= 2 && centerText) {
    forceLine = `（这一帧比平时偏得远：${drift.toFixed(1)}MAD。最近二十帧的中心是「${clipAtPunct(centerText, 30)}」）`
  }
  // 正文按预算收；**「力」那行不受正文预算管**——它是独立的一句，
  // 先前把两段拼在一起再截，结果力被切掉半句（2026-11-14 模拟时抓到）。
  const budget = Math.max(40, max)
  const trimmed = body.length > budget ? clipAtPunct(body, budget) : body
  return `## 上一帧（我上一次说到哪儿）\n${trimmed}${forceLine ? '\n' + clipAtPunct(forceLine, 70) : ''}`
}

/**
 * 挑「上一帧」：同一条链里 k 最大的那帧。
 * 全链都没有 k（老数据）才退回「文件里最后出现的那帧」——那正是原来的行为，
 * 但文件顺序会被乱序污染，所以只当兜底，不再当主路。
 */
export function pickHead(rows, { conv = null, agent = null } = {}) {
  let byFile = null
  let byK = null
  for (const o of rows) {
    if (!o) continue
    if ((o.conv || null) !== (conv || null)) continue
    if (agent && o.agent && o.agent !== agent) continue
    byFile = o // 行序靠后的覆盖前面的
    if (typeof o.k === 'number' && (!byK || o.k > byK.k)) byK = o
  }
  return byK || byFile
}

/** 上一帧那一段；没有帧、或不是同一个 agent 的帧 → 返回 ''。 */
export function lastFrameLine({ max = 60, conv = null, agent = null, pull = 'normal', bias = 'on' } = {}) {
  try {
    if (!fs.existsSync(FRAMES)) return ''
    const rows = []
    for (const line of fs.readFileSync(FRAMES, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      if (typeof o === 'string') { try { o = JSON.parse(o) } catch { continue } }
      rows.push(o)
    }
    const fr = pickHead(rows, { conv, agent })
    if (!fr) return ''
    return formatFrame(fr, max, { pull, bias })
  } catch {
    return ''
  }
}

/** 「事帧前置」这一轮的第一条（2026-11-22）。
 *  摘要行该读它，不读影子帧里那份被事层覆盖过的 summary——出处只有一个。 */
function affairsFirstLine(db, conversationId) {
  try {
    const cid = conversationId ? String(conversationId) : ''
    const key = cid ? 'affect.v4.affairs|' + cid : 'affect.v4.affairs'
    let row = db.prepare('SELECT value FROM flags WHERE key=?').get(key)
    if (!row && cid) row = db.prepare('SELECT value FROM flags WHERE key=?').get('affect.v4.affairs')
    if (!row) return ''
    const t = String((JSON.parse(row.value) || {}).text || '')
    return t.split('\n')[0].trim()
  } catch { return '' }
}

/**
 * 加格那三行（2026-11-21）：我在哪 / 手上没完什么 / 下一步做什么。
 * 直接读 flags 里的 `affect.v4.affairs|<conv>`，不跨模块 import（免得循环依赖）。
 * 没有加格、或开关关了，返回 ''，上一帧那段与以前一字不差。
 */
function plusTail(db, conversationId) {
  return '' // 2026-11-21：找事那条路（我在/手上没完/下一步）已废弃，主人否掉。代码待清。
  /* eslint-disable no-unreachable */
  try {
    if (!db) return ''
    const cid = conversationId ? String(conversationId) : ''
    // 优先读格表（连续树的骨架）：那里有「开着的几条线 + 各自停在哪」；
    // 没格表再退回 affairs 快照（老会话、或开关刚关掉时）。
    const gKey = cid ? 'affect.v4.grid|' + cid : 'affect.v4.grid'
    const grow = db.prepare('SELECT value FROM flags WHERE key=?').get(gKey)
    if (grow) {
      const g = JSON.parse(grow.value) || {}
      const open = (g.nodes || []).filter((n) => n && n.state === 'open')
      if (open.length) {
        const shown = open.slice(0, 2).map((n) => n.line + (n.blocked ? `←卡在「${n.blocked}」` : `←${n.todo || '待推'}`))
        const first = open[0]
        // 条件驱动回退：当前这条卡住了，就在同一个父底下的兄弟线里找一条没卡的先走。
        // 这就是「退回上一层，挑那条现在能走的路」的最小实现。
        let pick = first
        if (first.blocked && first.parent) {
          const sib = open.find((n) => n !== first && n.parent === first.parent && !n.blocked && n.todo)
          if (sib) pick = sib
        }
        const next = pick.blocked ? `先解掉「${pick.blocked}」，再做「${pick.todo || pick.line}」` : `做「${pick.todo || pick.line}」`
        const s = `手上没完：${shown.join('；')}${open.length > 2 ? `；还有 ${open.length - 2} 条` : ''}；下一步：${next}`
        return s.length > 120 ? s.slice(0, 119) + '…' : s
      }
    }
    const key = cid ? 'affect.v4.affairs|' + cid : 'affect.v4.affairs'
    let row = db.prepare('SELECT value FROM flags WHERE key=?').get(key)
    if (!row && cid) row = db.prepare('SELECT value FROM flags WHERE key=?').get('affect.v4.affairs')
    if (!row) return ''
    const o = JSON.parse(row.value) || {}
    const open = Array.isArray(o.open) ? o.open.filter((x) => x && (x.line || x.todo)) : []
    if (!o.kind && !o.where && !open.length) return ''
    const bits = []
    if (o.where) bits.push('我在：' + String(o.where))
    // 几条线各自停在哪：最多列两条，多的折成「还有 N 条」
    if (open.length) {
      const shown = open.slice(0, 2).map((x) => x.line + (x.blocked ? `←卡在「${x.blocked}」` : `←${x.todo || '待推'}`))
      bits.push('手上没完：' + shown.join('；') + (open.length > 2 ? `；还有 ${open.length - 2} 条` : ''))
    }
    let next = '（手上没有没完的事）'
    if (open.length) {
      const f = open[0]
      next = f.blocked ? `先解掉「${f.blocked}」，再做「${f.todo || f.line}」` : `做「${f.todo || f.line}」`
    }
    bits.push('下一步：' + next)
    const s = bits.join('；')
    return s.length > 120 ? s.slice(0, 119) + '…' : s
  } catch { return '' }
}

/**
 * 影子帧那一段（2026-11-17）：从 affect_v4_shadow 读最近一帧（优先 model 行）。
 * 影子期默认不接提示词（frame.inject=off）；开了才由 index.js 优先用这条，空再回文件。
 */
export function shadowFrameLine(db, aid, { max = 60, conversationId = null } = {}) {
  try {
    if (!db || !aid) return ''
    const cid = conversationId ? String(conversationId) : ''
    const rows = cid
      ? db.prepare('SELECT frame_json, source FROM affect_v4_shadow WHERE agent_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT 8').all(aid, cid)
      : db.prepare('SELECT frame_json, source FROM affect_v4_shadow WHERE agent_id=? ORDER BY rowid DESC LIMIT 8').all(aid)
    const pick = rows.find((r) => r.source === 'model') || rows[0]
    if (!pick) return ''
    let fr = {}
    try { fr = JSON.parse(pick.frame_json || '{}') } catch { fr = {} }
    const summary = clipAtPunct(affairsFirstLine(db, conversationId) || fr.summary || fr.what, 24)
    const what = clipAtPunct(fr.what, 40)
    if (!summary && !what) return ''
    const body = [summary ? `停在「${summary}」` : '', what ? `锚是「${what}」` : ''].filter(Boolean).join('，')
    const trimmed = body.length > Math.max(40, max) ? clipAtPunct(body, Math.max(40, max)) : body
    const tail = plusTail(db, conversationId)
    return `## 上一帧（我上一次说到哪儿）\n${trimmed}${tail ? '\n' + tail : ''}`
  } catch {
    return ''
  }
}
