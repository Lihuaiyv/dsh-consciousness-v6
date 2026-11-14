// 用到才拉：本机嗓子（IndexTTS 薄壳）的启动器。
//
//   node scripts/ensure-voice.mjs           # 没起就起，起了就报已就绪
//   node scripts/ensure-voice.mjs --status  # 只看在不在
//   node scripts/ensure-voice.mjs --stop    # 停掉，把内存还回去
//
// 为什么不是开机常驻：模型加载完要 5.6 GB，机器只剩 5.8 GB 可用。
// 这个脚本只负责「要用了，几十秒内让它能说话」。
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const PORT = 9880;
const REPO = path.resolve(import.meta.dirname, '..');
const WS = path.dirname(REPO);
const INDEXTTS = path.join(WS, 'runtime', 'indextts');
const PY = path.join(INDEXTTS, '.venv', 'Scripts', 'python.exe');
const LOG = path.join(INDEXTTS, 'serve-now.log');
const WAIT_MS = 90_000;

const alive = () =>
  new Promise((resolve) => {
    const s = net.connect({ port: PORT, host: '127.0.0.1' });
    const done = (v) => { s.destroy(); resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(800, () => done(false));
  });

const pidOnPort = () => {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
    ], { encoding: 'utf8' }).trim();
    return Number(out) || 0;
  } catch { return 0; }
};

const stop = () => {
  const pid = pidOnPort();
  if (!pid) { console.log('9880 是空的，没有要停的'); return; }
  try { execFileSync('taskkill', ['/PID', String(pid), '/F']); } catch {}
  console.log(`已停 pid ${pid}（内存还回去了）`);
};

const status = async () => {
  const up = await alive();
  const pid = up ? pidOnPort() : 0;
  console.log(up ? `在听：127.0.0.1:${PORT}（pid ${pid}）` : `没在听：127.0.0.1:${PORT}`);
  return up;
};

const start = async () => {
  if (await status()) return true;
  if (!fs.existsSync(PY)) {
    console.error(`找不到 python：${PY}`);
    console.error('先确认 runtime/indextts/.venv 装好了');
    return false;
  }
  if (!fs.existsSync(path.join(INDEXTTS, 'serve.py'))) {
    console.error(`找不到 serve.py：${INDEXTTS}`);
    return false;
  }
  const fd = fs.openSync(LOG, 'a');
  const child = spawn(PY, ['serve.py', '--model-dir', '../models/indextts-2.5', '--port', String(PORT)], {
    cwd: INDEXTTS,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  child.unref();
  console.log(`起了壳（pid ${child.pid}），等它 listen…`);

  const t0 = Date.now();
  while (Date.now() - t0 < WAIT_MS) {
    await new Promise((r) => setTimeout(r, 500));
    if (await alive()) {
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`好了：${sec} 秒起来。`);
      console.log('第一次念会先加载模型（慢一次），之后快了。');
      console.log(`日志：${LOG}`);
      return true;
    }
  }
  console.error(`等了 ${WAIT_MS / 1000} 秒还没起来，去看日志：${LOG}`);
  return false;
};

const cmd = process.argv[2];
if (cmd === '--status') { await status(); }
else if (cmd === '--stop') { stop(); }
else { process.exitCode = (await start()) ? 0 : 1; }
