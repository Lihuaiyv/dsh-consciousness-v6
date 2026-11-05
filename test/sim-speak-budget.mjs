/**
 * 整体模拟：主动开口「一天里的典型序列」。
 * 运行：node test/sim-speak-budget.mjs
 *
 * 不是考卷判据，是给主人看行为的一条线：没话说 → 有缺口说一句 → 凑数被预算拦
 * → 欠账越预算 → 手动她 → 气头闭嘴。每一步只打印 will/reason。
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { decideSpeak, proactiveTriggerOf, setProactivePrefs, addProactiveSpend } from '../src/features.js'
import { addLoop } from '../src/modules/loops.js'
import { now } from '../src/db.js'

const w = makeWorld()
const out = []
try {
  setProactivePrefs(w.db, w.aid, { enabled: true, per_day: 4, idle_hours: 0, quiet: false })
  const step = (name, fn) => {
    const d = fn()
    out.push({ name, will: d.will ? '说' : '不说', reason: d.reason })
    return d
  }

  step('09:00 没事由也没缺口', () => decideSpeak(w.db, w.aid))

  // 造一个真的缺口（照 proactive-triggers 的造法）
  w.db.prepare(`INSERT INTO drive_state(agent_id,r,e,c,a,s,setpoint,band,last_eval_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(w.aid, 0.1, 0.1, 0.1, 0.1, 0.1,
    JSON.stringify({ R: 0.9, E: 0.9, C: 0.9, A: 0.9, S: 0.9 }), 'D2', now())
  step('09:15 有缺口、想说话', () => decideSpeak(w.db, w.aid))

  // 模拟「真说出去一句」：有真事，记 1 分
  addProactiveSpend(w.db, w.aid, 1)
  step('09:30 说满 1 分后再说', () => decideSpeak(w.db, w.aid))

  // 再说一句凑数的：记 2 分 → 日额度 2 满
  addProactiveSpend(w.db, w.aid, 2)
  step('09:45 又凑一句（记 2 分）', () => decideSpeak(w.db, w.aid))

  // 到期欠账：预算满了也一路绿灯
  addLoop(w.db, w.aid, { text: '提醒他交周报', due_at: new Date(Date.now() - 3600000).toISOString() })
  step('10:00 欠账到期（预算已满）', () => decideSpeak(w.db, w.aid, { trigger: proactiveTriggerOf(w.db, w.aid) }))

  // 手动叫她：预算满了也能说
  step('10:05 你手动叫她', () => decideSpeak(w.db, w.aid, { manual: true }))

  // 气头上：有事由也不说
  w.db.prepare("UPDATE affect_state SET primary_label='irritated', intensity=0.8 WHERE agent_id=?").run(w.aid)
  step('10:10 气头 0.8（有事由）', () => decideSpeak(w.db, w.aid, { trigger: proactiveTriggerOf(w.db, w.aid) }))

  console.log('一天里的典型序列：')
  for (const s of out) console.log(' ' + s.name.padEnd(24, ' ') + ' → ' + s.will + '（' + s.reason + '）')
  const spend = w.db.prepare("SELECT value FROM flags WHERE key=?").get('proactive.spend:' + w.aid)
  console.log('\n今天的额度账：' + (spend ? spend.value : '（没记）'))
} finally { w.close() }
