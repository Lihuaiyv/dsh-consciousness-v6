import { dbPath as _dbp } from './src/paths.js'
﻿import { DatabaseSync } from 'node:sqlite'
try {
  const db = new DatabaseSync(_dbp(), { readOnly: true })
  const rows = db.prepare("SELECT id, lane, title, state, created_at FROM inbox_items ORDER BY created_at DESC LIMIT 5").all()
  console.log(rows.length ? JSON.stringify(rows, null, 1) : '(空)')
  db.close()
} catch (e) { console.log('err', e.message) }
