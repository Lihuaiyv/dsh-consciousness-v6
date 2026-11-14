// 一键搬家（导出半）：把「仓库 + 运行数据 + profile 配置 + 同伴插件」打成一个可校验的包。
//
// 设计目标只有一个：到了新机器，双击「一键恢复.cmd」就能把这套装回去，
// 而不是像 2026-11-07 那样——搬完才发现脚本读空库、定时任务指向旧机器、桌面 junction 断了。
//
// 用法：
//   node scripts/migrate-export.mjs                    打到桌面「搬家包\」
//   node scripts/migrate-export.mjs --out E:\move      指定目录
//   node scripts/migrate-export.mjs --lean             不带 sessions/attachments（小包）
//   node scripts/migrate-export.mjs --with-backups     连历史备份一起带
//   node scripts/migrate-export.mjs --force            体检有红也继续
//
// 包里有什么、为什么这么分，见生成的 README.md。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { home, dbPath, repoRoot } from '../src/paths.js'

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const R = repoRoot()
const H = home()
const RT = path.resolve(R, '..', 'runtime')
// 数据可能已经收进插件目录（runtime\），有就优先用那边，别再读 ~/.dsh 的旧位置
const dataPath = (n) => { const rt = path.join(RT, n); return fs.existsSync(rt) ? rt : path.join(H, n) }
const LEAN = has('--lean')
const WITH_BACKUPS = has('--with-backups')
const NO_PLUGINS = has('--no-plugins')
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const outRoot = path.resolve(opt('--out', path.join(os.homedir(), 'Desktop', '搬家包')))
const pkg = path.join(outRoot, `xiaoxi-move-${stamp}`)

console.log('搬家导出')
console.log('  仓库   ' + R)
console.log('  DSH    ' + H)
console.log('  输出   ' + pkg)

// ── 0. 先体检：有会断的线就别糊弄过去 ────────────────────────────────
try {
  const out = execFileSync(process.execPath, [path.join(R, 'scripts', 'check-move-ready.mjs')], { cwd: R, encoding: 'utf8' })
  console.log('\n' + out.trim().split(/\r?\n/).slice(-3).join('\n'))
} catch (e) {
  console.error('\n搬家前体检没过：\n' + `${e.stdout || ''}${e.stderr || ''}`.trim())
  if (!has('--force')) {
    console.error('\n先修上面的问题，或者加 --force 强行导出。')
    process.exit(1)
  }
  console.log('（--force：继续）')
}

fs.mkdirSync(pkg, { recursive: true })

// ── 复制工具 ────────────────────────────────────────────────────────
const SKIP_NAMES = new Set(['node_modules', '.git', 'scratch', 'var', '__pycache__', 'wechatauto_logs'])
const SKIP_SUFFIX = ['.log', '.db-wal', '.db-shm', '.bak']
const SKIP_PREFIX = ['_bak_', '_tmp_', 'app.db.before-']
function shouldSkip(name) {
  if (SKIP_NAMES.has(name)) return true
  if (name.startsWith('_')) return true          // 一次性草稿 / 探针，不进搬家包
  if (SKIP_PREFIX.some((p) => name.startsWith(p))) return true
  if (SKIP_SUFFIX.some((s) => name.endsWith(s))) return true
  return false
}

/** 复制一个目录（默认过滤），返回复制文件数。
 *  自己走递归而不是 fs.cpSync：cpSync 不允许把源拷进自己的子目录，
 *  而包有时就打在仓库的 var/ 下。这里遇到目标目录直接跳过。 */
function copyDir(from, to, extraFilter = () => true, skipAbs = pkg) {
  if (!fs.existsSync(from)) return 0
  let n = 0
  const walk = (src, dst) => {
    const abs = path.resolve(src)
    if (skipAbs && (abs === skipAbs || abs.startsWith(skipAbs + path.sep))) return
    fs.mkdirSync(dst, { recursive: true })
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, ent.name)
      const d = path.join(dst, ent.name)
      if (shouldSkip(ent.name)) continue
      if (!extraFilter(s)) continue
      let st
      try { st = fs.lstatSync(s) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) walk(s, d)
      else if (st.isFile()) { fs.copyFileSync(s, d); n++ }
    }
  }
  walk(from, to)
  return n
}

