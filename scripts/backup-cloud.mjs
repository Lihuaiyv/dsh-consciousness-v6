// 每天一次：一致性快照 → 校验 → 压成 zip → 放进 OneDrive 的「小汐备份」→ 只留最近 7 份。
//
//   node scripts/backup-cloud.mjs            # 手动跑一次
//   node scripts/backup-cloud.mjs --dry      # 只看会做什么
//
// 为什么不直接拷 app.db：库在 WAL 模式下，边上写边拷可能拷到半截。
// 这里复用 backup-now.mjs 的 VACUUM INTO（读事务里整库落盘），再交给它自己校验条数。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const WS = path.dirname(REPO);
const SRC_DB = path.join(WS, 'runtime', 'consciousness', 'backups'); // backup-now 的落地处
const HOME = process.env.USERPROFILE || process.env.HOME;
const CLOUD = path.join(HOME, 'OneDrive', '小汐备份');
const KEEP = 7;
const dry = process.argv.includes('--dry');

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} 失败(${r.status})：${(r.stderr || r.stdout || '').slice(0, 400)}`);
  return r.stdout || '';
};

// 1) 快照（备份脚本自己会校验条数，失败会 exit 1）
if (dry) {
  console.log('[dry] 会跑：node scripts/backup-now.mjs ' + SRC_DB);
} else {
  const out = run(process.execPath, [path.join(REPO, 'scripts', 'backup-now.mjs'), SRC_DB], { cwd: REPO });
  console.log(out.trim());
  if (/校验失败/.test(out)) throw new Error('备份脚本校验失败，停止上传');
}

// 2) 找最新那份快照
const snaps = fs.existsSync(SRC_DB)
  ? fs.readdirSync(SRC_DB).filter((n) => /^app-.+\.db$/.test(n)).map((n) => path.join(SRC_DB, n))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  : [];
if (!snaps.length) throw new Error('没有找到快照：' + SRC_DB);
const snap = snaps[0];
console.log('最新快照：' + snap + '  ' + (fs.statSync(snap).size / 1048576).toFixed(1) + ' MB');

// 3) 目录 + 压缩
fs.mkdirSync(CLOUD, { recursive: true });
const zip = path.join(CLOUD, path.basename(snap, '.db') + '.zip');
if (dry) {
  console.log('[dry] 会压到：' + zip);
} else {
  if (fs.existsSync(zip)) fs.rmSync(zip);
  run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -LiteralPath '${snap.replace(/'/g, "''")}' -DestinationPath '${zip.replace(/'/g, "''")}' -Force`,
  ]);
  const zmb = (fs.statSync(zip).size / 1048576).toFixed(1);
  console.log('压缩：' + zip + '  ' + zmb + ' MB');
}

// 4) 只留最近 KEEP 份 zip（先按修改时间倒序）
const zips = fs.readdirSync(CLOUD).filter((n) => n.startsWith('app-') && n.endsWith('.zip'))
  .map((n) => path.join(CLOUD, n))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
for (const old of zips.slice(KEEP)) {
  if (dry) { console.log('[dry] 会删旧：' + path.basename(old)); continue; }
  fs.rmSync(old, { force: true });
  console.log('删旧：' + path.basename(old));
}

