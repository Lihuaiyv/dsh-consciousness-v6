/**
 * 三观草稿生成器 · 第一段：取料（命令行入口）
 *
 * 规则与页面起草共用 src/modules/sangguan/draftfeed.js；这里只负责 CLI 参数、
 * 挑 agent、写文件。产物（只读库，不写库）：
 *   drafts/<day>/episodes.json    取舍事件，带原话与上下文
 *   drafts/<day>/draft-prompt.md  起草那一步的提示词（人也可以直接读）
 *
 * 用法：
 *   node scripts/sangguan-draft.mjs
 *   node scripts/sangguan-draft.mjs --limit 4000 --max 80
 *   node scripts/sangguan-draft.mjs --agent agt_xxx
 *
 * 下一段（起草）要模型；草稿必须人改过才算数，所以不在这里自动写库。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mineEpisodes, pickAgent } from '../src/modules/sangguan/draftfeed.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DB = process.env.SG_DB || join(homedir(), '.dsh', 'consciousness', 'app.db')

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf('--' + k)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const LIMIT = Number(arg('limit', 3000))
const MAX_EPISODES = Number(arg('max', 80))
const AGENT = arg('agent', null)

function openDb() {
  const db = new DatabaseSync(DB, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 3000')
  return db
}

function main() {
  const db = openDb()
  const aid = pickAgent(db, AGENT)
  const { meta: base, episodes: eps } = mineEpisodes(db, aid, { limit: LIMIT, max: MAX_EPISODES })

  const day = new Date().toISOString().slice(0, 10)
  const dir = join(ROOT, 'drafts', day)
  mkdirSync(dir, { recursive: true })
  const meta = { ...base, generated_at: new Date().toISOString() }
  writeFileSync(join(dir, 'episodes.json'), JSON.stringify({ meta, episodes: eps }, null, 2), 'utf8')
  writeFileSync(join(dir, 'draft-prompt.md'), buildPrompt(meta, eps), 'utf8')
  console.log('取到 ' + eps.length + ' 条取舍事件 → ' + dir)
  console.log(JSON.stringify(meta.by_kind))
}

/** 起草段的提示词：给结构，不给句式。 */
function buildPrompt(meta, eps) {
  const list = eps.map((e, i) => [
    '### ' + (i + 1) + '. [' + e.kind + (e.repeat > 1 ? ' ×' + e.repeat : '') + '] ' + e.at,
    e.trigger ? '对方说：' + e.trigger : null,
    '它原来：' + e.before,
    e.after ? '它改成：' + e.after : null,
    '分量：' + e.score.toFixed(2),
  ].filter(Boolean).join('\n')).join('\n\n')

  return `# 三观草稿 · 起草提示词

下面是从它真实历史里取到的 ${eps.length} 个取舍现场（扫描 ${meta.turns_scanned} 回合）。
任务不是总结这些事件，是从里面认出**它已经在做的取舍**，写成第一人称草稿。

## 一条草稿成立的五个条件（缺一条就不要写）

1. **有另一条路**：另一个做法在当时也说得通。写出来，别写成「我选择了做好」。
2. **有代价**：它为此多花了时间、挨了骂、丢了面子、少做了别的，或者让对方失望。代价要具体。
3. **能排除**：读完能说出「所以这件事上它不会那样做」。说不出就是口号。
4. **不是任务说明**：把项目、插件、代码、对话全抽掉，这条还成立吗？不成立就是工作规范。
5. **有证据**：至少指回两个不同时间的具体事件。只有一次是偶然。

## 写法

- 第一人称，像自己跟自己交代，不像宣言。
- 不要用「我重视 / 我坚持 / 我始终相信」开头；不要对仗、排比、四字词。
- 每条 40–90 字；宁可短，不要齐。
- 允许不确定的口气：「我大概是这样的人」「我还没想清楚，但……」。犹豫也是真的。
- 写具体的事，不写抽象名词。不要为了显得深刻而拔高。

## 输出

每条草稿四块：

- **正文**：那句话。
- **另一条路 / 代价**：当时放弃的是什么，带具体事件。
- **边界**：什么情况下不适用。
- **反例**：它哪一次违背过。没违背过就写「还没有被违反过」，不要编。

最后单列一段：**没长出来的**——哪些事件看着像取舍，其实只是任务要求。

## 取舍现场

${list}
`
}

main()
