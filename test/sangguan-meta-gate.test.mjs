/**
 * 「三观写得很蠢」回归：每轮 summarize 出来的用户画像（事实/偏好/边界）不能被当成它的立场。
 * 运行：node test/sangguan-meta-gate.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { fieldCheck, metaSummary, stanceText } from '../src/modules/sangguan/gates.js'
import { intakeCandidates } from '../src/modules/sangguan/intake.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

// 截图里那条「人生观」原文
const PROFILE = '1. 事实：用户只问“你觉得是你吗？”，把某个“鲸鱼娘”形象与助手联系起来，未提供其他个人信息。  \n'
  + '2. 偏好与情绪：用户似乎对助手形象有好奇或疑惑，但没有表达明确偏好或强烈情绪。  \n'
  + '3. 边界：这段对话中用户未说明任何禁忌、界限或期望，边界信息不足。'

check('画像总结被识别为元叙述', metaSummary(PROFILE) === true)
check('W1 直接拒收画像总结', fieldCheck({ layer: 'L', kind: 'role', text: PROFILE }) === '元叙述（在对用户做画像，不是立场）')
check('编号列表也拒', fieldCheck({ layer: 'L', kind: 'role', text: '1. 我更喜欢安静\n2. 我不爱热闹' }) !== null)
check('正常立场句不受影响', fieldCheck({ layer: 'L', kind: 'role', text: '我更想先把日子过明白' }) === null)

check('元叙述洗不出立场句', stanceText(PROFILE) === '')
check('没有「我」的句子不当立场', stanceText('用户不喜欢狗') === '')
check('立场句取第一句并压成一行', stanceText('我更想先把日子过明白。剩下的以后再说。') === '我更想先把日子过明白。')
check('超长立场截断', stanceText('我' + '想'.repeat(200), 40).length === 40)
check('列表号剥掉', stanceText('1. 我更看重照顾身边的人') === '我更看重照顾身边的人')

// 进料侧：同一段文字，reflection 不进，aspiration 进
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-metagate-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_meta'
const T = '2026-11-01T12:00:00.000Z'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)').run(aid, aid, 'daily', 'active', T)
setSangguanConfig(db, aid, { enabled: true })
const mem = (id, type, text) => db.prepare(`INSERT INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,
  last_decay_at,valid_at,invalid_at,status,created_at,deleted_at,version)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, aid, type, 'normal', text, 'summary', 0.5, 0.5, 1, 5, T, null, null, 'active', T, null, 1)

mem('m1', 'reflection', PROFILE)
mem('m2', 'aspiration', '我想把插件修到不再说蠢话。后面再慢慢补。')
const first = intakeCandidates(db, aid)
check('reflection 不进候选、aspiration 进且只有一句', first.length === 1 && first[0].ref === 'm2' && first[0].text === '我想把插件修到不再说蠢话。', first)

console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
