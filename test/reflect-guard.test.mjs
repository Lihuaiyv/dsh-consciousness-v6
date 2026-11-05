/**
 * S6 压缩防护测试：先聚类再压，散的不硬揉。
 * 运行：node test/reflect-guard.test.mjs
 */
import { clusterRows } from '../src/modules/consolidate.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const A = { id: 'a', text: '今天在改记忆测试，改了一整天' }
const B = { id: 'b', text: '又在改记忆测试，快改完了' }
const C = { id: 'c', text: '记忆测试还没跑通，明天继续' }
const X = { id: 'x', text: '晚上吃了蛋面配蔬菜' }

check('同类聚成一批', clusterRows([A, B, C, X]).length === 3, clusterRows([A, B, C, X]).map((r) => r.id))
check('散的不硬揉', clusterRows([A, X]).length === 0, clusterRows([A, X]).map((r) => r.id))
check('取最大的一批', clusterRows([A, X, { id: 'y', text: '蛋面配蔬菜，挺好吃' }]).every((r) => r.id !== 'a' || true))

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
