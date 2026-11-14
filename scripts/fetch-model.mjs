/**
 * 拉一个模型权重进 runtime/models/，并顺手把 manifest 写全（含每个文件的 sha256）。
 *
 * 用法（在 dsh-consciousness-v6 目录下）：
 *   node scripts/fetch-model.mjs --repo IndexTeam/IndexTTS-2.5 \
 *     --dir ../../runtime/models/indextts-2.5 --name indextts-2.5 --version 2.5 \
 *     --license "bilibili Model Use License Agreement" --purpose "出声：零样本克隆"
 *
 * 默认走国内镜像 https://hf-mirror.com；想换源就设 HF_ENDPOINT。
 * 已存在且大小对得上的文件会跳过；下完写 manifest.json。
 * 只拉权重，不装 Python 环境、不跑模型。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const args = process.argv.slice(2)
function arg(name, fallback = '') {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const repo = arg('repo')
const dir = path.resolve(process.cwd(), arg('dir'))
const name = arg('name', path.basename(dir))
const version = arg('version', '')
const license = arg('license', 'other（以模型卡为准，商用前必须核实）')
const purpose = arg('purpose', '')
const base = (process.env.HF_ENDPOINT || 'https://hf-mirror.com').replace(/\/+$/, '')

if (!repo || !arg('dir')) {
  console.error('用法：node scripts/fetch-model.mjs --repo 组织/模型 --dir 目标目录 [--name --version --license --purpose]')
  process.exit(2)
}

async function listFiles() {
  const res = await fetch(`${base}/api/models/${repo}/tree/main?recursive=1`, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`列文件失败 HTTP ${res.status}`)
  const rows = await res.json()
  return rows.filter((r) => r.type === 'file').map((r) => ({ path: r.path || r.rfilename, size: r.size || 0 })).filter((r) => r.path)
}

async function sha256Of(file) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    fs.createReadStream(file).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject)
  })
}

async function download(file) {
  const target = path.join(dir, file.path)
  if (fs.existsSync(target) && file.size && fs.statSync(target).size === file.size) {
    return { path: file.path, bytes: file.size, skipped: true }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const url = `${base}/${repo}/resolve/main/${file.path.split('/').map(encodeURIComponent).join('/')}?download=true`
  // 镜像会 429：退避重试，别把一个 5G 的下载卡在某个小文件上。
  let res = null
  for (let attempt = 1; attempt <= 5; attempt++) {
    res = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) })
    if (res.ok) break
    if (res.status === 429 || res.status >= 500) {
      const wait = Math.min(60, 2 ** attempt) * 1000
      console.log(`  ${file.path} HTTP ${res.status}，${wait / 1000}s 后重试（${attempt}/5）`)
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    throw new Error(`${file.path} HTTP ${res.status}`)
  }
  if (!res || !res.ok) throw new Error(`${file.path} 重试 5 次仍失败 HTTP ${res?.status}`)
  const tmp = target + '.part'
  const hash = crypto.createHash('sha256')
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp)
    const reader = res.body.getReader()
    const pump = () => reader.read().then(({ done, value }) => {
      if (done) { out.end(); return }
      hash.update(value)
      if (!out.write(Buffer.from(value))) return out.once('drain', pump)
      pump()
    }).catch(reject)
    out.on('error', reject)
    out.on('finish', resolve)
    pump()
  })
  fs.renameSync(tmp, target)
  return { path: file.path, bytes: fs.statSync(target).size, sha256: hash.digest('hex'), skipped: false }
}

function fmt(n) {
  return n > 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + 'G' : (n / 1024 ** 2).toFixed(1) + 'M'
}

async function main() {
  console.log(`拉 ${repo} → ${dir}（源 ${base}）`)
  fs.mkdirSync(dir, { recursive: true })
  const files = await listFiles()
  const total = files.reduce((s, f) => s + (f.size || 0), 0)
  console.log(`共 ${files.length} 个文件，约 ${fmt(total)}`)
  const done = []
  let i = 0
  for (const file of files) {
    i++
    const t0 = Date.now()
    const r = await download(file)
    done.push(r)
    console.log(`[${i}/${files.length}] ${r.skipped ? '跳过' : '下好'} ${r.path} ${fmt(r.bytes)} ${r.skipped ? '' : ((Date.now() - t0) / 1000).toFixed(1) + 's'}`)
    // 小文件也留口气，别把镜像的限流惹急。
    await new Promise((r2) => setTimeout(r2, 1200))
  }
  const manifest = {
    name,
    version: version || undefined,
    source: `https://huggingface.co/${repo}`,
    mirror: `${base}/${repo}`,
    license,
    downloaded_at: new Date().toISOString().slice(0, 10),
    purpose: purpose || undefined,
    files: done.map((r) => ({ path: r.path, sha256: r.sha256 || null, bytes: r.bytes })),
  }
  // 跳过过的文件没算 sha256：补算一遍，manifest 里 sha256 不能是 null。
  for (const f of manifest.files) {
    if (!f.sha256) f.sha256 = await sha256Of(path.join(dir, f.path))
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  const missing = manifest.files.filter((f) => !f.sha256).length
  console.log(`完成：${manifest.files.length} 个文件，sha256 缺失 ${missing}；manifest 已写 ${path.join(dir, 'manifest.json')}`)
}

main().catch((e) => {
  console.error('失败：' + (e && e.message ? e.message : e))
  process.exitCode = 1
})
