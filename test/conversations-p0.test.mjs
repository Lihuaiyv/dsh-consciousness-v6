/**
 * P0：schema 13 —— 会话列与会话表。
 * 只测「加列/加表/迁移不丢旧数据/重复启动幂等」这几件事，不碰业务。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb, now } from '../src/db.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-p0-'))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)) }
}

// ① 新库：schema 13、有会话列、有会话表
{
  const f = path.join(dir, 'fresh.db')
  const db = openDb(f)
  const v = db.prepare('SELECT version FROM schema_meta').get().version
  check('新库 schema=13', Number(v) === 13, v)
  const cols = db.prepare('PRAGMA table_info(chat_turns)').all().map((c) => c.name)
  check('新库 chat_turns 有 conversation_id', cols.includes('conversation_id'), cols)
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'").get()
  check('新库有 conversations 表', !!t)
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_chat_conv'").get()
  check('新库有会话索引', !!idx)
  const ins = db.prepare('INSERT INTO conversations(conversation_id,agent_id,channel,handle,person_id,state,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)')
  ins.run('qq:p:3192248859', 'agt_x', 'qq', '3192248859', 'per_x', 'active', now(), now())
  const row = db.prepare('SELECT * FROM conversations WHERE conversation_id=?').get('qq:p:3192248859')
  check('会话行可写可读', row && row.handle === '3192248859', row)
  db.close()
}

// ② 老库（schema 12，chat_turns 只有 7 列）：能迁移、旧行还在、有备份
{
  const f = path.join(dir, 'old.db')
  const raw = new DatabaseSync(f)
  raw.exec(`CREATE TABLE schema_meta(version INTEGER NOT NULL);
    INSERT INTO schema_meta(version) VALUES(12);
    CREATE TABLE chat_turns(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, pack TEXT, mood TEXT, created_at TEXT NOT NULL);
    INSERT INTO chat_turns VALUES('cht_old','agt_x','user','旧的一句话','[]',NULL,'2026-01-01T00:00:00.000Z');`)
  raw.close()

  const db = openDb(f)
  const v = db.prepare('SELECT version FROM schema_meta').get().version
  check('老库迁移到 13', Number(v) === 13, v)
  const cols = db.prepare('PRAGMA table_info(chat_turns)').all().map((c) => c.name)
  check('老库补出 conversation_id', cols.includes('conversation_id'), cols)
  const old = db.prepare("SELECT * FROM chat_turns WHERE id='cht_old'").get()
  check('旧行保留且会话列为空', old && old.text === '旧的一句话' && old.conversation_id === null, old)
  const backups = fs.readdirSync(dir).filter((n) => n.startsWith('old.db.bak-schema12-'))
  check('升级前有备份', backups.length >= 1, backups)
  db.close()

  // ③ 重复启动幂等
  const db2 = openDb(f)
  const v2 = db2.prepare('SELECT version FROM schema_meta').get().version
  const cols2 = db2.prepare('PRAGMA table_info(chat_turns)').all().map((c) => c.name)
  check('重复启动仍为 13 且不重复加列', Number(v2) === 13 && cols2.filter((c) => c === 'conversation_id').length === 1, { v2, cols2 })
  const backups2 = fs.readdirSync(dir).filter((n) => n.startsWith('old.db.bak-schema12-'))
  check('已是最新时不再新增备份', backups2.length === backups.length, { before: backups.length, after: backups2.length })
  db2.close()
}

// ④ 新列可写、可按会话查
{
  const f = path.join(dir, 'write.db')
  const db = openDb(f)
  const ins = db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id) VALUES(?,?,?,?,?,?,?,?)')
  ins.run('c1', 'agt_x', 'user', 'A 的话', '[]', null, now(), 'qq:p:111')
  ins.run('c2', 'agt_x', 'user', 'B 的话', '[]', null, now(), 'qq:p:222')
  const a = db.prepare("SELECT text FROM chat_turns WHERE conversation_id=? AND agent_id=?").all('qq:p:111', 'agt_x')
  check('按会话隔离查询', a.length === 1 && a[0].text === 'A 的话', a)
  db.close()
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) { console.log('失败', fail); process.exit(1) }
