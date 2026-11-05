/**
 * 主动开口 · 事由（零件内）
 *
 * 找「有没有一件该说的事」：三观里答应过没做到的承诺 → 开环里答应过/提醒的 → 生活里看到的事 → 普通到期开环。
 * 只负责找事由，不管闸门；气头、安静、开关、预算仍然由 judge 拦。
 *
 * 共享件只读：pledgeMissLine（三观）、pendingLoops（开环）、latestShare（生活）。
 * 「特别看重」的标/撤归开环零件（`open_loops.important` 列）；这里只转发，方便老引用。
 */
import { pledgeMissLine } from '../../modules/sangguan/pledge.js'
import { pendingLoops, markLoopImportant, isLoopImportant } from '../../modules/loops.js'
import { latestShare } from '../../modules/life.js'

export { markLoopImportant, isLoopImportant }


export function proactiveTriggerOf(db, aid, at = Date.now()) {
  // 最重的一类欠账先看：sangguan 里「答应过、到点没做到」的承诺。
  // 它比普通开环更该被主动提起——普通开环是「该记挂的事」，这个是「我说了要做却没做」。
  try {
    const pm = pledgeMissLine(db, aid, new Date(at).toISOString())
    if (pm) {
      const text = String(pm.line || '')
        .replace(/^（/, '').replace(/）$/, '')
        .replace(/^你答应过的「/, '').replace(/」到点没做到。这件事还欠着。$/, '')
      if (text) return { kind: 'loop', owed: true, dim: 'R', id: 'pmiss:' + pm.seq, text: text.slice(0, 60), due_at: null }
    }
  } catch { /* 三观没开、或没有账本，就当没有这条 */ }
  // 欠账优先：答应过的、提醒的事排在「我生活里看到的好玩的」前面。
  // 人不会拿一件开心事盖住一句「我答应你的事还没做」。
  try {
    const loops = pendingLoops(db, aid, { at, limit: 3, includeHalfSaid: true })
    const owed = loops.find((l) => l.kind === 'promise' || l.kind === 'reminder') || null
    if (owed) {
      return {
        kind: 'loop',
        owed: true,
        dim: 'R',
        id: owed.id,
        text: String(owed.text || owed.title || '').slice(0, 60),
        due_at: owed.due_at || owed.stale_after || null,
      }
    }
  } catch { /* 开环表异常不影响开口 */ }
  try {
    const share = latestShare(db, aid, at)
    if (share) return { kind: 'share', dim: 'R', id: share.id, text: share.title, summary: share.summary, due_at: null }
  } catch { /* 生活流没挂也不影响开口 */ }
  try {
    const loops = pendingLoops(db, aid, { at, limit: 1 })
    if (loops.length) {
      const l = loops[0]
      return {
        kind: 'loop',
        // 2026-11-05 主人定：到期的事一律破例（「一路绿灯」）——
        // 只越过「今天说过一句」的额度；气头 / 安静 / 开关 / 休眠 / 预算这些安全闸照旧。
        owed: true,
        // 「我特别看重」由她自己标，可随时撤；现在是给事由一个显式名单，以后可做优先级。
        important: isLoopImportant(db, l.id),
        dim: 'R',
        id: l.id,
        text: String(l.text || l.title || '').slice(0, 60),
        due_at: l.due_at || l.stale_after || null,
      }
    }
  } catch { /* 开环表异常不影响开口 */ }
  return null
}
