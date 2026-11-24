# scripts/diag —— 诊断入口

一个文件，按子命令跑。别再往 scratch 里散脚本了。

```powershell
node scripts/diag/diag.mjs <子命令>
```

| 子命令 | 看什么 | 用不用真库 |
|---|---|---|
| `heartbeat` | 心跳账（每跳 `last_ms`，正常几十毫秒）+ 几张关键表行数 | 只读 |
| `purge` | 存储体检的「上次跑了」有没有落库 | 只读 |
| `audit` | `auditStore` 三次耗时（改前 34 秒，现在应 <100ms） | 复制副本 |
| `surface` | 浮现队列那条查询加索引前后（改前 9896ms，现在应 <10ms） | 复制副本 |
| `freeze` | 进程级趋势：内存、页错误、磁盘、探活失败次数 | 只读 |
| `breath` | 呼吸哨兵自检：故意堵主线程 3 秒，看它记不记得下来 | 临时文件 |
| `stage` | 段落探针自检：堵住 2 秒，看报不报 `eventloop-stall` | 临时文件 |

复制副本的那两个跑完会自己删，不占地方。

## 判据（别看错）

- **真卡死** = 探活超时：`runtime/consciousness/freeze-watch.jsonl` 里 `pingFails` 涨、`ping` 2.5 秒超时。
- **不是卡死** = `stallMs` 变大但探活正常。没人说话时插件本来就不写日志，`stall` 照样涨。

## 相关日志（只读）

- `runtime/consciousness/freeze-probe.jsonl` — 呼吸哨兵：主线程停摆 ≥2s 才记，带内存、WAL、当时停在哪一段
- `runtime/consciousness/stage.log` — 段落进出时间线（`se:in` / `se:done` / `prestep` / `affect`）
- `runtime/consciousness/hook.log` — `hb <段> ms=` 心跳逐段计时，单段 ≥50ms 才打
- `runtime/consciousness/freeze-watch.jsonl` — 每 10 秒进程级采样

背景和结论见 `docs/功能/8-工程-门禁与文档/卡死排查-2026-11-22.md`。
