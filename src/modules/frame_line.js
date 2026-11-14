/**
 * 帧 · 只读一段（设计-帧-v0.1 §7 第 2 步）
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
export function formatFrame(fr, max = 60) {
  const focus = clipAtPunct(fr.focus, 24)
  const anchor = clipAtPunct(fr.anchor, 40)
  if (!focus && !anchor) return ''

  const body = [focus ? `停在「${focus}」` : '', anchor ? `锚是「${anchor}」` : '']
    .filter(Boolean)
    .join('，')
  // 偏得远的时候，把势阱中心也递上来——这就是「力」：
  // 不命令我回去，只是让中心出现在我看得见的地方。
  const drift = Number(fr.drift)
  const centerText = plain(fr.center_text || '')
  let forceLine = ''
  if (Number.isFinite(drift) && drift >= 2 && centerText) {
    forceLine = `（这一帧比平时偏得远：${drift.toFixed(1)}MAD。最近二十帧的中心是「${clipAtPunct(centerText, 30)}」）`
  }
  // 正文按预算收；**「力」那行不受正文预算管**——它是独立的一句，
  // 先前把两段拼在一起再截，结果力被切掉半句（2026-11-14 模拟时抓到）。
  const budget = Math.max(40, max)
  const trimmed = body.length > budget ? clipAtPunct(body, budget) : body
  return `## 上一帧（我上一次说到哪儿）\n${trimmed}${forceLine ? '\n' + clipAtPunct(forceLine, 70) : ''}`
}

/** 上一帧那一段；没有帧、或不是同一个 agent 的帧 → 返回 ''。 */
export function lastFrameLine({ max = 60, conv = null, agent = null } = {}) {
  try {
    if (!fs.existsSync(FRAMES)) return ''
    const buf = fs.readFileSync(FRAMES, 'utf8')
    const lines = buf.split('\n').filter((x) => x.trim())
    if (!lines.length) return ''

    let fr = null
    for (let i = lines.length - 1; i >= 0; i--) {
      let o
      try { o = JSON.parse(lines[i]) } catch { continue }
      if (typeof o === 'string') { try { o = JSON.parse(o) } catch { continue } }
      // 会话键必须是它；agent 键在旧帧里没有（null），那种只认「同会话 + 无 agent」的场合
      if ((o.conv || null) !== (conv || null)) continue
      if (agent && o.agent && o.agent !== agent) continue
      fr = o
      break
    }
    if (!fr) return ''
    return formatFrame(fr, max)
  } catch {
    return ''
  }
}
