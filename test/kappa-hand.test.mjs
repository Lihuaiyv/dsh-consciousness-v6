import { makeWorld } from './eval-persona/setup.mjs'
import { claimUserValue } from '../src/modules/sangguan/values_intake.js'
import { lexicalSim } from '../src/modules/sangguan/sim.js'

let pass = 0, fail = 0
const check = (name, ok, detail) => { if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, JSON.stringify(detail).slice(0, 300)) } }

const A = '我想说真的，不想靠挑一句好听的来换你信。'
const B = '我更想被你相信，哪怕得挑一句好听的。'
console.log('sim(A,B) =', lexicalSim(A, B).toFixed(3))

const w = makeWorld()
try {
  const ra = claimUserValue(w.db, w.aid, { key: A })
  const rb = claimUserValue(w.db, w.aid, { key: B })
  check('A 写进去了', ra.claimed === true, ra)
  check('B 写进去了', rb.claimed === true, rb)
  const cands = w.db.prepare("SELECT payload_json FROM claim_events WHERE type='KAPPA_CANDIDATE'").all()
  check('产生了 KAPPA_CANDIDATE', cands.length >= 1, cands)
  const pair = cands[0] ? JSON.parse(cands[0].payload_json) : null
  check('候选就是 A/B 这一对', pair && [pair.a_id, pair.b_id].sort().join('|') === [ra.claim_id, rb.claim_id].sort().join('|'), pair)
  // 再写一次同样的 B：不该重复提候选
  const rb2 = claimUserValue(w.db, w.aid, { key: B })
  const after = w.db.prepare("SELECT count(*) n FROM claim_events WHERE type='KAPPA_CANDIDATE'").get().n
  check('重复写不重复提候选', after === cands.length, { before: cands.length, after })
} finally { w.close() }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