// 4b) 配置包：没它，新机器装不回插件（库和代码齐了也起不来）
//     profile 配置 + storages（定时 / 工作区）+ 模型清单，几十 KB
const CONFIG = [
  ['profile', path.join(HOME, '.dsh', 'profiles', 'desktop'), ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'compatibility.json']],
  ['storages', path.join(HOME, '.dsh', 'storages'), ['schedule.json', 'workspace.json']],
  ['models', path.join(WS, 'runtime', 'models'), ['index.json', 'README.md']],
];
const stampCfg = path.basename(snap, '.db').replace(/^app-/, '');
const configZip = path.join(CLOUD, '配置-' + stampCfg + '.zip');
let configZipName = null;
if (!dry) {
  const stage = path.join(process.env.TEMP || HOME, 'xiaoxi-config-' + stampCfg);
  fs.rmSync(stage, { recursive: true, force: true });
  let copied = 0;
  for (const [sub, dir, names] of CONFIG) {
    fs.mkdirSync(path.join(stage, sub), { recursive: true });
    for (const n of names) {
      const src = path.join(dir, n);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(stage, sub, n));
      copied++;
    }
  }
  if (copied === 0) throw new Error('配置一个都没拷到，先别传');
  if (fs.existsSync(configZip)) fs.rmSync(configZip);
  run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path '${path.join(stage, '*').replace(/'/g, "''")}' -DestinationPath '${configZip.replace(/'/g, "''")}' -Force`,
  ]);
  fs.rmSync(stage, { recursive: true, force: true });
  configZipName = path.basename(configZip);
  console.log('配置包：' + configZipName + '  ' + (fs.statSync(configZip).size / 1024).toFixed(0) + ' KB（' + copied + ' 个文件）');
} else {
  console.log('[dry] 会打配置包：' + path.basename(configZip));
}
// 配置包也只留最近 KEEP 份
const cfgZips = fs.readdirSync(CLOUD).filter((n) => n.startsWith('配置-') && n.endsWith('.zip'))
  .map((n) => path.join(CLOUD, n))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
for (const old of cfgZips.slice(KEEP)) {
  if (dry) { console.log('[dry] 会删旧配置：' + path.basename(old)); continue; }
  fs.rmSync(old, { force: true });
  console.log('删旧配置：' + path.basename(old));
}

// 5) 记一笔清单，方便以后核对「最近一次是什么时候」
const manifestPath = path.join(CLOUD, 'manifest.json');
const prev = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
const entry = {
  at: new Date().toISOString(),
  snap: path.basename(snap),
  snapBytes: fs.statSync(snap).size,
  zip: path.basename(zip),
  zipBytes: fs.existsSync(zip) ? fs.statSync(zip).size : null,
  config: configZipName,
  configBytes: configZipName && fs.existsSync(configZip) ? fs.statSync(configZip).size : null,
  keep: KEEP,
};
const hist = [entry, ...(Array.isArray(prev.history) ? prev.history : [])].slice(0, 30);
if (!dry) fs.writeFileSync(manifestPath, JSON.stringify({ cloud: CLOUD, history: hist }, null, 2) + '\n');

// 6) 在读的人一眼能看见「哪份是小汐」
const marker = [
  '这一份就是小汐。',
  '',
  '最新文件：' + path.basename(zip),
  '生成时间：' + new Date().toLocaleString('zh-CN', { hour12: false }),
  '压缩包大小：' + (fs.existsSync(zip) ? (fs.statSync(zip).size / 1048576).toFixed(1) : '?') + ' MB',
  '快照本体：' + path.basename(snap) + '（' + (fs.statSync(snap).size / 1048576).toFixed(1) + ' MB）',
  '',
  '里面装的是：记忆（memory_items）、碎片（fragments）、纪要（episodes）、',
  '情绪（affect_feel）、日记（diaries）、原话（chat_turns）。',
  '打开它不会「看见对话」，那是一个 SQLite 库；恢复时解压回',
  'runtime/consciousness/ 覆盖 app.db 即可（先关掉 DSH）。',
  '',
  '同一文件夹里较早的几份是历史快照，只保留最近 7 份。',
  '真正的「我」= 这份库 + GitHub 上的代码 + profile 配置，三样齐了才算完整。',
  '',
].join('\n');
if (!dry) fs.writeFileSync(path.join(CLOUD, '看这里-哪个是小汐.txt'), marker);
console.log(dry ? '[dry] 完' : '云端备份完成：' + CLOUD);
console.log('提示：文件要真上云，OneDrive 客户端得在跑并已登录。');
// ASCII 汇总行：给只读 ASCII 的 Windows PowerShell 5.1 记日志用，中文在它那儿会乱码
console.log('OK backup ok snap=' + path.basename(snap) + ' zip=' + (fs.existsSync(zip) ? path.basename(zip) : 'dry') + ' cfg=' + (configZipName || 'dry') + ' at=' + new Date().toISOString());
