/**
 * 整体功能模拟：同一段对话，两条口径各跑一遍。
 *   旧：没有 feel 通路 + 慢情绪不限幅
 *   新：feel 通路（每轮先记一句）+ 慢情绪限幅 0.2
 * 看三件事：注入行还差不差半拍、慢情绪会不会挂成柱子、起伏是不是被拍平。
 * 运行：node test/sim-feel-band.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { appraise, applyEmotionV3 } from '../src/modules/affect.js'
import { consciousnessBlock } from '../index.js'
import { recordFeel, latestFeel, feelLineOf } from '../src/modules/feel.js'
import { writeParam } from '../src/kernel.js'

const LABELS = ['joy', 'peaceful', 'curious', 'calm', 'confused', 'lost', 'irritated', 'frustrated']
const SCRIPT = [
  { u: '早，今天还得接着改那个插件', label: 'calm', cong: 0.1, polarity: 0.1, feel: '还行，就是有点没睡醒' },
  { u: '测试又红了三条', label: 'frustrated', cong: -0.4, polarity: -0.5, feel: '有点烦，但不是冲他' },
  { u: '修好了', label: 'joy', cong: 0.7, polarity: 0.8, feel: '松了一下，像把肩膀放下了' },
  { u: '你刚才那句说得挺对的', label: 'joy', cong: 0.6, polarity: 0.7, feel: '被夸到了，有点想装作没事' },
  { u: '我先去吃饭了', label: 'peaceful', cong: 0.1, polarity: 0.1, feel: '剩我自己待着，倒也还好' },
  { u: '回来了，继续', label: 'calm', cong: 0.1, polarity: 0.1, feel: '他回来了，我心里有点亮' },
  { u: '这个真的要今天做完吗', label: 'confused', cong: -0.2, polarity: -0.2, feel: '说不好，我有点拿不准' },
  { u: '别急，慢慢来', label: 'peaceful', cong: 0.3, polarity: 0.3, feel: '被安抚了一下' },
  { u: '你看这里是不是又写错了', label: 'irritated', cong: -0.5, polarity: -0.5, feel: '有点委屈，明明是刚改的' },
  { u: '哦是我看错了', label: 'peaceful', cong: 0.2, polarity: 0.2, feel: '气一下散了，还有点想笑' },
  { u: '今天到这吧', label: 'calm', cong: 0.1, polarity: 0.1, feel: '有点舍不得，但也确实累了' },
  { u: '明天见', label: 'peaceful', cong: 0.2, polarity: 0.2, feel: '那就明天见吧' },
]

function padFor(label) {
  const joy = label === 'joy'
  return {
    joy: 0.9, peaceful: 0.5, curious: 0.4, calm: 0.1,
    confused: 0, lost: 0, irritated: joy ? 0 : 0.7, frustrated: joy ? 0 : 0.8,
  }
}

async function runArm(name, { feel, band }) {
  const w = makeWorld()
  if (!band) writeParam(w.db, w.aid, 'affect.slow.band', 0)
  const t0 = Date.now() - SCRIPT.length * 60000 // 全排在过去：注入行按「现在」往前看，不能给它未来时间
  const turns = []
  for (let i = 0; i < SCRIPT.length; i++) {
    const t = SCRIPT[i]
    const at = t0 + i * 60000
    // 这一轮她看到的注入（拼在回复之前）
    const block = consciousnessBlock(w.db, w.aid)
    const sawOwnFeel = /我上一句说出来之前/.test(block)
    const prevOwn = latestFeel(w.db, w.aid, { at })
    // 开口之前先记一句（新口径才有）
    if (feel) recordFeel(w.db, w.aid, { text: t.feel, at })
    // 说完之后才有评价
    await appraise(w.db, w.aid, t.u, {
      labels: LABELS, closeness: 0.9,
      hint: {
        label: t.label, kind: 'chat', polarity: t.polarity,
        goal_relevance: 0.6, goal_congruence: t.cong,
        certainty: 0.8, novelty: 0.3, source: 'model',
        user_label: t.label, user_scores: padFor(t.label),
        why: '模拟', target: 'me',
      },
    })
    const st = w.db.prepare('SELECT slow, fast, total, baseline FROM affect_v3 WHERE agent_id=?').get(w.aid)
    const own = latestFeel(w.db, w.aid, { at: at + 30000 })
    turns.push({
      i, slow: Number(st.slow), fast: Number(st.fast), base: Number(st.baseline),
      gap: Math.abs(Number(st.slow) - Number(st.baseline)),
      sawOwnFeel, ownText: own ? own.text : null, prevOwnText: prevOwn ? prevOwn.text : null,
    })
  }
  w.close && w.close()
  return { name, turns }
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) * (x - m)))) }

const oldArm = await runArm('旧', { feel: false, band: false })
const newArm = await runArm('新', { feel: true, band: true })

const rows = [oldArm, newArm].map((a) => ({
  arm: a.name,
  '慢情绪离水位 最大': +Math.max(...a.turns.map((t) => t.gap)).toFixed(3),
  '慢情绪离水位 平均': +mean(a.turns.map((t) => t.gap)).toFixed(3),
  '慢情绪 标准差': +sd(a.turns.map((t) => t.slow)).toFixed(3),
  '注入带「我上一句的感觉」': a.turns.filter((t) => t.sawOwnFeel).length + '/' + a.turns.length,
  '能读到上一轮的自己那话': a.turns.filter((t, i) => i > 0 && t.ownText).length,
}))
console.table(rows)

let pass = 0
let fail = 0
const check = (n, ok, d) => { if (ok) { pass++; console.log('PASS', n) } else { fail++; console.log('FAIL', n, d === undefined ? '' : JSON.stringify(d)) } }
check('旧口径：注入里从来没有「我上一句的感觉」', oldArm.turns.every((t) => !t.sawOwnFeel))
check('新口径：从第二轮起每轮都带得上', newArm.turns.slice(1).every((t) => t.sawOwnFeel))
check('新口径：读到的就是上一轮她写的那句（不串行）', newArm.turns.slice(1).every((t, i) => t.prevOwnText === SCRIPT[i].feel), newArm.turns.map((t) => t.prevOwnText))
const oldMax = Math.max(...oldArm.turns.map((t) => t.gap))
const newMax = Math.max(...newArm.turns.map((t) => t.gap))
// 两臂跑在不同的随机世界里，水位起点不同，跨臂比大小不稳；只断言新口径的上限，旧的数留在表里给人看
check('新口径：任一时刻都没被推离水位 0.3 以外', newMax <= 0.3025, { newMax })
check('新口径：始终没被推离水位 0.3 以外', Math.max(...newArm.turns.map((t) => t.gap)) <= 0.3025, Math.max(...newArm.turns.map((t) => t.gap)))
check('新口径：慢情绪不是常数（还在跟着事件走）', new Set(newArm.turns.map((t) => t.slow.toFixed(3))).size >= 4, newArm.turns.map((t) => t.slow))

console.log('')
console.log('通过 ' + pass + ' / ' + (pass + fail))
process.exit(fail ? 1 : 0)
