/**
 * 记忆统一 · 体检（只读）：重启之后跑一次，看新链路是不是真的活着。
 *
 * 为什么要有它：v2.1 这一批改动（切事 worker、回填 API、汇流自然触发、向量停写、
 * surface.direct、chat_turns.turn_id、停 episode 开关）都要等 DSH 重启加载新代码才生效。
 * 重启后最怕的不是报错，是「静默没生效」——所以一条命令，把该看的都看一眼。
 *
 * 用法：node scripts/check-memory-unify.mjs
 * 输出分 PASS / INFO / WARN；WARN 不一定是错（比如刚重启还没到切事时间）。
 */
import { DatabaseSync } from 'node:sqlite'
import { dbPath } from '../src/paths.js'

const db = new DatabaseSync(dbPath(), { readOnly: true })
try { db.exec('PRAGMA busy_timeout=5000') } catch { /* ignore */ }

const lines = []
const say = (level, name, detail) => { lines.push({ level, name, detail }) }
const one = (sql, ...a) => { try { return db.prepare(sql).get(...a) || {} } catch { return {} } }
const all = (sql, ...a) => { try { return db.prepare(sql).all(...a) } catch { return [] } }

console.log('库:', dbPath())
const aid = one("SELECT id FROM agents WHERE status='active' ORDER BY created_at LIMIT 1").id || ''
console.log('意识体:', aid)

// 1) 三个开关
const flag = (k) => one('SELECT value FROM flags WHERE key=?', k).value
const ep = flag('memory.episode.write')
const vec = flag('memory.vector.enabled')
const sd = flag('surface.direct')
say(ep === 'off' ? 'PASS' : 'INFO', '停 episode', ep === 'off' ? '已关（只停 manual 车道）' : '仍开（默认；等切事稳定再关）')
say(vec === 'on' ? 'WARN' : 'PASS', '向量通道', vec === 'on' ? '开着（旧向量还在参与排序）' : '已关（默认）')
say(sd === 'on' ? 'WARN' : 'PASS', 'pulse/情绪直塞', sd === 'on' ? '开着（旧行为）' : '已关（只留候选）')

// 2) 事件库
const hot = one('SELECT COUNT(*) n, MAX(created_at) last FROM hot_events WHERE agent_id=? AND active=1', aid)
const cold = one('SELECT COUNT(*) n, MAX(created_at) last FROM cold_events WHERE agent_id=?', aid)
const recentCut = all('SELECT key, value FROM flags WHERE key LIKE ? ORDER BY key DESC LIMIT 8', 'events.cut.%')
say(Number(hot.n) >= 5 ? 'PASS' : 'WARN', '事件热库', `active=${hot.n || 0}，最近 ${hot.last || '-'}`)
say(Number(cold.n) >= 5 ? 'PASS' : 'WARN', '事件冷库', `总数=${cold.n || 0}，最近 ${cold.last || '-'}`)
// 2026-11-14（D43）：有闸 ≠ 切完了。done 要看 state；pending/retry 要报 WARN 并带进度，
// 否则「盖了章但后面漏了」会被报成绿的（11-13 深夜那 4 小时就是这么漏的）。
{
  const dayFlags = new Map()
  for (const r of recentCut) {
    const m = /^events\.cut\.(\d{4}-\d{2}-\d{2})\.(.+)$/.exec(String(r.key))
    if (!m) continue
    const o = dayFlags.get(m[1]) || {}
    o[m[2]] = String(r.value)
    dayFlags.set(m[1], o)
  }
  const days = [...dayFlags.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  const unfinished = days.filter(([, f]) => f.state !== 'done')
  const latest = days[0]
  if (!days.length) say('WARN', '切事闸', '还没有 events.cut.*（重启后等第一次 tick）')
  else if (unfinished.length) {
    say('WARN', '切事闸', `${unfinished.length} 天没落 done：` + unfinished.slice(0, 3).map(([d, f]) => `${d}(state=${f.state || '-'}, pos=${f.pos || '-'})`).join(' | '))
  } else {
    const f = latest[1]
    const doneAt = f.doneAt ? `，指纹 ${f.doneAt}` : '，无指纹（老闸）'
    say('PASS', '切事闸', `最近一天 ${latest[0]} 已 done${doneAt}；共 ${days.length} 天有闸`)
  }
}

// 3) 今天的产出
const epToday = one(`SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND type='episode' AND created_at>=?`, aid, new Date(Date.now() - 86400000).toISOString())
say(Number(epToday.n) > 0 ? 'INFO' : 'PASS', '近 24h 每轮 episode', (epToday.n || 0) + ' 条')

// 4) turn_id 覆盖（重启后新行）
//    先看列在不在：列不存在 = 旧进程还没加载新代码（openDb 启动时才会 ALTER）。
//    以前这里直接跑 SELECT turn_id，列不在就抛错被吞成 0/0——看着像「覆盖率为 0」，其实是「列都没有」。
const hasChatTurnId = (() => {
  try { return db.prepare('PRAGMA table_info(chat_turns)').all().some((c) => c.name === 'turn_id') } catch { return false }
})()
if (!hasChatTurnId) {
  say('WARN', 'chat_turns.turn_id', '列还没有（旧进程；重启后 openDb 会补列并开始写）')
} else {
  const chat = one(`SELECT COUNT(*) n, SUM(CASE WHEN turn_id IS NOT NULL AND turn_id<>'' THEN 1 ELSE 0 END) with_id
    FROM chat_turns WHERE agent_id=? AND created_at>=?`, aid, new Date(Date.now() - 86400000).toISOString())
  const cov = chat.n ? Math.round((Number(chat.with_id) / Number(chat.n)) * 100) : 0
  say(Number(chat.n) === 0 ? 'INFO' : (cov >= 90 ? 'PASS' : 'WARN'), 'chat_turns.turn_id 覆盖', `${chat.with_id || 0}/${chat.n || 0}（${cov}%，重启后新写入应为 100%）`)
}

// 5) 汇流账
const cf = all("SELECT mode, COUNT(*) n FROM confluence_log WHERE agent_id=? GROUP BY mode", aid)
const autoCf = cf.find((r) => r.mode === 'auto')
say(autoCf ? 'PASS' : 'WARN', '汇流自然触发账', cf.length ? cf.map((r) => r.mode + '=' + r.n).join(' | ') : '还没有 confluence_log 行')

// 6) 队列
const sq = one("SELECT COUNT(*) n FROM surface_queue WHERE agent_id=? AND state='pending'", aid)
say('INFO', 'surface 候选', `pending=${sq.n || 0}（直塞关着时只排不消费）`)
const rv = one('SELECT COUNT(*) n FROM revisit WHERE agent_id=?', aid)
say('INFO', 'revisit', `累计=${rv.n || 0}`)

// 7) 口径
const slim = one(`SELECT
  (SELECT COUNT(*) FROM memory_items WHERE agent_id=? AND type='episode' AND source='manual') stop_now,
  (SELECT COUNT(*) FROM memory_items WHERE agent_id=?) all_mem`, aid, aid)
say('INFO', '收身口径', `episode/manual=${slim.stop_now || 0} / 全部=${slim.all_mem || 0}`)

console.log('')
for (const l of lines) console.log(l.level.padEnd(5), l.name.padEnd(16), l.detail)
const warn = lines.filter((l) => l.level === 'WARN')
console.log(`\n${lines.length - warn.length} 项 OK/INFO，${warn.length} 项待观察（WARN 不一定是错）`)
db.close()
