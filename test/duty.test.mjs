/**
 * 相处状态 duty：被使唤的累积、衰减、被陪伴打断，以及它对慢情绪目标的压低。
 * 运行：node test/duty.test.mjs
 */
import { stepDuty, dutyBiasOf, DUTY_ADD, DUTY_TAU_H, DUTY_THRESHOLD, DUTY_BIAS, DUTY_RELIEF } from '../src/algo/emotion.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}
const close = (a, b, eps = 1e-3) => Math.abs(a - b) < eps

// ---- 一、累积 ----
let d = 0
for (let i = 0; i < 6; i++) d = stepDuty({ duty: d, kind: 'task' })
check('6 条任务按条累加', close(d, 6 * DUTY_ADD), { d })
check('一条刚好加 DUTY_ADD', close(stepDuty({ duty: 0, kind: 'task' }), DUTY_ADD), { one: stepDuty({ duty: 0, kind: 'task' }) })

let capped = 0
for (let i = 0; i < 300; i++) capped = stepDuty({ duty: capped, kind: 'directive' })
check('连 300 条封顶在 1', close(capped, 1), { capped })

check('directive 也算被使唤', close(stepDuty({ duty: 0, kind: 'directive' }), DUTY_ADD))
check('chat 不加', close(stepDuty({ duty: 0, kind: 'chat' }), 0), { d: stepDuty({ duty: 0, kind: 'chat' }) })
check('eval 不直接加（交给冲击）', close(stepDuty({ duty: 0, kind: 'eval' }), 0))

// ---- 二、衰减 ----
check('一个时间常数后剩约 37%', close(stepDuty({ duty: 1, dtHours: DUTY_TAU_H }), Math.exp(-1)), { d: stepDuty({ duty: 1, dtHours: DUTY_TAU_H }) })
check('五个时间常数后基本清零', stepDuty({ duty: 1, dtHours: 5 * DUTY_TAU_H }) < 0.01, { d: stepDuty({ duty: 1, dtHours: 5 * DUTY_TAU_H }) })
check('没时间流逝就不衰减', close(stepDuty({ duty: 0.4, dtHours: 0 }), 0.4))
check('τ 越大衰减越慢', stepDuty({ duty: 1, dtHours: 3, tauH: 9 }) > stepDuty({ duty: 1, dtHours: 3, tauH: 3 }))

// ---- 三、被陪伴打断 ----
const broken = stepDuty({ duty: 0.8, kind: 'chat' })
check('一句闲聊按 DUTY_RELIEF 打折', close(broken, 0.8 * DUTY_RELIEF), { broken })
check('relief 越小掉得越狠', stepDuty({ duty: 0.8, kind: 'chat', relief: 0.1 }) < stepDuty({ duty: 0.8, kind: 'chat', relief: 0.9 }))
check('relation 也能打断', close(stepDuty({ duty: 0.8, kind: 'relation' }), 0.8 * DUTY_RELIEF))
check('衰减 + 打断一起生效', close(stepDuty({ duty: 0.6, dtHours: DUTY_TAU_H, kind: 'chat' }), 0.6 * Math.exp(-1) * DUTY_RELIEF, 0.002))

// ---- 四、对慢情绪目标的压低 ----
check('duty 在阈值上不压', close(dutyBiasOf({ duty: DUTY_THRESHOLD }), 0), { b: dutyBiasOf({ duty: DUTY_THRESHOLD }) })
check('duty 0.6 按公式压', close(dutyBiasOf({ duty: 0.6 }), -(0.6 - DUTY_THRESHOLD) * DUTY_BIAS), { b: dutyBiasOf({ duty: 0.6 }) })
check('duty 满格压满', close(dutyBiasOf({ duty: 1 }), -(1 - DUTY_THRESHOLD) * DUTY_BIAS), { b: dutyBiasOf({ duty: 1 }) })
check('压低永远是负的', dutyBiasOf({ duty: 0.9 }) < 0)
check('duty 越界自动钳', close(dutyBiasOf({ duty: 2 }), dutyBiasOf({ duty: 1 })))

// ---- 五、坏输入 ----
check('NaN 不穿透', Number.isFinite(stepDuty({ duty: NaN, dtHours: NaN, kind: 'task' })) && Number.isFinite(dutyBiasOf({ duty: NaN })))
check('负 duty 当 0', close(stepDuty({ duty: -3, kind: 'task' }), DUTY_ADD))
check('负时间不倒退', close(stepDuty({ duty: 0.5, dtHours: -5 }), 0.5))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
