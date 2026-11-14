// 搬家前体检：在打包之前把「一定会断的线」先找出来。
//
// 为什么单独做这个：
//   2026-11-07 的搬家是搬完才发现问题的——脚本读空库、定时任务指旧机器、桌面 junction 断了。
//   这份检查只回答一件事：现在这台机器上，还有没有「换个用户/换个盘就会断」的地方。
//
// 用法：node scripts/check-move-ready.mjs [--json]
// 退出码：0 = 都能搬；1 = 有会断的线（先修再搬）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { home, dbPath, repoRoot } from '../src/paths.js'

const asJson = process.argv.includes('--json')
const R = repoRoot()
const H = home()
const rows = []
const add = (level, name, detail) => rows.push({ level, name, detail })
const ok = (name, detail = '') => add('ok', name, detail)
const warn = (name, detail = '') => add('warn', name, detail)
const bad = (name, detail = '') => add('bad', name, detail)

function tryGit(args) {
  for (const bin of ['git', 'D:\\tools\\git\\cmd\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe']) {
    try {
      return execFileSync(bin, args, { cwd: R, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch { /* 换下一个 */ }
  }
  return null
}

// ── 1. 仓库 ──────────────────────────────────────────────────────────
const status = tryGit(['status', '--porcelain'])
if (status === null) {
  bad('git', '找不到 git，提交历史和未提交改动都无法核对')
} else {
  const lines = status ? status.split(/\r?\n/).filter(Boolean) : []
  if (lines.length === 0) ok('工作树', '干净，导出就是提交历史里的样子')
  else warn('工作树', `${lines.length} 个未提交/未跟踪条目；导出会连工作树一起带走，但历史里没有`)
  const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'])
  const head = tryGit(['rev-parse', '--short', 'HEAD'])
  if (branch && head) ok('版本', `${branch} @ ${head}`)
}

// ── 2. 仓库里的闸 ────────────────────────────────────────────────────
for (const [label, script] of [['路径闸', 'check-paths.mjs'], ['目录卫生', 'check-hygiene.mjs']]) {
  try {
    execFileSync(process.execPath, [path.join(R, 'scripts', script)], { cwd: R, stdio: 'pipe' })
    ok(label, '通过')
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`.trim().split(/\r?\n/).slice(-3).join(' / ')
    bad(label, out || '未通过')
  }
}

// ── 3. profile 里的绝对路径（搬家断线第一名）────────────────────────────
const profilesDir = path.join(H, 'profiles')
const profileHits = []
if (fs.existsSync(profilesDir)) {
  for (const name of fs.readdirSync(profilesDir)) {
    const dir = path.join(profilesDir, name)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const file of ['cordis.patch.yml', 'package.json']) {
      const p = path.join(dir, file)
      if (!fs.existsSync(p)) continue
      const text = fs.readFileSync(p, 'utf8')
      const re = /[A-Za-z]:[\\/][^\s"'，。；、）)]+/g
      for (const m of text.match(re) || []) {
        // 只关心本机用户目录、插件仓库、盘符下的个人路径；DSH 自己的安装目录也记下来
        if (/Users[\\/]|deepseek|Desktop|Pictures|\.dsh/i.test(m)) profileHits.push({ profile: name, file, p: m })
      }
    }
  }
}
if (profileHits.length === 0) ok('profile 路径', '没有写死的绝对路径')
else {
  const uniq = [...new Map(profileHits.map((x) => [`${x.profile}/${x.file}:${x.p}`, x])).values()]
  warn('profile 路径', `${uniq.length} 处写死；一键恢复会按新机器重写，搬家时别手拷`)
  for (const x of uniq.slice(0, 6)) add('warn', '  ' + `${x.profile}/${x.file}`, x.p)
}

// ── 4. 运行数据 ──────────────────────────────────────────────────────
const must = [
  ['库', dbPath()],
  ['storages', path.join(H, 'storages')],
  ['sessions', path.join(H, 'sessions')],
  ['consciousness', path.join(H, 'consciousness')],
  ['profile desktop', path.join(H, 'profiles', 'desktop')],
]
for (const [label, p] of must) {
  if (fs.existsSync(p)) ok(label, '在')
  else bad(label, '不在：' + p)
}

// 库完整性 + 条数
if (fs.existsSync(dbPath())) {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath(), { readOnly: true })
    const integrity = String(db.prepare('PRAGMA integrity_check').get().integrity_check)
    const counts = {}
    for (const t of ['agents', 'fragments', 'memory_items', 'affect_feel', 'diaries']) {
      try { counts[t] = Number(db.prepare(`SELECT count(*) c FROM ${t}`).get().c) } catch { counts[t] = null }
    }
    db.close()
    if (integrity === 'ok') ok('库完整性', Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '))
    else bad('库完整性', integrity)
  } catch (e) {
    bad('库完整性', String(e.message || e))
  }
}

// ── 5. 定时任务 / 工作区里的旧路径 ────────────────────────────────────
for (const [label, file] of [['定时任务', 'schedule.json'], ['工作区', 'workspace.json']]) {
  const p = path.join(H, 'storages', file)
  if (!fs.existsSync(p)) continue
  const text = fs.readFileSync(p, 'utf8')
  const hits = text.match(/[A-Za-z]:[\\/][^\s"'，。；、）)\\]*(?:[\\/][^\s"'，。；、）)\\]*)+/g) || []
  const stale = [...new Set(hits)].filter((x) => /Users[\\/]|deepseek|Desktop|\.dsh/i.test(x))
  if (stale.length === 0) ok(label + '路径', '没有绝对路径')
  else warn(label + '路径', `${stale.length} 处；一键恢复会重写，平时别手改`)
}

// ── 6. 环境 ──────────────────────────────────────────────────────────
const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor >= 22) ok('Node', `v${process.versions.node}（node:sqlite 可用）`)
else bad('Node', `v${process.versions.node} 太旧，需要 ≥22.5`)

const gitVersion = tryGit(['--version'])
if (gitVersion) ok('Git', gitVersion.replace(/^git version\s*/, ''))
else warn('Git', '不在 PATH；恢复后提交要手动找路径')

let dshVersion = null
try {
  const p = path.join(H, 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json')
  dshVersion = JSON.parse(fs.readFileSync(p, 'utf8')).version
} catch { /* 没装或路径不同 */ }
if (dshVersion) ok('DSH', dshVersion)
else warn('DSH', '读不到版本；恢复后以新装的那份为准')

// ── 7. 体积预估（只算默认会带走的东西）────────────────────────────────
const SKIP = new Set(['node_modules', '.git', 'cache', 'dsh-runtimes', 'napcat', 'backups', 'var', 'scratch'])
function dirSize(dir, skip = SKIP) {
  if (!fs.existsSync(dir)) return 0
  let total = 0
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.has(ent.name)) continue
      const p = path.join(d, ent.name)
      try {
        const st = fs.statSync(p)
        if (st.isDirectory()) walk(p)
        else total += st.size
      } catch { /* 跳过锁文件 */ }
    }
  }
  walk(dir)
  return total
}
const parts = [
  ['仓库', R],
  ['consciousness', path.join(H, 'consciousness')],
  ['sessions', path.join(H, 'sessions')],
  ['attachments', path.join(H, 'attachments')],
  ['qq-bridge', path.join(H, 'qq-bridge')],
  ['storages', path.join(H, 'storages')],
]
const sizes = parts.map(([k, p]) => [k, dirSize(p)])
const totalMB = sizes.reduce((s, [, b]) => s + b, 0) / 1024 / 1024
ok('搬家包预估', `${totalMB.toFixed(0)} MB（不含 node_modules / 缓存 / NapCat 本体）`)

// ── 输出 ─────────────────────────────────────────────────────────────
if (asJson) {
  console.log(JSON.stringify({ at: new Date().toISOString(), repo: R, home: H, rows }, null, 2))
} else {
  const icon = { ok: '✓', warn: '!', bad: '✗' }
  console.log(`搬家前体检  ${R}`)
  console.log(`DSH_HOME   ${H}\n`)
  for (const r of rows) {
    if (r.level === 'ok') console.log(`  ${icon.ok} ${r.name}${r.detail ? '  — ' + r.detail : ''}`)
  }
  const issues = rows.filter((r) => r.level !== 'ok')
  if (issues.length) {
    console.log('\n要留意的：')
    for (const r of issues) console.log(`  ${icon[r.level]} ${r.name}${r.detail ? '  — ' + r.detail : ''}`)
  }
  const badCount = rows.filter((r) => r.level === 'bad').length
  console.log(`\n结果：${badCount ? badCount + ' 处会断，先修再搬' : '可以搬'}（${rows.filter((r) => r.level === 'warn').length} 处提醒）`)
  if (badCount) process.exitCode = 1
}