/** 只复制白名单文件名（profile 配置用） */
function copyFiles(from, to, names) {
  fs.mkdirSync(to, { recursive: true })
  let n = 0
  for (const name of names) {
    const src = path.join(from, name)
    if (!fs.existsSync(src)) continue
    fs.cpSync(src, path.join(to, name), { recursive: true, force: true })
    n++
  }
  return n
}

function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0
  let n = 0
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.isDirectory()) walk(path.join(d, ent.name))
      else n++
    }
  }
  walk(dir)
  return n
}

function sizeOf(p) {
  if (!fs.existsSync(p)) return 0
  const st0 = fs.statSync(p)
  if (st0.isFile()) return st0.size
  let total = 0
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name)
      try {
        const st = fs.statSync(p)
        if (st.isDirectory()) walk(p)
        else total += st.size
      } catch { /* 锁文件 */ }
    }
  }
  walk(p)
  return total
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
  })
}

function walkFiles(dir, base = dir) {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walkFiles(p, base))
    else out.push(path.relative(base, p).replace(/\\/g, '/'))
  }
  return out
}

// ── 1. 仓库快照 ──────────────────────────────────────────────────────
console.log('\n[1/6] 仓库快照')
const repoOut = path.join(pkg, 'repo')
copyDir(R, repoOut)
console.log('  文件 ' + countFiles(repoOut) + ' 个')

// 历史：git bundle 单独放，恢复时可选 clone
let bundleOk = false
try {
  execFileSync('git', ['bundle', 'create', path.join(pkg, 'repo.bundle'), '--all'], { cwd: R, stdio: 'pipe' })
  bundleOk = true
  console.log('  历史 bundle：' + (sizeOf(path.join(pkg, 'repo.bundle')) / 1024 / 1024).toFixed(1) + ' MB')
} catch {
  try {
    execFileSync('D:\\tools\\git\\cmd\\git.exe', ['bundle', 'create', path.join(pkg, 'repo.bundle'), '--all'], { cwd: R, stdio: 'pipe' })
    bundleOk = true
  } catch { console.log('  ! git bundle 没做成（git 不在 PATH），仓库快照仍然可用') }
}

// ── 2. 库：一致性快照 ────────────────────────────────────────────────
console.log('\n[2/6] 数据库')
const dataDir = path.join(pkg, 'data')
const conOut = path.join(dataDir, 'consciousness')
fs.mkdirSync(conOut, { recursive: true })
const dbSrc = dbPath()
if (!fs.existsSync(dbSrc)) {
  console.error('  找不到库：' + dbSrc)
  process.exit(1)
}
const dbOut = path.join(conOut, 'app.db')
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(dbSrc)
db.exec(`VACUUM INTO '${dbOut.replace(/'/g, "''")}'`)
const counts = {}
for (const t of ['agents', 'fragments', 'memory_items', 'affect_feel', 'diaries']) {
  try { counts[t] = Number(db.prepare(`SELECT count(*) c FROM ${t}`).get().c) } catch { counts[t] = null }
}
db.close()
const verify = new DatabaseSync(dbOut, { readOnly: true })
const integrity = String(verify.prepare('PRAGMA integrity_check').get().integrity_check)
verify.close()
if (integrity !== 'ok') {
  console.error('  快照校验失败：' + integrity)
  process.exit(1)
}
console.log('  app.db ' + (sizeOf(dbOut) / 1024 / 1024).toFixed(1) + ' MB，校验 ok，' + JSON.stringify(counts))

// ── 3. 其余运行数据 ──────────────────────────────────────────────────
console.log('\n[3/6] 运行数据')
// consciousness 下除库和备份之外的东西（文档、故事、画、研究）
const conExtra = copyDir(dataPath('consciousness'), conOut, (src) => {
  const base = path.basename(src)
  if (base === 'app.db' || base.startsWith('app.db.')) return false
  if (!WITH_BACKUPS && base === 'backups') return false
  return true
})
console.log('  consciousness 其它 ' + conExtra + ' 个文件')

