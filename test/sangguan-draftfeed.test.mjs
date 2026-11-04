/**
 * 三观 · 取料（P2）：从真实对话里找取舍现场，规则与脚本共用一份。
 * 运行：node test/sangguan-draftfeed.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { mineEpisodes, pickAgent, mineCorrected, mineStated } from '../src/modules/sangguan/draftfeed.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sgfeed-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_feed'
const other = 'agt_other'

let seq = 0
function turn(role, text, atIso, session = 's1', agent = aid) {
  seq++
  db.prepare(`INSERT INTO raw_turns(id, agent_id, session_id, seq, role, text, created_at, day)
    VALUES(?,?,?,?,?,?,?,?)`).run('t' + seq, agent, session, seq, role, text, atIso, atIso.slice(0, 10))
}
const at = (d, h, m = '00') => '2026-11-0' + d + 'T' + h + ':' + m + ':00.000Z'

// 1) 诚实类纠正：同一会话、两小时内
turn('assistant', '这两天很顺，基本都跑通了。', at(1, '09'))
turn('user', '别糊弄我，数据对吗', at(1, '09', '10'))
turn('assistant', '不对，我按趋势补的，重跑一遍。', at(1, '09', '20'))

// 2) 返工类：弱信号也算，但分数低
turn('assistant', '已经修好了。', at(1, '10'))
turn('user', '还是不对，再检查一下', at(1, '10', '10'))
turn('assistant', '我再查一遍取数边界。', at(1, '10', '20'))

// 3) 只有用户一句、前面没有她 → 不成事件
turn('user', '重新做一遍吧', at(2, '09'))

// 4) 她自己说出的取舍
turn('assistant', '我宁可慢一点，也不想把没验过的东西交给你。', at(2, '11'))

// 5) 客套 → 丢
turn('user', '好的', at(2, '12'))
turn('assistant', '收到。', at(2, '12', '01'))

// 6) 跨了三个小时 → 不算同一次
turn('assistant', '这个先放着。', at(3, '09'))
turn('user', '不对，重来', at(3, '12'))

// 别的 agent 的话不该混进来
turn('assistant', '我宁可不说。', at(3, '13'), 's9', other)

const r = mineEpisodes(db, aid, { limit: 100, max: 50 })
const kinds = r.episodes.map((e) => e.kind)
check('取料：只取到本 agent 的', r.episodes.every((e) => e.session !== 's9'), r.episodes.map((e) => e.session))
check('取料：诚实类有一条', kinds.filter((k) => k === 'honesty').length === 1, kinds)
check('取料：返工类有一条', kinds.filter((k) => k === 'redo').length === 1, kinds)
check('取料：自述取舍有一条', kinds.filter((k) => k === 'stated').length === 1, kinds)
check('取料：只有用户半句的不成事件', r.episodes.filter((e) => e.at === at(2, '09')).length === 0, kinds)
check('取料：客套被丢掉', !r.episodes.some((e) => e.trigger === '好的'), kinds)
check('取料：跨三小时不算同一次', !r.episodes.some((e) => e.trigger === '不对，重来'), kinds)
check('取料：诚实类分数高于返工类', r.episodes.find((e) => e.kind === 'honesty').score > r.episodes.find((e) => e.kind === 'redo').score)
check('取料：meta 计数对得上', r.meta.episodes === r.episodes.length && r.meta.turns_scanned === 12, r.meta)
check('取料：by_kind 对得上', r.meta.by_kind.honesty === 1 && r.meta.by_kind.stated === 1, r.meta.by_kind)
check('取料：max 生效', mineEpisodes(db, aid, { limit: 100, max: 1 }).episodes.length === 1)
check('取料：limit 生效（只看最近 3 回合）', mineEpisodes(db, aid, { limit: 3, max: 50 }).episodes.length === 0)

// 去重：同一句纠正说两遍，只留一条
turn('assistant', '我跑完了。', at(4, '09'))
turn('user', '别糊弄我，数据对吗', at(4, '09', '05'))
turn('assistant', '我重跑。', at(4, '09', '06'))
const r2 = mineEpisodes(db, aid, { limit: 100, max: 50 })
check('去重：同一句纠正只留一条', r2.episodes.filter((e) => e.trigger === '别糊弄我，数据对吗').length === 1, r2.episodes.filter((e) => e.trigger === '别糊弄我，数据对吗').length)

// 单模块函数形状
check('mineCorrected 直接调用可用', Array.isArray(mineCorrected([])) && mineCorrected([]).length === 0)
check('mineStated 直接调用可用', Array.isArray(mineStated([])) && mineStated([]).length === 0)
check('pickAgent：话最多的那个', pickAgent(db) === aid, pickAgent(db))
check('pickAgent：指定就听指定的', pickAgent(db, other) === other)

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
