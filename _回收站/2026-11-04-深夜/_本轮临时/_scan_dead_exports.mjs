import fs from 'node:fs'
import path from 'node:path'
const root = process.cwd()
const files = []
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('_') || e.name === 'node_modules') continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|mjs)$/.test(e.name)) files.push(p) } }
walk(path.join(root, 'src')); walk(path.join(root, 'scripts')); walk(path.join(root, 'test')); files.push(path.join(root, 'index.js'))
const texts = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]))
const names = ['surfaceLoopLine','EMPATHY_HOLD_GAIN','readMutter','recordProactiveDecision','conversationKey','describeHeartbeat','resolveLifeKey','deferExtractForDay','sourceHint','quoteStats','resetDaily','isCleaned','FOREGONE_KINDS','META_KEYS','isPledgeClaim','valueTensions','residueLine','hasPastAnchor','resolveWorldKey']
for (const n of names) {
  const hits = []
  for (const [f, t] of texts) { const c = (t.match(new RegExp('\\b' + n + '\\b', 'g')) || []).length; if (c) hits.push(path.relative(root, f) + ':' + c) }
  console.log(n.padEnd(24), hits.join('  '))
}
