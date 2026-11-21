> ⚠️ **已废弃（2026-11-17）**：本文描述的切事件做法整体作废，不要照着做。
> 新基石（唯一入口）：`docs/功能/2-记忆-写与切事/切事件-基石/基石-切事件-2026-11-17.md`。本文只作历史。

# 改动 · 停「工作段摘记」（work-digest）· 2026-11-16

## 一句话

把 `memory_items` 里 `source='work-digest'` 那一路停掉。它不在 `记忆库.xmind` 上，是代码里另塞进事实库的第二种原话。

## 为什么

- 图（`C:\Users\l\Desktop\记忆库.xmind`）里往事实库写原话的只有一格「每轮原话 episode（source=manual）」，而且已经标了「待删，未来将替换为事件 cold_events / hot_events」。
- `work-digest` 是同一类：`features.js:536` 把工作段的一两句原话拼成 `工作段：…` 再 `addMemory` 一次。
- 实测（11-16 19:0x，真库只读）：1,618 条里 **526 条短于 15 字**（「工作段：好」「工作段：啥意思」——关键词没挑到时的兜底），真正挑出多句的只有 **59 条**。

## 动了哪

| 文件 | 改动 |
|---|---|
| `src/modules/memory_switch.js` | 新增 `workDigestEnabled(db)`：读 `flags.memory.workdigest.write`，只有值 `off` 才停；缺省/异常一律 true（旧行为） |
| `src/features.js` | `:42` 导入它；`:664` 调用点改成 `if (workDigestEnabled(db)) workDigest(...)` |
| 真库 `runtime/consciousness/app.db` | `flags` 插一行 `memory.workdigest.write=off`（备份：`scratch/backup/app-2026-11-16-1908.db`） |

函数体、表、旧数据都没删。

## 怎么验

1. 门禁 `node test/run-tests.mjs` 全过。
2. 24h 后只读查：`SELECT COUNT(*) FROM memory_items WHERE source='work-digest' AND created_at >= '<翻开关时间>'`，应为 **0**。
3. 同时看 `memory.episode.write` 那一路仍为 0（11-15 18:15 起已在跑）。

## 怎么退

删掉 `flags` 里 `memory.workdigest.write` 那一行即可，不用改代码、不用重启（每次写入现读）。

## 旧数据怎么算

1,618 条留在库里不动——它们已经在事实库里，删了「那时候说过什么」就真查不到。要清走「忘」链（HIDE 级联），另排，不和停写同一天做。

## 图要不要改

不用。`work-digest` 本来就不在图上；图上那格「每轮原话 episode」的「待删」是另一件事，等事件库接管再动。
