/**
 * 写完一帧就把它算掉（向量 / 偏离 / drift），不再等 5 分钟心跳。
 *
 * 为什么用 python 子进程，而不是把 embedding 搬进 node：
 *   实测冷启动 import 1.08 s + 加载模型 0.28 s + 编码一句 11 ms ≈ 1.4 s。
 *   这活发生在**回完话之后**，不占开口那一秒；而 onnxruntime-node 这条路，
 *   除了原生依赖，还得自己带 tokenizer、做池化、跟 python 侧的 512 维逐位对拍，
 *   是一天的活，风险还压在「装不上」上。先用 1.4 秒把「等 5 分钟」消掉。
 *
 * 开关：frame.compute，'off' 才关（默认开）。关了以后只剩心跳兜底。
 * python 路径可配：frame.python，缺省用 dsh-bci-bridge 的 venv。
 *
 * 并发：补算会整份重写 frames_v2.jsonl，两个一起跑会互相盖掉，
 *   所以用 .compute.lock 占坑；锁超过 60 s 视作残留（进程被杀了），可以抢。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getFlag } from '../kernel.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROTO = path.resolve(HERE, '../../scratch/proto')
const DEFAULT_PY = 'D:\\deepseek_local\\plugins\\dsh-bci-bridge\\.venv\\Scripts\\python.exe'
const LOCK = path.join(PROTO, '.compute.lock')
const LOCK_STALE_MS = 60_000

/** 起一个后台补算。返回 true = 真起了，false = 跳过（关着 / 没脚本 / 已有在跑）。 */
export function kickFrameCompute(db) {
  try {
    if (String(getFlag(db, 'frame.compute') || 'on') === 'off') return false
    if (!fs.existsSync(path.join(PROTO, 'frame_writer.py'))) return false

    try {
      const st = fs.statSync(LOCK)
      if (Date.now() - st.mtimeMs < LOCK_STALE_MS) return false
    } catch { /* 没锁就跑 */ }

    try {
      fs.writeFileSync(LOCK, String(Date.now()))
    } catch {
      return false
    }

    const py = String(getFlag(db, 'frame.python') || DEFAULT_PY)
    const child = spawn(py, ['frame_writer.py', 'backfill'], {
      cwd: PROTO,
      env: { ...process.env, HF_ENDPOINT: 'https://hf-mirror.com', PYTHONIOENCODING: 'utf-8' },
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
    })
    child.on('exit', () => {
      try { fs.rmSync(LOCK, { force: true }) } catch { /* 删不掉就算了，会自己过期 */ }
    })
    child.on('error', () => {
      try { fs.rmSync(LOCK, { force: true }) } catch { /* same */ }
    })
    child.unref()
    return true
  } catch {
    return false
  }
}