const small = ['memory', 'skills', 'storages', 'xiaoxi-heart']
let smallN = 0
for (const d of small) smallN += copyDir(dataPath(d), path.join(dataDir, d))
// 根级小文件：密钥、匿名 id、用量
for (const f of ['.credentials.yaml', '.anonymous-user-id', '.dshw-size.json', '.dshw-usage.json']) {
  const src = path.join(H, f)
  if (fs.existsSync(src)) {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.copyFileSync(src, path.join(dataDir, f))
    smallN++
  }
}
console.log('  小数据 ' + smallN + ' 个文件')

// 会话与附件：默认带，--lean 不带
if (!LEAN) {
  const sN = copyDir(path.join(H, 'sessions'), path.join(dataDir, 'sessions'))
  const aN = copyDir(path.join(H, 'attachments'), path.join(dataDir, 'attachments'))
  console.log('  sessions ' + sN + ' / attachments ' + aN + ' 个文件')
} else {
  console.log('  --lean：跳过 sessions / attachments')
}

// QQ 桥的运行数据（会话映射、记忆、图片索引），不带走日志和探针
const qqN = copyDir(dataPath('qq-bridge'), path.join(dataDir, 'qq-bridge'))
if (qqN) console.log('  qq-bridge ' + qqN + ' 个文件')

// NapCat 只带配置，不带 346MB 本体
const napcatOut = path.join(dataDir, 'napcat')
fs.mkdirSync(napcatOut, { recursive: true })
let napN = 0
for (const f of ['boot-qq.ps1', 'boot-qq.vbs', 'config.json', 'index.js', 'napcat.bat', 'watchdog.ps1', 'watchdog2.ps1', 'watchdog-loop.ps1']) {
  const src = path.join(H, 'napcat', f)
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(napcatOut, f))
    napN++
  }
}
console.log('  napcat 配置 ' + napN + ' 个文件（本体不带，恢复时重装）')

// ── 4. profile 配置 ──────────────────────────────────────────────────
console.log('\n[4/6] profile')
const profilesOut = path.join(dataDir, 'profiles')
const profileDir = path.join(H, 'profiles', 'desktop')
const profileN = copyFiles(profileDir, path.join(profilesOut, 'desktop'), [
  'package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'compatibility.json',
  'qq-sessions.json', 'qq-runtime.json', 'qq-catchup.json', 'qq-engage.json',
])
// patches 目录（如果有）
const patches = path.join(profileDir, 'patches')
if (fs.existsSync(patches)) copyDir(patches, path.join(profilesOut, 'desktop', 'patches'))
console.log('  文件 ' + profileN + ' 个（不含 node_modules）')

// ── 5. 同伴插件 ──────────────────────────────────────────────────────
console.log('\n[5/6] 同伴插件')
if (!NO_PLUGINS) {
  const pluginsOut = path.join(pkg, 'plugins')
  const sibling = path.dirname(R)
  for (const name of ['dsh-qq-onebot-bridge', 'dsh-video-skin-overlay-fix']) {
    const src = path.join(sibling, name)
    if (!fs.existsSync(src)) {
      console.log('  ! 缺 ' + name + '（profile 里还 link 着它，恢复要手补）')
      continue
    }
    const n = copyDir(src, path.join(pluginsOut, name))
    console.log('  ' + name + ' ' + n + ' 个文件')
  }
} else {
  console.log('  --no-plugins：跳过')
}

// ── 6. 恢复脚本 + 清单 ───────────────────────────────────────────────
console.log('\n[6/6] 恢复脚本与清单')
fs.copyFileSync(path.join(R, 'scripts', 'migrate-restore.mjs'), path.join(pkg, 'restore.mjs'))

const cmd = `@echo off
chcp 65001 >nul
cd /d "%~dp0"
node restore.mjs %*
echo.
pause
`
fs.writeFileSync(path.join(pkg, '一键恢复.cmd'), cmd, 'utf8')

