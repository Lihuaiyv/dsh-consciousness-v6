# 改动 · chat_turns 补 turn_id（P1c）· 2026-11-13

> 目标：让「这句话 → 哪句原话」能一条 SQL 走通。
> 之前 chat_turns 是 `cht_*` 自己一套 id，没有 turn_id 列；记忆/证据全挂 fragments 的 `turn_*`，两边只能靠 conversation_id + 时间猜。

## 动了什么

| 文件 | 改动 |
|---|---|
| `src/db.js` | `chat_turns` 建表加 `turn_id TEXT`；老库 `ALTER TABLE` 补列 + `idx_chat_turn(agent_id, turn_id)` 索引 |
| `src/modules/turn_write.js` | `writeChatTurns` 接受 `turnId`，两行都写入 |
| `index.js` commitTurn | 传 `turnId: tid`（网页 / QQ 桥那条链本来就有轮次号） |
| `src/features.js` chatReply | 把轮次号提前生成（`canLearn ? nid('turn_') : null`），写 chat_turns 时带上；后面 appendTurn / addMemory 用同一个号 |

## 口径

- 新写入 100% 带 `turn_id`；**老行留 NULL = 明确「无链」**，不猜、不回填（回填只能靠时间近似，那不如不猜）。
- 陌生人（`canLearn=false`）不生成轮次号——那本来就不进长期记忆。
- `cht_*` 仍是 chat_turns 主键，人格判定（persona_judge）继续挂它；只加列不改 id。

## 怎么验

- `node scratch/test-turn-write.mjs`：
  - 两行 role 正确；user 的 pack/mood/conversation_id 都在；
  - **两行的 `turn_id` 都是 `turn_test_1`**。
- 门禁：`node test/run-tests.mjs` → **561 / 561，exit=0**。

## 怎么退

- 不写 `turnId` 即可（列留着不碍事）；或删列（SQLite 老版本不支持 DROP COLUMN，实际做法是停止写入）。
- 无数据迁移、无内容改动。

## 下一步

- P2 收写：先做「停每轮 episode」的开关（默认旧行为）+ 基线统计；等切事在真库稳定跑一晚、事件覆盖够，再切默认。
- P3 收读：planner 候选池（那时 `surface.direct` 可以永久删掉）。
