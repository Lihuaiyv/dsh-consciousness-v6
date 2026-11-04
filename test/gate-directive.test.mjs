/**
 * directive（第五档）：在使唤 / 纠正 / 催它的时候，闸门要认得。
 * 运行：node test/gate-directive.test.mjs
 */
import { significanceOf, gateOf, socialFloorOf, GATE } from '../src/algo/gate.js'
import { finalizeAppraisal } from '../src/model.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

// ---- 一、分类落地 ----
const dir = finalizeAppraisal({ kind: 'directive', polarity: -0.5, novelty: 0.2, certainty: 0.8 })
check('directive 不算「没事」', dir.none === false, dir)
check('directive 的关切度落在 0.4', close(dir.goal_relevance, 0.4), { rel: dir.goal_relevance })
check('directive 的方向跟着 polarity（负）', dir.goal_congruence < 0, { cong: dir.goal_congruence })

const task = finalizeAppraisal({ kind: 'task', novelty: 0.2, certainty: 0.8 })
check('task 仍然算「没事」', task.none === true, task)
check('task 的关切度不超过 0.15', task.goal_relevance <= 0.15, { rel: task.goal_relevance })
check('task 的一致性归零', close(task.goal_congruence, 0), { cong: task.goal_congruence })

const ev = finalizeAppraisal({ kind: 'eval', polarity: -0.6, novelty: 0.3, certainty: 0.7 })
check('eval 还是最高的关切档', ev.goal_relevance >= 0.65 - 1e-9, { rel: ev.goal_relevance })

// ---- 二、文本兜底 ----
const s1 = socialFloorOf('还是不对')
check('「还是不对」认得成 directive', s1 && s1.level === 'directive', s1)
check('文本兜底的关切度 0.4', s1 && close(s1.rel, 0.4), s1)
const s2 = socialFloorOf('把这段改成蓝色')
check('纯指令不触发兜底', s2 === null, s2)
const s3 = socialFloorOf('快点')
check('「快点」认得成 directive', s3 && s3.level === 'directive', s3)
const s4 = socialFloorOf('好了')
check('「好了」不触发兜底', s4 === null, s4)

// ---- 三、真的能过闸 ----
const sigDir = significanceOf({ rel: 0.4, cong: -0.35, nov: 0.2, cert: 0.8, prevCong: 0 })
const sigTask = significanceOf({ rel: 0.1, cong: 0, nov: 0.2, cert: 0.8, prevCong: 0 })
const sigEval = significanceOf({ rel: 0.65, cong: -0.5, nov: 0.3, cert: 0.7, prevCong: 0 })
check('directive 能过闸（被催一下够格）', gateOf(sigDir.sig, GATE.theta), { sig: sigDir.sig, theta: GATE.theta })
check('task 还是过不去（干活不是情绪）', !gateOf(sigTask.sig, GATE.theta), { sig: sigTask.sig, theta: GATE.theta })
check('eval 当然过闸', gateOf(sigEval.sig, GATE.theta), { sig: sigEval.sig })
check('directive 比 task 显著得多', sigDir.sig > sigTask.sig * 2, { dir: sigDir.sig, task: sigTask.sig })

// ---- 四、变化项真的活了（E10 不再污染） ----
const changed = significanceOf({ rel: 0.4, cong: -0.35, nov: 0.2, cert: 0.8, prevCong: 0 })
const same = significanceOf({ rel: 0.4, cong: 0, nov: 0.2, cert: 0.8, prevCong: 0 })
check('「变糟了」比「没变」显著', changed.sig > same.sig, { changed: changed.sig, same: same.sig })
check('change 取到了真实差值', close(changed.change, 0.35, 1e-6), { change: changed.change })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
