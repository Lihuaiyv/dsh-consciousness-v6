import { DatabaseSync } from 'node:sqlite'
import { feltSnapshot } from './src/modules/felt_snapshot.js'
const db = new DatabaseSync(String.raw`C:\Users\ygys1\.dsh\consciousness\app.db`, { readOnly: true })
const s = feltSnapshot(db, 'agt_3977d80f17', {})
console.log('line:', s && s.line)
console.log('paired:', s && s.paired, 'cause:', s && s.cause)
