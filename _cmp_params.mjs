import fs from 'node:fs'
const get = (p) => {
  const t = fs.readFileSync(p, 'utf8')
  const out = {}
  for (const line of t.split('\n')) {
    const m = line.match(/^\s*'([\w.]+)':\s*\[\s*'?([^',]+)'?\s*,/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}
const a = get('_bak_kernel_v2/kernel.corrupt.js')
const b = get('src/kernel.js')
const ka = Object.keys(a), kb = Object.keys(b)
const onlyA = ka.filter((k) => !(k in b))
const onlyB = kb.filter((k) => !(k in a))
const diff = ka.filter((k) => k in b && a[k] !== b[k])
console.log('corrupt params', ka.length, 'v7 params', kb.length)
console.log('only corrupt', onlyA)
console.log('only v7', onlyB)
console.log('value diff', diff.map((k) => k + ': ' + a[k] + ' -> ' + b[k]))
