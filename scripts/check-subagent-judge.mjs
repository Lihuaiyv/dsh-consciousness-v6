/**
 * 子代理判决体检（2026-11-19）：宿主 subagents 服务还在不在、判不出的预警、会话账数量。
 * 只读真库。用法：node scripts/check-subagent-judge.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(path.join(ROOT, '..', 'runtime', 'consciousness', 'app.db'), { readOnly: true });
const q = (s, ...p) => db.prepare(s).all(...p);

let warn = 0;
const line = (ok, name, detail) => {
  if (!ok) warn++;
  console.log((ok ? 'PASS' : 'WARN') + ' ' + name + (detail ? ' — ' + detail : ''));
};

const probe = q("SELECT value FROM flags WHERE key='probe.subagents'")[0];
if (probe) {
  let p = {};
  try { p = JSON.parse(probe.value) } catch { p = {} }
  line(!!p.hasSub, '宿主 subagents 服务可达', p.hasSub ? '有 rootOf/listDescendants' : '拿不到（会退回 uuid 兜底）');
  line(Array.isArray(p.subMethods) && p.subMethods.includes('rootOf'), 'rootOf 方法在', JSON.stringify(p.subMethods));
} else {
  line(false, '宿主 subagents 探针', '还没写过（没重载 / preStep 没跑）');
}

const alert = q("SELECT value FROM flags WHERE key='alert.subagent.judge'")[0];
if (alert) {
  let a = {};
  try { a = JSON.parse(alert.value) } catch { a = {} }
  line(false, '子代理判决预警', JSON.stringify(a));
} else {
  line(true, '子代理判决预警', '没有未清的预警');
}

const kinds = q("SELECT key, value FROM flags WHERE key LIKE 'sessionKind.%'");
const subs = kinds.filter((r) => r.value === 'sub').length;
const mains = kinds.filter((r) => r.value === 'main').length;
line(true, '会话账', `main ${mains} / sub ${subs}（共 ${kinds.length}）`);

const subFrags = q("SELECT COUNT(*) c FROM fragments WHERE agent_id LIKE '%#sub'")[0].c;
line(true, '挂 #sub 的碎片', subFrags + ' 条');

console.log(warn ? `\n有 ${warn} 项要人看一眼` : '\n全绿');
if (warn) process.exitCode = 1;
