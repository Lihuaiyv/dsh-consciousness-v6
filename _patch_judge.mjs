import fs from 'node:fs'
const p = 'src/modules/pair_judge.js'
let s = fs.readFileSync(p, 'utf8')
const rep = (from, to) => {
  if (!s.includes(from)) { console.error('NOT FOUND:', from.slice(0, 60)); process.exit(1) }
  s = s.replace(from, to)
}

// 1) 默认超时 3s → 6s（真数据 max 3004ms，擦线）
rep("const { db, aid, oldRow, newerRow, complete, timeoutMs = 3000, via = 'script', skipRules = false, useCache = true, uncertainDays = 7 } = opt",
    "const { db, aid, oldRow, newerRow, complete, timeoutMs = 6000, via = 'script', skipRules = false, useCache = true, uncertainDays = 7 } = opt")
rep('const { db, aid, day, complete, limit = 40, timeoutMs = 3000, minIntervalMs = 800, via = \'nightly\' } = opt',
    "const { db, aid, day, complete, limit = 40, timeoutMs = 6000, minIntervalMs = 800, via = 'nightly' } = opt")

// 2) 删「同 key 直判 supersede」
rep(`  // 同 fact_key 完全相等：槽位取值变了，规则就能定，不花模型。
  if (String(old.fact_key || '').trim() && String(old.fact_key) === String(newer.fact_key)) {
    return save({ verdict: 'supersede', reason: 'same-fact-key', model: 'rule', confidence: 0.95 })
  }
`, `  // 以前这里「同 fact_key 直接判 supersede」。真数据打脸：同 key 只说明是同一个槽，
  // 不说明值变了（「允许我决定怎么称呼他」vs「我更习惯被叫小汐」被硬判成取代，4/4 全错）。
  // 现在同 key 也只当候选，交给下面的模型判。
`)

// 3) 短文本跳过（放在规则闸之前）
rep(`  // 规则闸（专名撞车）`, `  // 太短的对没有上下文，模型也容易乱判（「嗯嗯很好了」被判成取代）。
  // 直接标 uncertain 并缓存：不值得花模型，7 天内也不再问。
  if (String(old.text || '').trim().length < 12 || String(newer.text || '').trim().length < 12) {
    return save({ verdict: 'uncertain', reason: 'too-short', model: 'rule', confidence: 0.3 })
  }

  // 规则闸（专名撞车）`)

// 4) supersede 二次复核
rep(`  const verdict = parseVerdict(raw)
`, `  const verdict = parseVerdict(raw)
  // supersede 是唯一会真改记忆的档：判一次不够，再问一次，两次一致才认。
  // 不一致 / 复核失败 → uncertain，不缓存（下次重判）。宁可不改，也不误改。
  if (verdict === 'supersede') {
    let raw2 = ''
    try { raw2 = await withTimeout(complete({ system: JUDGE_SYS, text: buildUser(old, newer) }), timeoutMs) }
    catch { return save({ verdict: 'uncertain', reason: 'verify-failed', model: 'host', confidence: 0.3 }) }
    if (parseVerdict(raw2) !== 'supersede') {
      return save({ verdict: 'uncertain', reason: 'supersede-unconfirmed', model: 'host', confidence: 0.3 })
    }
  }
`)
fs.writeFileSync(p, s, 'utf8')
console.log('pair_judge patched')

// 5) kernel 默认超时
const k = 'src/kernel.js'
let ks = fs.readFileSync(k, 'utf8')
if (!ks.includes("'memory.judge.timeout_ms': ['C4', 3000]")) { console.error('kernel anchor missing'); process.exit(1) }
ks = ks.replace("'memory.judge.timeout_ms': ['C4', 3000]", "'memory.judge.timeout_ms': ['C4', 6000]")
fs.writeFileSync(k, ks, 'utf8')
console.log('kernel patched')
