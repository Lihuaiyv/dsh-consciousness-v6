# memory_items · 谁在写（2026-11-05）

> 由 `node scripts/audit-table-writes.mjs memory_items` 扫出来：**28 个写点**，7 个域。
> 盘法：先看「改的是哪些字段」，再看这组字段该归谁；不是一上来就拆表。

## 一、按「改什么」分五组

| 组 | 改的字段 | 谁在写（写点数） |
|---|---|---|
| 温度 | `temp_state` / `state_since` / `state_streak` | host `features.js`（4）、layers `temps.js`（2）、memory（1） |
| 热度 / 命中 | `heat` / `band` / `hits` / `last_hit_at` / `stability` / `last_decay_at` | layers `tiers.js`（2）、writegate `gate.js`（1）、memory（1） |
| 生命周期 | `invalid_at` / `status` / `deleted_at` / `text` / `version` | timeline（5） |
| 检索字段 | `search_text` / `fact_key` / `terms` / `entity_id` / `version` | writegate `enrich.js`（1）、`entities.js`（1）、`gate.js`（1）、memory（1） |
| 打分 | `importance` / `confidence` | selfhood `self_pattern.js`（2） |
| 搬库 | 整行增 / 删 / 导入 | memory（1）、ops（2） |

## 二、能看出什么

1. **不是所有人抢同一块**：温度、热度、生命周期、检索字段、打分，基本各改各的字段。真正重叠的是「memory 也会顺手写温度和检索字段」。
2. **ops 是搬库**：purge 的删、导入的整行写，不算业务写，记成例外。
3. **timeline 是生命周期**：作废 / 复活 / 改句 / 藏 / 删，全是 `invalid_at` 和 `status`，它有完整的事件留痕。
4. **最该先收的是小口子**：self_pattern 只改两个分数字段，最适合先拿它做示范。

## 三、收口顺序（一次一组，一个 commit）

1. **self_pattern（2 处）**：在 memory 加一个 `bumpSelfPattern(db, id, at)`，`self_pattern.js` 改调它。
2. **entities（1 处）**：加 `setMemoryEntity(db, id, entityId)`。
3. **enrich（1 处）**：加 `setMemorySearchFields(db, id, { key, terms, searchText })`。
4. **temps（2 处）+ host 的温度写（4 处）**：收成 `setMemoryTemp(db, id, state, at)`，host 那 4 处一起换。
5. **tiers（2 处）+ memory 自己的热度写**：收成 `setMemoryHeat(db, id, heat, band)` / `touchMemoryHit(...)`。
6. **timeline（5 处）**：收成 `invalidateMemory` / `reactivateMemory` / `reviseMemory` / `hideMemory` / `unhideMemory` / `deleteMemory`；事件留痕跟着搬。
7. **gate（2 处）**：强化计数与检索字段，等第 3 步的写入函数齐了再合并。
8. 收完后：ownership 里 `memory_items` 的 `writes` 只留 `memory`；ops / host 写进例外清单。

## 四、每步都要过的卷

- 同一行写前写后一致（字段值、版本号）。
- 老库没有新列时不炸（沿用原来的 try / catch 语义）。
- 事件留痕不丢（timeline 的 INVALIDATE / REVISE 等）。
- 全量 561/561 不掉；相关测试（timeline / self-pattern / gate）不掉。
- `node scripts/audit-table-writers.mjs` 里 `memory_items` 的写手数往下减。

## 五、先不做

- 不改表结构、不合并表、不改语义。
- 不在收口时顺手改行为；行为要改，另开一次「换」并写活论证。

## 六、进展

- **2026-11-05 · 第 1 步**：`self_pattern` 那 2 处已收——`memory.js` 新增 `bumpSelfPattern(db, id, at)`（原 SQL 原样搬进去，行为不变），`self_pattern.js` 改调它。`memory-items` 写手 **7 → 6**（selfhood 退出）；self-pattern 测试 27/27。
- **2026-11-05 · 第 2 步**：`entities` 1 处、`enrich` 1 处已收——`memory.js` 新增 `setMemoryEntity` / `setMemorySearchFields`，两个模块改调它们。写 `memory_items` 的**文件从 10 个降到 7 个**、域 6 个；全量 561/561。
- 注意：写点**条数**还是 28——SQL 是搬进 memory 了，不是消失。看收口进度要看「谁在写」（文件 / 域），不看条数。
- 另：`test/recall-freshness.test.mjs` 有 1 条红（「S1 不扩二跳」），在 HEAD 的独立工作树里也一样红，不是这两步改坏的；另开一件查。
- 下一步：`temps` 2 处 + `features.js` 的温度写 4 处（一起收成 `setMemoryTemp`）。
