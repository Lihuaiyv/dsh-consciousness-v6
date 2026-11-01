/**
 * 星图布局回归：任何两种人数组合下，节点之间、名字之间、名字与节点之间都不许重叠。
 * 直接从 client.js 里取出 layoutPersonMap / seatPersonLabels 跑，断言的是真实排版函数。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

function grab(name) {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('没找到 ' + name)
  let i = src.indexOf('{', start), depth = 0, end = -1
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  return src.slice(start, end)
}

const ctx = { console }
vm.createContext(ctx)
const api = vm.runInContext(grab('layoutPersonMap') + '\n' + grab('seatPersonLabels')
  + '\n;({ layoutPersonMap, seatPersonLabels })', ctx)

const W = 480, H = 400, cx = W / 2, cy = H / 2
const RING = { owner: 62, acquaintance: 118, stranger: 164 }
const NODE_R = { owner: 12, acquaintance: 9.5, stranger: 8 }

function personsOf(nOwner, nAcq, nStr) {
  const out = []
  for (let i = 0; i < nOwner; i++) out.push({ id: 'o' + i, name: '主人', tier: 'owner' })
  for (let i = 0; i < nAcq; i++) out.push({ id: 'a' + i, name: '熟人' + i, tier: 'acquaintance' })
  for (let i = 0; i < nStr; i++) out.push({ id: 's' + i, name: '生人' + i, tier: 'stranger' })
  return out
}

const boxOf = (n) => {
  const w = Math.max(18, Array.from(n.label.text).length * 10.5)
  const left = n.label.anchor === 'start' ? n.label.x : n.label.anchor === 'end' ? n.label.x - w : n.label.x - w / 2
  return { l: left, r: left + w, t: n.label.y - 10, b: n.label.y + 3 }
}

let bad = 0
for (const [no, na, ns] of [[1, 0, 0], [1, 1, 0], [1, 3, 5], [1, 4, 9], [1, 6, 10], [1, 8, 12], [1, 12, 12], [1, 2, 14]]) {
  const nodes = api.seatPersonLabels(
    api.layoutPersonMap(personsOf(no, na, ns), { W, H, cx, cy, RING, NODE_R }), { W, H, cx, cy })
  let minGap = Infinity
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      const d = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y) - nodes[a].r - nodes[b].r
      if (d < minGap) minGap = d
    }
  }
  const outside = [], hitsNode = [], hitsLabel = []
  const shown = nodes.filter((n) => n.label.shown)
  for (const n of shown) {
    const box = boxOf(n)
    if (box.l < 2 || box.r > W - 2 || box.t < 2 || box.b > H - 2) outside.push(n.id)
    for (const m of nodes) {
      if (m === n) continue
      const nx = Math.max(box.l, Math.min(box.r, m.x))
      const ny = Math.max(box.t, Math.min(box.b, m.y))
      if (Math.hypot(nx - m.x, ny - m.y) < m.r) hitsNode.push(n.id + '->' + m.id)
    }
  }
  for (let a = 0; a < shown.length; a++) {
    for (let b = a + 1; b < shown.length; b++) {
      const A = boxOf(shown[a]), B = boxOf(shown[b])
      if (!(A.r < B.l || A.l > B.r || A.b < B.t || A.t > B.b)) hitsLabel.push(shown[a].id + '/' + shown[b].id)
    }
  }
  const flag = minGap < 8 || outside.length || hitsNode.length || hitsLabel.length
  if (flag) bad++
  console.log(
    (flag ? 'BAD ' : 'ok  ') + `${no}/${na}/${ns}`.padEnd(9),
    '最小间隙=' + minGap.toFixed(1).padStart(6),
    '名字=' + shown.length + '/' + nodes.length,
    '出界=' + outside.length,
    '压点=' + hitsNode.length,
    '压名字=' + hitsLabel.length,
    [outside, hitsNode, hitsLabel].flat().length ? JSON.stringify([outside, hitsNode, hitsLabel]) : '',
  )
}
console.log(bad ? '布局还有冲突' : '布局：所有场景都没有互相挡住')
process.exit(bad ? 1 : 0)
