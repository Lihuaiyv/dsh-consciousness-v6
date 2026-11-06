import fs from 'node:fs'
const p = 'test/pair-judge.test.mjs'
let s = fs.readFileSync(p, 'utf8')
const subs = [
  ['用户咖啡偏好是冰美式', '用户咖啡偏好一直是冰美式，不加糖'],
  ['用户咖啡偏好改成手冲', '用户咖啡偏好现在改成手冲，不加糖'],
  ['用户提到想学游泳', '用户提到想学游泳，但一直没找到合适的班'],
  ['用户报了游泳班', '用户已经报了游泳班，下周三开始上课'],
  ['用户说特效要红色', '用户说特效要改成红色，再亮一点'],
  ['用户说特效先别改', '用户说特效先别改，等这版定下来再说'],
  ['用户喜欢猫', '用户喜欢猫，家里养了两只橘猫'],
  ['用户养了一只猫', '用户家里已经养了一只猫，叫年糕'],
  ['用户提过导出功能', '用户提过导出功能，但没说什么时候要'],
  ['用户说导出先不做', '用户说导出先不做，等前端稳定了再排'],
  ["check('模型判取代调了一次', calls === 1, calls)", "check('模型判取代调了两次（判 + 复核）', calls === 2, calls)"],
]
let n = 0
for (const [a, b] of subs) {
  if (!s.includes(a)) { console.error('MISS:', a); continue }
  s = s.split(a).join(b)
  n++
}
fs.writeFileSync(p, s, 'utf8')
console.log('substitutions applied:', n, '/', subs.length)