const readme = `# 小汐搬家包

生成：${new Date().toISOString()}
来源：${os.hostname()} / ${os.userInfo().username}
DSH_HOME：${H}
仓库：${R}

## 怎么恢复

1. 新机器先装好 Node（≥22.5）和 DSH，并登录一次 DSH（让 ~/.dsh 生成）。
2. 把这个文件夹整个拷过去（U 盘 / 网盘都行），双击 **一键恢复.cmd**。
   也可以手动：\`node restore.mjs --repo <仓库放哪> --dsh-home <DSH_HOME>\`
3. 恢复脚本会：
   - 校验每个文件的 sha256；
   - 展开仓库、运行数据、profile 配置；
   - 把 profile 里写死的旧用户/旧路径改成这台机器的；
   - 旧库、旧仓库不删，先改名成 \`*.bak-before-restore-*\`。
4. 按它最后打印的下一步装依赖、启动、体检。

## 包里有什么

- \`repo/\` 仓库工作树快照（连未提交的改动一起，免得 11-07 那种「搬完少半天的活」）
- \`repo.bundle\` git 全历史（恢复时也可以只 clone 这个）
- \`data/consciousness/app.db\` VACUUM 出来的一致性快照（不带 WAL 碎片）
- \`data/sessions\`、\`data/attachments\` 对话原文和附件${LEAN ? '（本次 --lean，没带）' : ''}
- \`data/profiles/desktop\` profile 配置（不含 node_modules）
- \`data/napcat\` 只有配置，NapCat 本体要重装
- \`plugins/\` 同目录的 QQ 桥和皮肤修复插件
- \`manifest.json\` 文件清单 + sha256 + 库条数 + 来源机器

## 恢复后要自己做的

- \`pnpm install\`（仓库和 profile 各一次）
- 启动 DSH，打开「设置 → 意识」，确认记忆条数、心跳、页面
- QQ / 微信 / NapCat 重新登录一次
- 跑 \`node scripts/doctor.mjs\`；有问题先跑 \`node scripts/check-move-ready.mjs\`
`
fs.writeFileSync(path.join(pkg, 'README.md'), readme, 'utf8')

// ── manifest：逐文件 sha256 ──────────────────────────────────────────
console.log('\n计算校验和……')
const files = walkFiles(pkg).filter((f) => f !== 'manifest.json')
const items = []
let total = 0
for (const rel of files) {
  const p = path.join(pkg, rel)
  const st = fs.statSync(p)
  total += st.size
  items.push({ path: rel, bytes: st.size, sha256: await sha256(p), role: rel.startsWith('repo/') ? 'repo' : rel.startsWith('data/') ? 'data' : rel.startsWith('plugins/') ? 'plugin' : 'bootstrap' })
}

const manifest = {
  format: 'xiaoxi-move/1',
  createdAt: new Date().toISOString(),
  source: {
    hostname: os.hostname(),
    user: os.userInfo().username,
    platform: process.platform,
    dshHome: H,
    repoRoot: R,
    userHome: os.homedir(),
    pluginVersion: (() => { try { return JSON.parse(fs.readFileSync(path.join(R, 'package.json'), 'utf8')).version } catch { return null } })(),
    dshVersion: (() => {
      try { return JSON.parse(fs.readFileSync(path.join(H, 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'), 'utf8')).version } catch { return null }
    })(),
    node: process.versions.node,
    git: (() => { try { return execFileSync('git', ['--version'], { encoding: 'utf8' }).trim() } catch { return null } })(),
  },
  counts,
  dbIntegrity: integrity,
  gitBundle: bundleOk,
  lean: LEAN,
  items,
  totalBytes: total,
}

fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

// ── 收尾 ─────────────────────────────────────────────────────────────
const finalSize = sizeOf(pkg)
console.log('\n完成：' + pkg)
console.log('  文件 ' + (items.length + 1) + ' 个，共 ' + (finalSize / 1024 / 1024 / 1024).toFixed(2) + ' GB')
console.log('  校验：manifest 里每个文件都有 sha256；库 integrity=' + integrity)
console.log('  下一步：把整个文件夹拷到新机器，双击「一键恢复.cmd」')
