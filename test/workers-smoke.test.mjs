/**
 * Phase 1 烟测：workers 工厂导出齐全，微信脚本路径相对本包可解析。
 */
import assert from 'node:assert/strict'
import { createWorkers } from '../src/host/workers.js'

const api = createWorkers({
  ensureDb: () => { throw new Error('no db in smoke') },
  enabledAgentIds: () => [],
  summarizeForDiary: () => null,
  probe: () => {},
})

for (const name of [
  'startExtractionWorker',
  'startRelationWorker',
  'startDiaryRetryWorker',
  'startNightlyWorker',
  'startGrowPrefsWorker',
  'startWeChatInboxWorker',
  'kickExtractionTick',
  'kickRelationReadTick',
]) {
  assert.equal(typeof api[name], 'function', name)
}

assert.equal(typeof api._wechatWinScript(), 'string')
assert.ok(api._wechatWinScript().replace(/\\/g, '/').endsWith('scripts/wechat_win.py'))

console.log('workers-smoke ok')
