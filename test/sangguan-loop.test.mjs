/**
 * 三观环走通：取舍跨两天才能入库，入库之后 live 才说进话里。
 * 工程句套上「我看重」也不入账。不调用模型。
 *
 * 运行：node test/sangguan-loop.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { fieldCheck } from '../src/modules/sangguan/gates.js'
import { gatesOf, commitDraft } from '../src/modules/sangguan/draft.js'
import { listHeads } from '../src/modules/sangguan/projection.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { promptHook } from '../src/modules/sangguan/inject.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dressed = { layer: 'V', kind: 'norm', text: '我更看重先把测试跑完再上服务器' }
check('套了表态的工程句进不了账', fieldCheck(dressed) === 'not_stance', fieldCheck(dressed))

const cluster = {
  items: [
    { at: '2026-11-01T01:00:00.000Z', foregone: '被喜欢', alt: '先答应下来', trigger: '没核对就应了' },
    { at: '2026-11-03T01:00:00.000Z', foregone: '被喜欢', alt: '先答应下来', trigger: '又一次先答应' },
  ],
}
const draft = {
  text: '宁可慢一点，也不把没核对的话送出去',
  alt: '先答应下来',
  foregone: '被喜欢',
  exclusion: '没核对过的承诺',
  boundary: ['当场要个数字的时候可以先给范围'],
}
draft.gates = gatesOf(draft, cluster)
check('跨两天的取舍，五道闸过', draft.gates.pass === true, draft.gates)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sgloop-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sgloop'
db.prepare('INSERT INTO agents(id,name,created_at) VALUES(?,?,?)').run(aid, 'loop', '2026-11-09T00:00:00.000Z')

let noHuman = null
try { commitDraft(db, aid, draft, { human: false, at: '2026-11-09T05:00:00.000Z' }) } catch (e) { noHuman = e }
check('没人批，不入库', !!(noHuman && /人批过/.test(noHuman.message)), noHuman && noHuman.message)
check('没人批的时候链头是空的', listHeads(db, aid, 'V').length === 0)

commitDraft(db, aid, draft, { human: true, at: '2026-11-09T05:00:00.000Z' })
const heads = listHeads(db, aid, 'V')
check('人批过，链头上有这句', heads.some((h) => h.text === draft.text && h.status === 'active'), heads)

const legacy = { worldLine: '旧的世界', lifeLine: '旧的人生', valLine: '旧的价值', extra: [] }
setSangguanConfig(db, aid, { enabled: true, inject: 'shadow' })
const shadowed = promptHook(db, aid, legacy, { now: '2026-11-09T06:00:00.000Z' })
check('影子期话里还是旧的那句', shadowed.valLine === '旧的价值', shadowed)

setSangguanConfig(db, aid, { enabled: true, inject: 'live' })
const lived = promptHook(db, aid, legacy, { now: '2026-11-09T06:00:00.000Z' })
check('切到真注入，话里换成这句取舍', typeof lived.valLine === 'string' && lived.valLine.includes('宁可慢一点'), lived)

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
