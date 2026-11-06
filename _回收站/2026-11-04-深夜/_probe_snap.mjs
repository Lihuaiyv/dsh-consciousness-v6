import { DatabaseSync } from 'node:sqlite'
import { feltSnapshot } from './src/modules/felt_snapshot.js'
const db = new DatabaseSync(String.raw`C:\Users\ygys1\.dsh\consciousness\app.db`, { readOnly: true })
const aid = 'agt_3977d80f17'
const s = feltSnapshot(db, aid, {})
console.log(JSON.stringify(s, null, 1))
