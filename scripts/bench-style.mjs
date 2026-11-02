/**
 * 说话质感的前后对照（P5）。
 *
 *   node scripts/bench-style.mjs
 *
 * 走真实的 consciousnessBlock，只改两个开关：
 *   before = style.mode 强制 work（等于不加任何文体约束）+ 示例全量（改造前的行为）
 *   after  = 闲聊模式，按表达档挑例子、加「这一轮怎么写」和文体清单
 *
 * 量的是注入层，不是模型输出——模型怎么回，得靠真实对话攒样本（scripts/style-stats.mjs）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { addMemory } from '../src/modules/memory.js'
import { seedTiers } from '../src/modules/relations.js'
import { writeParam } from '../src/kernel.js'
import { consciousnessBlock, recentRecall } from '../index.js'
import { examplesBlock, DEFAULT_EXAMPLES } from '../src/modules/examples.js'

const now = () => new Date().toISOString()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-style-bench-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_style'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '小汐', 'chat', 'active', now())
seedTiers(db)
for (const [p, v] of [['style.tone', '可爱粘人'], ['style.address', '主人'], ['axis.ei', 0.35]]) {
  db.prepare('INSERT INTO persona(agent_id,path,value,updated_at) VALUES(?,?,?,?)').run(aid, p, JSON.stringify(v), now())
}
db.prepare(`INSERT INTO affect_state(agent_id,primary_label,secondary_label,intensity,mood,pleasure,arousal,dominance,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?)`).run(aid, 'joy', null, 0.4, 0.7, 0.3, 0.3, 0.1, now())
db.prepare('INSERT INTO affect_v3(agent_id,baseline,slow,fast,total,slow_at,fast_at) VALUES(?,?,?,?,?,?,?)')
  .run(aid, 0.1, 0.4, 0.1, 0.3, now(), now())
db.prepare(`INSERT INTO rel_person(id,agent_id,name,tier,closeness,trust,dependence,salience,status,
  first_seen_at,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('rp_style', aid, '主人', 'owner', 0.92, 0.72, 0.24, 1, 'active', now(), now(), now(), now())
addMemory(db, aid, { text: '主人喜欢先给结论再解释。', type: 'fact' })
addMemory(db, aid, { text: '主人说过想去看海。', type: 'fact' })
recentRecall.set(aid, { at: Date.now(), q: 'x', text: '- （3 天前）主人喜欢先给结论再解释\n- （今天刚发生）主人说过想去看海' })

const setSlow = (v) => db.prepare('UPDATE affect_v3 SET slow=? WHERE agent_id=?').run(v, aid)

function run({ level, slow, mode, examples }) {
  setSlow(slow)
  writeParam(db, aid, 'style.mode', mode)
  writeParam(db, aid, 'memory.inject.examples', examples === 'off' ? 'off' : 'on')
  recentRecall.set(aid, { at: Date.now(), q: 'x', text: '- （3 天前）主人喜欢先给结论再解释\n- （今天刚发生）主人说过想去看海' })
  const block = consciousnessBlock(db, aid)
  return {
    level,
    mode,
    tokens: Math.ceil(block.length / 2),
    exampleLines: (block.match(/^- 主人：/gm) || []).length,
    styleLine: block.includes('我想怎么说'),
    guard: block.includes('不要列点'),
    chars: Array.from(block).length,
  }
}

const rows = [
  run({ level: 'quiet', slow: -0.6, mode: 'work' }),
  run({ level: 'quiet', slow: -0.6, mode: 'chat' }),
  run({ level: 'warm', slow: 0.5, mode: 'work' }),
  run({ level: 'warm', slow: 0.5, mode: 'chat' }),
]

console.log(JSON.stringify(rows, null, 2))
console.log('\n| 档位 | 模式 | 示例条数 | 有表达卡 | 有文体清单 | tokens |')
console.log('|---|---|---|---|---|---|')
for (const r of rows) {
  console.log(`| ${r.level} | ${r.mode} | ${r.exampleLines} | ${r.styleLine ? '是' : '否'} | ${r.guard ? '是' : '否'} | ${r.tokens} |`)
}

// 示例本身的开销：旧行为固定 8 条，现在按档取
const exChars = (lv) => Array.from(examplesBlock(null, { level: lv })).length
const oldChars = Array.from(examplesBlock(DEFAULT_EXAMPLES, {})).length
console.log('\n示例段字符数：旧（固定 8 条）=' + oldChars
  + ' · quiet=' + exChars('quiet') + ' · brief=' + exChars('brief')
  + ' · normal=' + exChars('normal') + ' · warm=' + exChars('warm'))

db.close()
