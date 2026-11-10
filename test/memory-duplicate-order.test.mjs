/**
 * 重复 vs 矛盾：谁先判（11-10）。
 *
 * 以前 `sim ≥ 0.9 → duplicate` 直接 return，把「只差一个『不』」的对立句合并掉，
 * 连冲突都不会记。现在先找极性相反的那条；只有「重复的那条不是同一对矛盾」时才合并。
 *
 * 运行：node test/memory-duplicate-order.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addMemory } from '../src/modules/memory.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const put = (w, text, extra = {}) => addMemory(w.db, w.aid, { text, type: 'fact', source: 'test', ...extra })

// ---- 1. 近似对立：只差一个「不」，相似度很高 —— 也该算矛盾，不能合并
{
  const w = makeWorld()
  try {
    put(w, '用户的生日是十月三日')
    const b = put(w, '用户的生日不是十月三日')
    check('近似对立不再被当重复', b.duplicate !== true && b.conflict === true, b)
  } finally { w.close() }
}

// ---- 2. 一模一样的句子：还是合并
{
  const w = makeWorld()
  try {
    const a = put(w, '用户喜欢喝美式咖啡，不加糖')
    const b = put(w, '用户喜欢喝美式咖啡，不加糖')
    check('同一句仍然合并', b.duplicate === true && b.id === a.id, b)
  } finally { w.close() }
}

// ---- 3. 同极性、只是换了说法：还是合并
{
  const w = makeWorld()
  try {
    put(w, '用户喜欢喝美式咖啡，不加糖')
    const b = put(w, '用户喜欢喝美式咖啡，不加糖。')
    check('同极性近义句仍然合并', b.duplicate === true, b)
  } finally { w.close() }
}

// ---- 4. 中等相似度的对立：照旧判矛盾
{
  const w = makeWorld()
  try {
    put(w, '用户的生日是十月三日')
    const b = put(w, '用户的生日不是十月三日吧')
    check('中等相似度的对立照旧判矛盾', b.conflict === true, b)
  } finally { w.close() }
}

// ---- 5. 跟一条几乎一样、同时跟另一条对立：合并优先（最近的那条才算「同一句」）
{
  const w = makeWorld()
  try {
    put(w, '用户的生日是十月三日')
    put(w, '用户不吃辣')
    const b = put(w, '用户的生日是十月三日')
    check('跟一条重复、跟另一条无关时：合并', b.duplicate === true, b)
  } finally { w.close() }
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
