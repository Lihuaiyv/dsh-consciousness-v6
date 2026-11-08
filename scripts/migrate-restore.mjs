// 一键恢复：在新机器上把搬家包展开，并把所有路径改成这台机器的。
//
// 这个文件会随搬家包一起被带走，所以它不 import 仓库里的任何东西——
// 只依赖 Node 内置。搬家时最怕的就是「恢复脚本自己也找不到模块」。
//
// 用法（在搬家包目录里）：
//   node restore.mjs                        交互式
//   node restore.mjs --yes                  用默认路径，不再问
//   node restore.mjs --repo <仓库路径> --dsh-home <DSH_HOME 路径> --yes
//   node restore.mjs --skip-verify          跳过 sha256（不推荐）
//
// 原则：
//   - 不删旧东西：目标已有内容就先改名备份，再写新的；
//   - 不猜：任何一步失败就停，不半途覆盖；
//   - 只改白名单文件里的旧路径（profile 配置 + 两个 storages json）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const opt = (name, fallback = null) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const flag = (name) => args.includes(name)

const here = path.dirname(fileURLToPath(import.meta.url))
const manifestPath = path.join(here, 'manifest.json')
if (!fs.existsSync(manifestPath)) {
  console.error('这个目录里没有 manifest.json，不像是搬家包。')
  process.exit(1)
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const src = manifest.source || {}

const newUserHome = os.homedir()
const newDshHome = opt('--dsh-home') || process.env.DSH_HOME || path.join(newUserHome, '.dsh')
const newRepo = opt('--repo') || path.join(newUserHome, 'Desktop', 'ds', 'consciousness-v6')
const repoLink = opt('--link') || path.join(newUserHome, 'Desktop', 'ds', 'dsh-plugin')
const pluginsRoot = path.join(path.dirname(newRepo), 'plugins')

console.log('搬家包：' + (manifest.createdAt || '未知时间') + '  来自 ' + (src.hostname || '?') + ' / ' + (src.user || '?'))
console.log('  新 DSH_HOME : ' + newDshHome)
console.log('  新仓库       : ' + newRepo)
console.log('  桌面入口     : ' + repoLink)
console.log('  插件目录     : ' + pluginsRoot)
if (flag('--dry-run')) {
  console.log('\n--dry-run：只看计划，不写任何东西。')
}

async function confirm() {
  if (flag('--yes') || flag('--dry-run')) return true
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise((resolve) => rl.question('\n按上面的路径恢复？(y/N) ', resolve))
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

async function verify() {
  if (flag('--skip-verify')) {
    console.log('\n跳过校验（--skip-verify）。')
    return
  }
  const items = manifest.items || []
  console.log(`\n校验 ${items.length} 个文件……`)
  let bad = 0
  for (const it of items) {
    const p = path.join(here, it.path)
    if (!fs.existsSync(p)) {
      console.log(`  ✗ 缺文件 ${it.path}`)
      bad++
      continue
    }
    const size = fs.statSync(p).size
    if (typeof it.bytes === 'number' && size !== it.bytes) {
      console.log(`  ✗ 大小不对 ${it.path}（${size} ≠ ${it.bytes}）`)
      bad++
      continue
    }
    if (it.sha256) {
      const got = await sha256(p)
      if (got !== it.sha256) {
        console.log(`  ✗ sha256 不对 ${it.path}`)
        bad++
      }
    }
  }
  if (bad) {
    console.error(`\n有 ${bad} 个文件损坏/缺失，停止。整包重拷一次再说。`)
    process.exit(1)
  }
  console.log('  全部对得上。')
}

function backupIfExists(target, stamp) {
  if (!fs.existsSync(target)) return null
  const stat = fs.statSync(target)
  if (stat.isDirectory() && fs.readdirSync(target).length === 0) return null
  const bak = `${target}.bak-before-restore-${stamp}`
  fs.renameSync(target, bak)
  console.log('  旧内容已改名：' + bak)
  return bak
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  fs.cpSync(from, to, { recursive: true, force: true })
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const isDry = flag('--dry-run')

/* ── 0. 校验 ──────────────────────────────────────────────────────── */
if (!isDry) await verify()
if (!(await confirm())) {
  console.log('没动。')
  process.exit(0)
}
if (isDry) {
  console.log('\n计划：解 repo → ' + newRepo)
  console.log('     解 data → ' + newDshHome)
  console.log('     重建 profile 路径（' + (src.dshHome || '旧 DSH_HOME') + ' → ' + newDshHome + '）')
  process.exit(0)
}

/* ── 1. 仓库 ──────────────────────────────────────────────────────── */
console.log('\n[1/4] 仓库')
const repoPkg = path.join(here, 'repo', 'package.json')
if (fs.existsSync(repoPkg)) {
  fs.mkdirSync(path.dirname(newRepo), { recursive: true })
  backupIfExists(newRepo, stamp)
  copyDir(path.join(here, 'repo'), newRepo)
  console.log('  已展开：' + newRepo)
} else if (fs.existsSync(path.join(here, 'repo.bundle'))) {
  fs.mkdirSync(path.dirname(newRepo), { recursive: true })
  backupIfExists(newRepo, stamp)
  const { execFileSync } = await import('node:child_process')
  execFileSync('git', ['clone', path.join(here, 'repo.bundle'), newRepo], { stdio: 'inherit' })
  console.log('  已从 git bundle 克隆：' + newRepo)
} else {
  console.error('  包里既没有 repo/ 也没有 repo.bundle，停止。')
  process.exit(1)
}

// 桌面入口：junction 指向仓库，别在桌面再放一份副本
try {
  let existing = null
  try { existing = fs.lstatSync(repoLink) } catch { /* 不存在 */ }
  if (existing && existing.isSymbolicLink()) {
    fs.rmSync(repoLink, { force: true })
    fs.symlinkSync(newRepo, repoLink, 'junction')
    console.log('  桌面入口已重建：' + repoLink)
  } else if (!existing) {
    fs.mkdirSync(path.dirname(repoLink), { recursive: true })
    fs.symlinkSync(newRepo, repoLink, 'junction')
    console.log('  桌面入口已建：' + repoLink)
  } else {
    console.log('  桌面入口已存在且不是链接，没动：' + repoLink)
  }
} catch (e) {
  console.log('  ! 桌面入口没建成：' + e.message)
}

/* ── 2. 数据 ──────────────────────────────────────────────────────── */
console.log('\n[2/4] 数据 → ' + newDshHome)
const dataDir = path.join(here, 'data')
if (fs.existsSync(dataDir)) {
  // 库先单独备份，别被「目录整体改名」盖回去
  const dbFile = path.join(newDshHome, 'consciousness', 'app.db')
  if (fs.existsSync(dbFile)) {
    const bak = `${dbFile}.bak-before-restore-${stamp}`
    fs.renameSync(dbFile, bak)
    console.log('  旧库已改名：' + bak)
  }
  fs.mkdirSync(newDshHome, { recursive: true })
  fs.cpSync(dataDir, newDshHome, { recursive: true, force: true })
  console.log('  已展开。')
} else {
  console.log('  包里没有 data/，跳过。')
}

/* ── 3. 插件（qq bridge / 皮肤修复）──────────────────────────────── */
console.log('\n[3/4] 同目录插件')
const pkgPlugins = path.join(here, 'plugins')
if (fs.existsSync(pkgPlugins)) {
  fs.mkdirSync(pluginsRoot, { recursive: true })
  fs.cpSync(pkgPlugins, pluginsRoot, { recursive: true, force: true })
  console.log('  已展开：' + pluginsRoot)
} else {
  console.log('  包里没有 plugins/，跳过。')
}

/* ── 4. 重写 profile 里的旧路径 ──────────────────────────────────── */
console.log('\n[4/4] 重写路径')
const oldDsh = src.dshHome || ''
const oldRepo = src.repoRoot || ''
const oldUser = src.userHome || ''
const oldPlugins = oldRepo ? path.dirname(oldRepo) : ''

const norm = (p) => p.replace(/\//g, '\\')
const variants = (p) => [...new Set([p, norm(p), p.replace(/\\/g, '/')].filter(Boolean))]
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 一次性把所有旧路径换掉。
 * 关键：只扫原文，不扫上一步替换出来的新路径——否则新路径里若恰好含有旧前缀，
 * 会被换第二遍，路径越滚越长（2026-11-08 演练就踩到了这个）。
 */
function replaceMany(text, pairs) {
  const entries = []
  for (const [from, to] of pairs) {
    if (!from) continue
    for (const v of variants(from)) entries.push({ v, to })
  }
  if (entries.length === 0) return text
  // 长的优先，保证「家目录 + .dsh」先于「家目录」匹配
  entries.sort((a, b) => b.v.length - a.v.length)
  const re = new RegExp(entries.map((e) => esc(e.v)).join('|'), 'g')
  return text.replace(re, (m) => {
    const hit = entries.find((e) => e.v === m)
    return hit ? hit.to : m
  })
}

function rewriteFile(file, fn) {
  if (!fs.existsSync(file)) return false
  const before = fs.readFileSync(file, 'utf8')
  const after = fn(before)
  if (after !== before) {
    fs.writeFileSync(file, after, 'utf8')
    return true
  }
  return false
}

const profileDirs = fs.existsSync(path.join(newDshHome, 'profiles'))
  ? fs.readdirSync(path.join(newDshHome, 'profiles')).filter((n) => fs.statSync(path.join(newDshHome, 'profiles', n)).isDirectory())
  : []

let rewritten = 0
for (const profile of profileDirs) {
  const dir = path.join(newDshHome, 'profiles', profile)
  // package.json：link: 依赖改成本机路径
  const pkgFile = path.join(dir, 'package.json')
  if (rewriteFile(pkgFile, (text) => {
    let out = text
    // dsh-consciousness-v6 一定指新仓库
    out = out.replace(/("dsh-consciousness-v6"\s*:\s*")link:[^"]+(")/g, `$1link:${newRepo.replace(/\\/g, '/')}$2`)
    // 其它 link: 若包里有同名插件，指到新插件目录
    out = out.replace(/("([^"]+)"\s*:\s*")link:[^"]+(")/g, (m, a, name, b) => {
      if (fs.existsSync(path.join(pluginsRoot, name))) return `${a}link:${path.join(pluginsRoot, name).replace(/\\/g, '/')}${b}`
      return m
    })
    return out
  })) rewritten++

  // cordis.patch.yml：旧 DSH_HOME / 旧用户目录 / 旧插件目录
  const patchFile = path.join(dir, 'cordis.patch.yml')
  if (rewriteFile(patchFile, (text) => replaceMany(text, [
    [oldDsh, newDshHome],
    [oldPlugins, pluginsRoot],
    [oldUser, newUserHome],
  ]))) rewritten++
}

// storages 里两个会存旧路径的 json
for (const file of ['workspace.json', 'schedule.json']) {
  const p = path.join(newDshHome, 'storages', file)
  if (rewriteFile(p, (text) => replaceMany(text, [
    [oldRepo, newRepo],
    [oldDsh, newDshHome],
    [oldPlugins, pluginsRoot],
    // 旧桌面的 ds 目录跟着换用户
    [oldUser ? path.join(oldUser, 'Desktop', 'ds') : '', path.join(newUserHome, 'Desktop', 'ds')],
  ]))) rewritten++
}
console.log(`  改了 ${rewritten} 个文件（profile 配置 + workspace/schedule）`)

/* ── 收尾 ─────────────────────────────────────────────────────────── */
console.log('\n恢复完成。接下来按顺序做：')
console.log('  1) 装依赖（网络要通）：')
console.log(`       cd "${newRepo}" && pnpm install`)
console.log(`       cd "${path.join(newDshHome, 'profiles', 'desktop')}" && pnpm install`)
console.log('  2) 确认 junction / 插件链接：')
console.log(`       dir "${path.join(newDshHome, 'profiles', 'desktop', 'node_modules')}"`)
console.log('  3) 启动 DSH，打开「设置 → 意识」，看心跳和记忆条数')
console.log('  4) 体检：')
console.log(`       cd "${newRepo}" && node scripts/doctor.mjs`)
console.log('  5) NapCat / QQ / 微信这些要重新登录一次；包里的 napcat/ 只有配置，不含本体。')
console.log('\n有问题先跑 node scripts/check-move-ready.mjs，它会把断掉的线列出来。')
