/**
 * 关系域对外的三件「嘴」：两个工具 + 一条命令。
 *
 * 这里只放**定义与文案**，不碰宿主 API；注册在 index.js 的 hostSpec 里做，
 * 这样拿到一份临时 DB 就能直接测 execute / guard / handler（见 test/relations.test.mjs）。
 *
 * 约定：scope() 返回 { d, aid } 或 null。拿不到意识体时工具返回空答案，不抛错。
 */
import * as R from './relations.js'

export function relationTools(scope) {
  return [
    {
      name: 'relation_lookup',
      description: '查一个人是谁。用户问「这人是谁 / 我不记得了 / TA 是谁来着」时调用。只返回人物账本里有证据的内容；账本里没有就说没有，不要编。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '名字、称呼或一句描述' },
          context: { type: 'string', description: '用户原话，帮助消歧（可选）' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            card: { type: 'string' },
            confidence: { type: 'number' },
            candidates: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' }, score: { type: 'number' },
                  why: { type: 'string' }, tier: { type: 'string' },
                },
              },
            },
          },
        },
        render(_args, value) {
          const v = value || {}
          const card = v.card || '我这边没有这个人的记录。'
          const cands = (v.candidates || []).length > 1
            ? '\n候选：' + v.candidates.slice(0, 3).map((c) => c.name + '（' + (c.why || '') + '）').join('、')
            : ''
          return [{ type: 'text', text: card + cands }]
        },
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        try {
          const s = scope()
          if (!s) return { card: '', confidence: 0, candidates: [] }
          const out = R.lookup(s.d, s.aid, String((args && args.query) || ''), {
            context: String((args && args.context) || ''),
          })
          return {
            card: out.card || '',
            confidence: Number(out.confidence) || 0,
            candidates: (out.candidates || []).map((c) => ({ name: c.name, score: c.score, why: c.why, tier: c.tier })),
          }
        } catch (e) {
          return { card: '', confidence: 0, candidates: [], error: String((e && e.message) || e) }
        }
      },
    },
    {
      name: 'relation_remember',
      description: '把一个人或一层关系记进人物账本。硬规则：只在用户明确说过「记住这个人 / 记一下 TA 是我同事」并且同意之后调用；不要自己判断关系就写。调用必须带 confirm:true。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '名字或称呼' },
          tier: { type: 'string', enum: ['owner', 'acquaintance', 'stranger'] },
          summary: { type: 'string', description: '一句话：这人是谁 / 怎么认识的' },
          relation: { type: 'string', description: '关系角色，如「同事」「夫妻」' },
          other: { type: 'string', description: '他-他关系另一端的人名' },
          confirm: { type: 'boolean', description: '用户已经确认要写入时传 true' },
        },
        required: ['name', 'confirm'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' }, id: { type: 'string' },
            created: { type: 'boolean' }, reason: { type: 'string' },
          },
        },
        render(_args, value) {
          const v = value || {}
          return [{ type: 'text', text: v.ok ? '记下了。' : ('没写：' + (v.reason || '被拒绝了')) }]
        },
      },
      async execute(args) {
        try {
          if (!args || args.confirm !== true) return { ok: false, id: '', created: false, reason: '用户还没确认' }
          const s = scope()
          if (!s) return { ok: false, id: '', created: false, reason: '没有激活的意识体' }
          const out = R.remember(s.d, s.aid, {
            name: String((args && args.name) || '').trim(),
            tier: args && args.tier, summary: args && args.summary,
            relation: args && args.relation, other: args && args.other,
          }, { source: 'tool' })
          return { ok: !!out.ok, id: out.id || '', created: !!out.created }
        } catch (e) {
          return { ok: false, id: '', created: false, reason: String((e && e.message) || e) }
        }
      },
    },
  ]
}

/** 写关系的门：暂停中的实例不许写，没拿到用户明确同意也不许写。 */
export function relationToolGuards(scope) {
  return [
    (exec) => {
      if (!exec || exec.name !== 'relation_remember') return undefined
      let s = null
      try { s = scope() } catch (e) { return '关系账本读不到：' + String((e && e.message) || e) }
      if (!s) return '关系账本还没准备好（没有激活的意识体）'
      try {
        const a = s.d.prepare('SELECT status FROM agents WHERE id=?').get(s.aid)
        if (!a || a.status !== 'active') return '意识体暂停中，不能改关系'
      } catch { return '关系账本读不到 agent 状态' }
      if (!exec.arguments || exec.arguments.confirm !== true) {
        return '写关系前要先问用户并得到同意；确认后带 confirm:true 再调一次'
      }
      return undefined
    },
  ]
}

export function relationCommands(scope) {
  return [
    {
      name: 'whois',
      description: '查一个人是谁（人物卡）',
      input: { hint: '名字或称呼' },
      async handler(inv) {
        try {
          const raw = String((inv && inv.rawInput) || '').trim()
          if (!raw) return { kind: 'error', text: '用法：/whois 小周' }
          const s = scope()
          if (!s) return { kind: 'error', text: '还没有激活的意识体' }
          const out = R.lookup(s.d, s.aid, raw, {})
          if (out.card) return { kind: 'success', text: out.card }
          const cands = (out.candidates || []).slice(0, 3)
          const tail = cands.length
            ? '有点像：' + cands.map((c) => c.name + '（' + (c.why || '') + '）').join('、') + '。'
            : ''
          return { kind: 'success', text: '我这边没有「' + raw + '」的记录。' + tail }
        } catch (e) {
          return { kind: 'error', text: '查关系时出错：' + String((e && e.message) || e) }
        }
      },
    },
  ]
}
