// 收口的界桩：零件立住之后，别处不许再手写一份同样的判断。
// 运行：node scripts/check-adoption.mjs
//
// 为什么要有这一道：考卷只证明「这个零件自己做得对」，打假只证明「它坏了会红」，
// 但都看不见「别的地方又照抄了一版」。认人那次就是这样——三处手抄（promptBlock /
// ingest / bumpRelation），其中 bumpRelation 的顺序还反着，全套门禁一声没吭，
// 最后是一行行翻代码翻出来的。这道闸把「靠我记得」换成「机器会红」。
//
// 规矩只写一条，别的零件照这个形状往下加：
//   一个判断只有一处实现；它用到的原料函数，也只许出现在它自己的文件里。
//   别处要问同一个问题，就调它的公开入口。
//
// 只扫真正跑的车：src/ 下所有 .js，加根目录的入口文件（index.js / client.js）。
// tests 和打假脚本本来就会故意写出坏例子，不归它管；_回收站 是旧的备份，也不扫。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 每条规矩：一个零件、一个只许它自己用的原料、一句人话。allow 可以是文件列表。 */
const RULES = [
  {
    part: '认人',
    desc: '问「谁在说话」只有一处：别处调 whoIsSpeaking；personByChannel 只许在 who.js 里出现',
    allow: 'src/modules/who.js',
    test: (line) => /personByChannel\s*\(/.test(line),
  },
  {
    part: '认人',
    desc: '不许手写「主人 || 通道」的兜底顺序（旧的 bumpRelation 就错在这儿）',
    allow: 'src/modules/who.js',
    test: (line) => /ownerPerson\s*\(.*\)\s*\|\|\s*personByChannel/.test(line),
  },
  {
    part: '听见',
    desc: '转规格和体检只有一处：别处调 transcribeVoice；toWav16k / inspectWav 只许在 parts/ear/ 里出现',
    allow: ['src/parts/ear/index.js', 'src/parts/ear/probe.js', 'src/parts/ear/engine.js'],
    test: (line) => /\b(?:toWav16k|inspectWav|canonicalizeWav)\s*\(/.test(line),
  },
  {
    part: '出声',
    desc: '合成和看字节只有一处：别处调 synthesizeVoice；synthesizeTts / sniffAudioFormat 只许在 parts/mouth/ 里出现',
    allow: ['src/parts/mouth/index.js', 'src/parts/mouth/providers.js', 'src/parts/mouth/format.js'],
    test: (line) => /\b(?:synthesizeTts|sniffAudioFormat|buildAzureSsml)\s*\(/.test(line),
  },
  {
    part: '主动开口',
    desc: '开口判断只有一处：别处调零件导出的 decideSpeak；decideSpeak( 只许在 parts/speak/ 里出现',
    allow: ['src/parts/speak/judge.js', 'src/parts/speak/index.js'],
    test: (line) => /\bdecideSpeak\s*\(/.test(line),
  },
  {
    part: '主动开口',
    desc: '开口事由只有一处：proactiveTriggerOf( 只许在 parts/speak/ 里出现',
    allow: ['src/parts/speak/trigger.js', 'src/parts/speak/index.js'],
    test: (line) => /\bproactiveTriggerOf\s*\(/.test(line),
  },
  {
    part: '模型预算',
    desc: '日调用账只有一处：llm.budget.used / llm.budget.detail 只许在 llm_budget.js 里写',
    allow: 'src/modules/llm_budget.js',
    test: (line) => /llm\.budget\.(?:used|detail):/.test(line),
  },
  {
    part: '鱼格',
    desc: '贴墙和单来源净力只有一处：wallFactor / srcNet 只许在 rope.js 里出现',
    allow: 'src/modules/rope.js',
    test: (line) => /\b(?:wallFactor|srcNet)\s*\(/.test(line),
  },
  {
    part: '鱼格',
    desc: '复读比例和讲事回复只有一处：echoRatio / isTechReply 只许在 self_scan.js 里出现',
    allow: 'src/modules/self_scan.js',
    test: (line) => /\b(?:echoRatio|isTechReply)\s*\(/.test(line),
  },
  {
    part: '验收',
    desc: '硬门槛表只有一处：HARD_GATES 只许在 eval.js 里出现',
    allow: 'src/modules/eval.js',
    test: (line) => /\bHARD_GATES\b/.test(line),
  },
]

const SKIP_DIRS = new Set(['node_modules', '_回收站'])

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(p, out)
    } else if (ent.name.endsWith('.js') || ent.name.endsWith('.mjs')) {
      out.push(path.relative(root, p).replace(/\\/g, '/'))
    }
  }
  return out
}

const targets = []
try { walk(path.join(root, 'src'), targets) } catch { /* 没有 src 就只扫根 */ }
for (const f of ['index.js', 'client.js']) {
  if (fs.existsSync(path.join(root, f))) targets.push(f)
}

let scanned = 0
const reds = []
for (const rel of targets) {
  let text = ''
  try { text = fs.readFileSync(path.join(root, rel), 'utf8') } catch { continue }
  scanned++
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const rule of RULES) {
      const allow = Array.isArray(rule.allow) ? rule.allow : [rule.allow]
      if (allow.includes(rel)) continue
      if (!rule.test(line)) continue
      reds.push({ rel, line: i + 1, rule, code: line.trim().slice(0, 120) })
    }
  }
}

for (const r of reds) {
  console.log('红  ' + r.rel + ':' + r.line + '  还手写了一份「' + r.rule.part + '」的判断')
  console.log('    ' + r.rule.desc)
  console.log('    ' + r.code)
}

console.log('\n收口界桩：' + (reds.length ? reds.length + ' 条红' : '全绿') + '（扫了 ' + scanned + ' 个文件，' + RULES.length + ' 条规矩）')
if (reds.length) process.exitCode = 1
