/**
 * 记忆来源与确定度：我自己看到的 / 从聊天里记下的 / 我自己想的。
 * 运行：node test/memory-provenance.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { memoryTag } from '../src/modules/memory_tag.js'
import { packInjection } from '../src/modules/pack.js'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import { retrieve } from '../src/modules/retrieve.js'
import { setParam } from '../src/kernel.js'
import { packMemoryBlock, consciousnessBlock } from '../index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const NOW = Date.parse('2026-11-03T12:00:00+08:00')
const DAY = 86400000
const row = (source, days = 3, confidence = 0.8, extra = {}) => ({
  text: '一条记忆。', source, confidence,
  created_at: new Date(NOW - days * DAY).toISOString(),
  ...extra,
})
const tag = (source, days, confidence, extra) => memoryTag(row(source, days, confidence, extra), NOW, { provenance: true })

// ---- 默认行为：不带 provenance 时逐字回旧版 ----
check('默认 extract 不加来源', memoryTag(row('extract', 3), NOW) === '（3 天前）', memoryTag(row('extract', 3), NOW))
check('默认 life 仍带自己看到的', memoryTag(row('life', 3), NOW) === '（我自己看到的，3 天前）', memoryTag(row('life', 3), NOW))

// ---- 三类非默认来源 ----
check('life → 我自己看到的', tag('life', 3).includes('我自己看到的'), tag('life', 3))
check('extract → 从聊天里记下的', tag('extract', 3).includes('从聊天里记下的'), tag('extract', 3))
check('episode → 从聊天里记下的', tag('episode', 3).includes('从聊天里记下的'), tag('episode', 3))
check('summary → 从聊天里记下的', tag('summary', 3).includes('从聊天里记下的'), tag('summary', 3))
check('consolidate → 我自己想的', tag('consolidate', 3).includes('我自己想的'), tag('consolidate', 3))
check('reflect → 我自己想的', tag('reflect', 3).includes('我自己想的'), tag('reflect', 3))
check('subtext → 我自己想的', tag('subtext', 3).includes('我自己想的'), tag('subtext', 3))

// ---- 默认来源不贴 ----
check('manual 不贴来源', tag('manual', 3) === '（3 天前）', tag('manual', 3))
check('chat 不贴来源', tag('chat', 3) === '（3 天前）', tag('chat', 3))
check('未知来源不贴', tag('mystery', 3) === '（3 天前）', tag('mystery', 3))

// ---- 低置信 ----
check('低置信推断带「不一定对」', tag('subtext', 3, 0.45).includes('不一定对'), tag('subtext', 3, 0.45))
check('低置信顺序在最后', tag('subtext', 30, 0.45) === '（我自己想的，1 个月前，有点糊，不一定对）', tag('subtext', 30, 0.45))
check('高置信不带「不一定对」', !tag('subtext', 3, 0.8).includes('不一定对'), tag('subtext', 3, 0.8))
check('默认来源即使低置信也不乱标', !tag('manual', 3, 0.3).includes('不一定对'), tag('manual', 3, 0.3))
check('confidence 缺失不误标', !tag('subtext', 3, null).includes('不一定对'), tag('subtext', 3, null))
check('无年龄的低置信也能标', tag('subtext', 0, 0.4).includes('不一定对'), tag('subtext', 0, 0.4))
check('age:false 时只留来源', memoryTag(row('extract', 3), NOW, { provenance: true, age: false }) === '（从聊天里记下的）', memoryTag(row('extract', 3), NOW, { provenance: true, age: false }))

// ---- 装箱接线 ----
{
  const items = [
    row('extract', 3, 0.5, { id: 'm1', partition: 'T1', text: '主人说过想去看海。' }),
    row('life', 3, 0.9, { id: 'm2', partition: 'T1', text: '我自己看到窗台的花开了。' }),
  ]
  const out = packInjection({ items }, { budget: 400, decorate: (it) => memoryTag(it, NOW, { provenance: true }) })
  check('装箱：转述记忆带来源', out.text.includes('从聊天里记下的') && out.text.includes('不一定对'), out.text)
  check('装箱：自己看到的记忆带来源', out.text.includes('我自己看到的'), out.text)
  const off = packInjection({ items }, { budget: 400, decorate: (it) => memoryTag(it, NOW) })
  check('装箱：关掉来源后只剩时间', !off.text.includes('从聊天里记下的') && off.text.includes('3 天前'), off.text)
}

// ---- 检索链路带出 source / confidence ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-prov-'))
  const db = openDb(path.join(dir, 'app.db'))
  attachDb(db)
  const aid = 'agt_prov'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, '来源', 'daily', 'active', new Date().toISOString())
  addMemory(db, aid, { text: '窗台那盆花该换位置了。', type: 'fact', source: 'extract', confidence: 0.5 })
  const r = retrieve(db, aid, '窗台 花', { k: 5 })
  const hit = r.items.find((x) => String(x.text).includes('窗台'))
  check('检索能拿回这条', !!hit, r.items)
  check('检索条目带 source', hit && hit.source === 'extract', hit)
  check('检索条目带 confidence', hit && Number(hit.confidence) === 0.5, hit)
  check('检索条目能贴出来源徽章', hit && memoryTag(hit, Date.now(), { provenance: true }).includes('从聊天里记下的'), hit)
  // 关掉时间标签，来源徽章仍要在：两个开关是独立的。
  setParam(db, aid, 'memory.inject.age', { value: 'off' })
  setParam(db, aid, 'memory.inject.provenance', { value: 'on' })
  const packed = packMemoryBlock(db, aid, [{ ...hit, text: '窗台那盆花该换位置了。', partition: 'T1' }], 400)
  check('关时间标签：来源仍在', packed.text.includes('从聊天里记下的'), packed.text)
  check('关时间标签：没有年龄', !packed.text.includes('天前') && !packed.text.includes('个月前'), packed.text)

  // QQ / 外部通道：opts.recall 的行对象也要同一套来源标签
  const qqAid = 'agt_qqprov'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(qqAid, 'QQ来源', 'daily', 'active', new Date().toISOString())
  const qqText = consciousnessBlock(db, qqAid, {
    recall: [{ text: '从聊天里记下：主人在改接线。', source: 'extract', confidence: 0.5, created_at: new Date().toISOString() }],
  })
  check('外部召回带来源', qqText.includes('从聊天里记下的'), qqText)
  check('外部召回低置信标不一定对', qqText.includes('不一定对'), qqText)
  db.close()
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
