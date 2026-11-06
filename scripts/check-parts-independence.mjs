// 独立性的界桩：一个零件换的时候，只该动它自己 files 里的文件，只写它自己的表。
// 运行：node scripts/check-parts-independence.mjs
//
// 查四条（对应术语表「零件 = 一段能单独拎出来的实现」+ 计划的三条粘连底线）：
//   1. 零件文件里不许有宿主装配（index.js / features.js / client.js / api.js / db.js）：
//      它们是接线，不是板子；换零件时改那一行接线，不算零件。
//   2. 零件之间不许共用实现文件：同一个文件出现在两个零件的 files 里，就是一块板子两个人踩。
//   3. 零件文件必须在 ownership 名单里：界桩扫不到它，写权就没人管。
//   4. 零件文件里的 SQL 写，必须被自己域的 WRITES 允许；表被别的域声明写也算红。
//
// 输出：每个零件一行结论 + 红/黄明细。红 = 独立性破了；黄 = 现在不破，但顺手能补。
// 这一版先不接进 check:arch：等它全绿再加进 CI，别让老账把整条门禁卡红。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PARTS } from '../src/modules/parts.js'
import { OWNERSHIP, WRITES, SHARED, tablesForFile, MAINTENANCE } from '../src/ports/ownership.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WRITE_RE = /\b(?:INSERT(?:\s+OR\s+REPLACE)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|DROP\s+TABLE)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi
const SKIP = new Set(['select', 'set', 'values', 'where', 'and', 'or', 'on', 'as'])

/** 宿主装配：接线和页面，不属于任何零件。零件 files 里出现它们就是登记错了。 */
const HOST_SHELLS = new Set([
  'index.js', 'client.js', 'src/features.js', 'src/api.js', 'src/db.js', 'src/kernel.js',
])

/** 每张表被哪些业务域声明了写（搬库域不算） */
const declaredBy = new Map()
for (const [mod, list] of Object.entries(WRITES)) {
  if (MAINTENANCE.includes(mod)) continue
  for (const t of list) {
    if (!declaredBy.has(t)) declaredBy.set(t, [])
    declaredBy.get(t).push(mod)
  }
}

/** 文件 → 零件们（查共用）。按登记时写的原样比，'index.js' 和 'src/index.js' 不是同一个文件。 */
const fileToParts = new Map()
for (const p of PARTS) {
  for (const f of p.files || []) {
    const raw = String(f).replace(/\\/g, '/')
    if (!fileToParts.has(raw)) fileToParts.set(raw, [])
    fileToParts.get(raw).push(p.id)
  }
}

const tracked = new Set()
for (const spec of Object.values(OWNERSHIP)) {
  for (const f of spec.files) tracked.add(String(f).replace(/\\/g, '/'))
}

let red = 0
let yellow = 0
let clean = 0

for (const p of PARTS) {
  const lines = []
  const raw = (p.files || []).map((f) => String(f).replace(/\\/g, '/'))

  // 1. 宿主装配不算零件文件
  for (const f of raw) {
    if (!HOST_SHELLS.has(f)) continue
    red++
    lines.push('红  ' + f + ' 是宿主装配，不该进零件 files（接线只写在 entry 里）')
  }

  // 2. 共用实现文件
  for (const f of raw) {
    if (HOST_SHELLS.has(f)) continue
    const owners = fileToParts.get(f) || []
    if (owners.length > 1) {
      red++
      lines.push('红  共用实现文件 ' + f + '：' + owners.join('、') + ' 都列了它')
    }
  }

  for (const f of raw) {
    if (HOST_SHELLS.has(f)) continue
    const abs = path.join(root, f)
    if (!fs.existsSync(abs)) {
      red++
      lines.push('红  ' + f + ' 不存在（登记了假文件）')
      continue
    }

    // 3. 在不在 ownership 名单里（名单里的路径相对 src/）
    const r = f.replace(/^src\//, '')
    const info = tracked.has(r) ? tablesForFile(r) : null
    if (!info) {
      red++
      lines.push('红  ' + f + ' 不在 ownership 名单里：check-ownership / dep-graph 都扫不到它')
      continue
    }

    // 4. 写权：文件写的表，得是自己域声明过的
    const text = fs.readFileSync(abs, 'utf8')
    const wrote = new Set()
    for (const m of text.matchAll(WRITE_RE)) {
      const t = m[1].toLowerCase()
      if (!SKIP.has(t)) wrote.add(t)
    }
    for (const t of wrote) {
      if (SHARED.includes(t)) continue
      const owners = declaredBy.get(t) || []
      const mine = info.writes || null
      if (!mine) {
        yellow++
        lines.push('黄  ' + f + ' 写 ' + t + '：域 ' + info.module + ' 没分读写，写权没声明')
      } else if (!mine.includes(t)) {
        red++
        lines.push('红  ' + f + ' 写 ' + t + '：域 ' + info.module + ' 的写权里没有它' +
          (owners.length ? '（声明写手：' + owners.join('、') + '）' : '（没有域声明写这张表）'))
      }
    }
  }

  const verdict = lines.some((l) => l.startsWith('红')) ? '不独立' : (lines.length ? '独立（有黄）' : '独立')
  if (verdict !== '不独立') clean++
  console.log('\n' + p.id + '（' + p.name + '）：' + verdict)
  for (const l of lines) console.log('  ' + l)
}

console.log('\n零件独立性：' + clean + '/' + PARTS.length + ' 件没有红；红 ' + red + ' 条，黄 ' + yellow + ' 条')
if (red) process.exitCode = 1
