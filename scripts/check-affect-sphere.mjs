// 验收（2026-11-19 改）：球面骨架——几何换算 + 球面查表 + secondaryDistribution 走球面
//
// 2026-11-19 变更：旧的 192 词球面表（`sphere_words.js`）已删，二级词表只认小库
// （`src/algo/lexicon_v4.js`，165 词）。球面口径现在只是**同一批词换一种距离**
// （角距离 + 半径差），不再换词表。
import { toSphere, angleBetween, familyOf, sphereScores, FAMILIES, LAYERS } from '../src/algo/sphere.js'
import { secondaryDistribution, SECONDARY_PROTOTYPES } from '../src/algo/affect_v4.js'

let passed = 0
function check(name, ok, detail) {
  if (!ok) { console.error('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); process.exit(1) }
  passed++
  console.log('ok', name)
}
const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) <= eps

const GRID = ['敞亮', '安住', '警醒', '疏淡', '渴慕', '郁结', '惊惧', '沉沦']

/* 1) 坐标 */
const calm = toSphere({ s: 0.5, n: 0.15, d: 0.5 })
check('平静：半径≈0、没有方向', near(calm.r, 0, 0.02) && calm.dir === null, calm)
const le = toSphere({ s: 1, n: 1, d: 1 })
check('极端（敞亮角）：半径=1、方向指向 +,+,+', near(le.r, 1, 0.001) && near(le.dir[0], 1 / Math.sqrt(3), 0.001) && near(le.dir[1], 1 / Math.sqrt(3), 0.001) && near(le.dir[2], 1 / Math.sqrt(3), 0.001), le)
check('半径分层：平静在 0 层、敞亮在 3 层', calm.rLayer === 0 && le.rLayer === 3, { calm: calm.rLayer, le: le.rLayer })
check('四个层半径按设计（0.15/0.40/0.65/0.90）', LAYERS.length === 4 && near(LAYERS[0], 0.15) && near(LAYERS[3], 0.90))

/* 2) 方向与族 */
check('两个正交方向夹角 90°', near(angleBetween([1, 0, 0], [0, 1, 0]), Math.PI / 2, 0.001))
check('同向夹角 0', near(angleBetween([0.6, 0.8, 0], [0.6, 0.8, 0]), 0, 0.001))
check('敞亮角属「敞亮」族', familyOf({ s: 1, n: 1, d: 1 }).zh === '敞亮', familyOf({ s: 1, n: 1, d: 1 }))
check('八族名字就是两字八格（旧的单字/族名一个不剩）',
  FAMILIES.map((f) => f.zh).sort().join() === GRID.slice().sort().join(), FAMILIES.map((f) => f.zh))
check('八族方向互成角（两两不同）', (() => {
  for (let i = 0; i < FAMILIES.length; i++) for (let j = i + 1; j < FAMILIES.length; j++) {
    const a = FAMILIES[i].dir, b = FAMILIES[j].dir
    const d = angleBetween(a.map((x) => x / Math.sqrt(3)), b.map((x) => x / Math.sqrt(3)))
    if (!(d > 0.4)) return false
  }
  return true
})())

/* 3) 球面查表：每个词站在自己的坐标上，自己就该是最近的（同坐标的词并列也算过） */
const selfChecks = []
for (const p of SECONDARY_PROTOTYPES) {
  const s2 = sphereScores(p, SECONDARY_PROTOTYPES)
  const mine = s2.get(p.name).score
  const min = Math.min(...[...s2.values()].map((v) => v.score))
  if (mine > min + 1e-9) selfChecks.push({ w: p.name, mine: +mine.toFixed(4), min: +min.toFixed(4) })
}
check('球面查表自洽：每个词在自己位置上是最近的（并列算过）', selfChecks.length === 0, selfChecks.slice(0, 6))
const sp = sphereScores({ s: 0.8, n: 0.5, d: 0.7 }, SECONDARY_PROTOTYPES)
check('分数都在 0~1', [...sp.values()].every((v) => v.score >= 0 && v.score <= 1))

/* 4) 二级分布走球面：同一批词、两种距离，都能出词、概率归一 */
const frame = { what: '被夸了', target: 'me', agency: 'other', expectation: 0.5 }
const cube = secondaryDistribution(frame, { position: { s: 0.8, n: 0.5, d: 0.7 }, limit: 5 })
const sph = secondaryDistribution(frame, { position: { s: 0.8, n: 0.5, d: 0.7 }, limit: 5, geo: 'sphere' })
check('球面口径能出 5 个词', sph.length === 5 && !!sph[0].name, sph.map((x) => x.name))
check('球面口径 top1 也是小库里的词', SECONDARY_PROTOTYPES.some((p) => p.name === sph[0].name), sph[0])
check('球面口径 top1 属于某个两字格', GRID.includes((SECONDARY_PROTOTYPES.find((p) => p.name === sph[0].name) || {}).oct), sph[0])
check('概率是全局占比（和 ≤ 1.01）', sph.reduce((a, b) => a + b.p, 0) <= 1.01)
check('球面口径已废（2026-11-20 起）：传 geo=sphere 不再换距离，结果跟不传完全一样',
  JSON.stringify(cube.map((x) => x.name)) === JSON.stringify(sph.map((x) => x.name)) &&
  cube.every((x, i) => Math.abs(x.p - sph[i].p) < 1e-9), { cube: cube.map((x) => x.name), sph: sph.map((x) => x.name) })

/* 5) 词表只认小库：每个词都带两字格名，八个格都有人 */
check('小库每个词都带两字格名', SECONDARY_PROTOTYPES.every((p) => GRID.includes(p.oct)),
  SECONDARY_PROTOTYPES.filter((p) => !GRID.includes(p.oct)).slice(0, 6))
// 2026-11-19：警醒格原来是空的（中库 2,284 里只有 2 个词，且都不在 Boson 常用词表里），
// 主人定「先把这两个词加进去」→ 手动补了彻悟、讶然。现在八格都该有词。
const counts = GRID.map((g) => [g, SECONDARY_PROTOTYPES.filter((p) => p.oct === g).length])
check('八个格都有词（警醒靠手补的彻悟、讶然撑着）', counts.every(([, n]) => n > 0), counts)
check('警醒格的词就是彻悟、讶然', SECONDARY_PROTOTYPES.filter((p) => p.oct === '警醒').map((p) => p.name).sort().join() === '彻悟,讶然',
  SECONDARY_PROTOTYPES.filter((p) => p.oct === '警醒').map((p) => p.name))
console.log('小库八格分布：' + counts.map(([g, n]) => `${g} ${n}`).join('  '))
check('小库没有格名当词（敞亮/安住… 不进二级）', !SECONDARY_PROTOTYPES.some((p) => GRID.includes(p.name)),
  SECONDARY_PROTOTYPES.filter((p) => GRID.includes(p.name)).map((p) => p.name))
console.log(`\n${passed} 项全过`)
