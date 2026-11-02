import { DatabaseSync } from 'node:sqlite'

const DB = 'C:/Users/ygys1/.dsh/consciousness/app.db'
const TEST = ['qq:p:222', 'qq:p:7777', 'qq:p:90003']
const JUNK_MEM = ['mem_8f88cccfbf', 'mem_74479c314f', 'mem_596a4a852a', 'mem_1b0ee406b0']

const db = new DatabaseSync(DB)
const before = {
  conversations: db.prepare('select count(*) n from conversations').get().n,
  turns: db.prepare('select count(*) n from chat_turns').get().n,
  memories: db.prepare("select count(*) n from memory_items where status!='soft_deleted'").get().n,
  ownerTurns: db.prepare("select count(*) n from chat_turns where conversation_id='qq:p:3192248859'").get().n,
}
console.log('BEFORE', JSON.stringify(before))

const ph = TEST.map(() => '?').join(',')
db.exec('BEGIN')
try {
  const delTurns = db.prepare(`DELETE FROM chat_turns WHERE conversation_id IN (${ph})`).run(...TEST).changes
  const delConvs = db.prepare(`DELETE FROM conversations WHERE conversation_id IN (${ph})`).run(...TEST).changes
  let mem = 0
  const mPh = JUNK_MEM.map(() => '?').join(',')
  for (const r of db.prepare(`select id from memory_items where id IN (${mPh}) and status!='soft_deleted'`).all(...JUNK_MEM)) {
    mem += db.prepare("update memory_items set status='soft_deleted', deleted_at=? where id=?").run(new Date().toISOString(), r.id).changes
  }
  db.exec('COMMIT')
  console.log('DELETED', JSON.stringify({ testConversations: delConvs, testTurns: delTurns, junkMemoriesSoftDeleted: mem }))
} catch (e) {
  db.exec('ROLLBACK')
  console.error('ROLLBACK', e.message)
  process.exitCode = 1
}

const after = {
  conversations: db.prepare('select count(*) n from conversations').get().n,
  turns: db.prepare('select count(*) n from chat_turns').get().n,
  memories: db.prepare("select count(*) n from memory_items where status!='soft_deleted'").get().n,
  ownerTurns: db.prepare("select count(*) n from chat_turns where conversation_id='qq:p:3192248859'").get().n,
}
console.log('AFTER ', JSON.stringify(after))
console.log('conversations left:', JSON.stringify(db.prepare('select conversation_id, handle, state from conversations order by conversation_id').all()))
const leftover = db.prepare(`select conversation_id, count(*) n from chat_turns where conversation_id is not null group by conversation_id`).all()
console.log('turns by conversation:', JSON.stringify(leftover))
const dup = db.prepare(`select conversation_id, count(*) n from conversations group by conversation_id having n>1`).all()
console.log('dup conversations:', dup.length)
db.close()
