/**
 * 判官回放：拿库里真实发生过的冲突，喂给判官判一遍，看它判成什么。
 *
 * 为什么需要：11-08 那批「冲突」人工读下来几乎没有一条是真的（40 条里真矛盾 0）。
 * 光看代码猜不出模型会怎么判，得让它真跑一遍——而且用的是**宿主那个模型**，
 * 不是本机 ollama（命令行进程拿不到宿主 llm）。
 *
 * 只读：不动记忆、不动冲突状态；默认也不写判官缓存（useCache=false），
 * 免得一次回放把之后的真实判定钉死。
 */
import { judgePair } from './pair_judge.js'

const one = (db, id) => {
  try { return db.prepare('SELECT id,text,created_at FROM memory_items WHERE id=?').get(id) || null } catch { return null }
}

/**
 * @param {object} opt
 * @param {(req:{system:string,text:string})=>Promise<string>} opt.complete 判官模型
 * @returns {Promise<{count:number,tally:object,items:Array}>}
 */
export async function replayConflicts(db, aid, { complete, limit = 20, timeoutMs = 20000, useCache = false } = {}) {
  if (typeof complete !== 'function') {
    return { error: { code: 'JUDGE_UNAVAILABLE', message: '没有可用的判官模型（宿主 llm 不可用）' } }
  }
  const n = Math.max(1, Math.min(200, Number(limit) || 20))
  const rows = db.prepare('SELECT * FROM conflicts WHERE agent_id=? ORDER BY opened_at DESC LIMIT ?').all(aid, n)
  const items = []
  for (const c of rows) {
    let ev = {}
    try { ev = JSON.parse(c.evidence || '{}') } catch { ev = {} }
    const a = one(db, c.a_id)
    const b = one(db, c.b_id)
    const oldRow = {
      id: c.a_id || ('old:' + c.id),
      created_at: a ? a.created_at : null,
      text: String((ev.attribute && ev.attribute.sentence_a) || ev.a_text || (a && a.text) || ''),
    }
    const newerRow = {
      id: c.b_id || ('new:' + c.id),
      created_at: b ? b.created_at : null,
      text: String((ev.attribute && ev.attribute.sentence_b) || ev.b_text || (b && b.text) || ''),
    }
    let r
    try {
      r = await judgePair({ db, aid, oldRow, newerRow, complete, timeoutMs, via: 'replay', useCache })
    } catch (e) {
      r = { verdict: 'error', reason: String((e && e.message) || e).slice(0, 120), ms: 0 }
    }
    items.push({
      conflict_id: c.id,
      state: c.state,
      kind: c.kind || null,
      similarity: ev.similarity == null ? null : Number(ev.similarity),
      verdict: r.verdict,
      reason: r.reason || null,
      raw: r.raw || null,
      ms: r.ms == null ? null : r.ms,
      a_text: oldRow.text.slice(0, 80),
      b_text: newerRow.text.slice(0, 80),
    })
  }
  const tally = {}
  for (const it of items) tally[it.verdict] = (tally[it.verdict] || 0) + 1
  return { count: items.length, tally, items }
}
