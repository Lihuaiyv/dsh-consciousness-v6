import fs from 'node:fs'
const edits = [
  ['index.js', 'surfaceLoopLine'],
  ['src/algo/emotion.js', 'EMPATHY_HOLD_GAIN'],
  ['src/features.js', 'readMutter'],
  ['src/modules/conversations.js', 'conversationKey'],
  ['src/modules/heartbeat.js', 'describeHeartbeat'],
  ['src/modules/lifeview.js', 'resolveLifeKey'],
  ['src/modules/llm_budget.js', 'deferExtractForDay'],
  ['src/modules/memory_source.js', 'sourceHint'],
  ['src/modules/quote_echo.js', 'quoteStats'],
  ['src/modules/rope.js', 'resetDaily'],
  ['src/modules/sangguan/draft.js', 'FOREGONE_KINDS'],
  ['src/modules/sangguan/meta.js', 'META_KEYS'],
  ['src/modules/sangguan/pledge.js', 'isPledgeClaim'],
  ['src/modules/self_residue.js', 'residueLine'],
  ['src/modules/timeparse.js', 'hasPastAnchor'],
  ['src/modules/worldview.js', 'resolveWorldKey'],
]
let changed = 0
for (const [f, name] of edits) {
  let s = fs.readFileSync(f, 'utf8')
  const before = s
  s = s.replace(new RegExp('export (function|const|let|class) ' + name + '\\b'), '$1 ' + name)
  if (s === before) { console.log('SKIP (not found):', f, name); continue }
  fs.writeFileSync(f, s, 'utf8')
  changed++
}
console.log('de-exported:', changed, '/', edits.length)
