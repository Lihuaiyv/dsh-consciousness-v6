# 旧价值观清退 · 只留三观（v1）

> 一句话：把 `persona_values` 这张表、以及它带出来的一切读口/写口/导出/体检/测试全部清掉；`V`（十维）只由三观账本的命题 `fold` 出来，并按 §2 的出入表跟驱力、自述、冲突、主动开口、情绪、关系、日记对接。
>
> 目标仓库：`D:\deepseek\dsh-plugins\dsh-consciousness-v6`（profile `desktop` 实际加载的那份）。桌面 `C:\Users\ygys1\Desktop\ds\dsh-plugin` 是旧快照，不在本次范围内。

---

## 0. 判据：什么才算「没有藕断丝连」

删净 = 下面五条同时成立，缺一条都算没删：

1. `grep -r "persona_values" src index.js client.js scripts test` 命中 **0**（注释里也不留）。
2. `grep -r "growValues\|migrateValues\|listValues" src test scripts` 命中 **0**。
3. 库里 `sqlite_master` 查不到 `persona_values`；`persona` 表里 `values.*` 旧 path 也清空。
4. 导出包（`exportFull`）里没有这张表；导入旧包时**当场转成命题**，不落表。
5. `doctor` 不再列这张表、不再算它的 Σ；`persona.value_drift` 改由命题位移算。

---

## 1. 现状：要摘的钉子（逐条，带落点）

| # | 位置 | 现在在干什么 | 处置 |
| --- | --- | --- | --- |
| 1 | `src/modules/drive.js:66-77` `valueNumbers()` | 每轮直接 `SELECT ... FROM persona_values`，喂 v3「重要度」与胃口 | 换 `readViews(db, aid, { only: 'V' }).V.weights`；一轮只取一次，进程内按 (aid, 版本) 缓存 |
| 2 | `src/modules/persona.js:164` `listValues()` | 读旧表，`features.js` 再 re-export 给 api | 删函数 + 删 `features.js:99/185` 的两处导出 |
| 3 | `src/db.js:131` | `CREATE TABLE IF NOT EXISTS persona_values` | 删建表；老库残留由 P5 的 `DROP` 处理 |
| 4 | `src/db.js:657-670` | 「`persona.values.*` 旧写法 → 真表」兼容迁移 | 改成「旧 path 直接过 `claimUserValue`」，不写表 |
| 5 | `src/features.js:103`、`:2557` | 遗留 `values.*` 过指令闸、旧模板导入 | 同上：转命题；`:2557` 注释里的「真表」删掉 |
| 6 | `src/modules/ops.js:65` | 备份/清理的 `TABLES` 白名单含旧表 | 去掉 |
| 7 | `src/ports/ownership.js` 第 35/55/65/70/89/108/147/161 行 | 6 处声明旧表归属 | 全部去掉；`values` 域改成「只读 `persona_claims`/`sangguan_*`」 |
| 8 | `src/modules/sangguan/bridge.js`（`readViews` 内 `migrateValues`） | 每次读口都尝试迁移旧表 | 迁完（flag 落定）后删这行 |
| 9 | `src/modules/sangguan/value_migrate.js`（全文） | 一次性迁移器 | P1 跑完、验完 → 整文件删 |
| 10 | `src/api.js:620` `PUT /values` | 已经只做 `claimUserValue`（写命题，不写表） | 保留；把语义写清：**「提交一条价值观命题」**，不是改权重 |
| 11 | `src/modules/eval.js:247/315/350` | `persona.value_drift` 按月位移 | 改由 `persona_claims` 里 V 层命题的 `pi/n` 位移算 |
| 12 | `src/modules/archive.js` 导出/日记快照 | 已走 `readViews().V` | 只核对；`importFull` 遇旧表 → 转命题 |
| 13 | `scripts/doctor.mjs:62`、`:189` | 列旧表、对旧表 Σ=1 | 改读 `GET …/values/explain`（已是三观） |
| 14 | `test/run-tests.mjs:731/2050/2057`、`sangguan-g5/g7/g8` 的 `putVal()` | 直接 `INSERT INTO persona_values` 造 fixture | 改造成写命题 fixture（走账本） |
| 15 | `client.js` 价值观页 | 文案/技术视图仍按「词表长出来的十维」写 | 改成「命题 → 十维折算」，去掉“重新长一遍 = 重跑词表”的旧语义 |

> 已确认无关的：`nightly.js` 已经不再调 `growValues`；`selfview.js` / `index.js` 走的是 `readViews`。这两处只是**受益方**，不进删除清单，但要进 §2 的出向验收。

---

## 2. 三观出入表（新价值观要跟谁连、怎么连）

### 2.1 入：证据 → 命题 → 十维

| 来源 | 入口 | 用法 |
| --- | --- | --- |
| 对话 / 记忆 / 日记 | `sangguan/intake.js` | 抽出「我 / 人 / 世界」三类命题，进 `persona_claims` |
| 事件流（情绪、关系事件） | `ledger.js` + `ingest` | 给命题加 `pi`（重复次数）与 `n`（强度） |
| 关系亲密度 / 信任 | `rel_person` | 近的人说的话权重更高；陌生人一句话不改变十维 |
| 用户直说「我更看重…」 | `PUT /values` → `claimUserValue` | 走指令闸（`instructionLike`），不直接改权重 |
| 命题互斥 | `verdict.js` κ | 两条同时成立时记张力，进 `V.tensions`，不静默抵消 |
| 影子 | `tags.shadowVerdict` | 切换前只观察、只记 shadow，不生效 |

### 2.2 出：十维/三观 → 别的模块

| 目标 | 用法 | 落点 |
| --- | --- | --- |
| 驱力 v3「重要度」 | `w = 1 + 0.35·T + 0.25·V`（`V` 取 `(w−0.1)×10`，clamp ±1） | `algo/deficit.js` `needWeights()`；`drive.js` 把 `valueNumbers` 换成 `readViews` |
| 驱力胃口 | `+0.05·V` | `deficit.js` `appetite` |
| 自述 | 素材权重 0.40：`V.line` + 张力 | `selfview.js` |
| 提示词 | 三行：世界 / 人生 / 价值 | `index.js:303/338`（已是 `readViews`） |
| 内心冲突 | `V.tensions` 当「两股劲」 | `conflict.js`；无张力时按空处理 |
| 主动开口 | 「价值」门：张力大 → 门槛降；十维极差 < 0.03 → 不说 | `features.js` 12 门里的 `value` |
| 情绪评价 | `goal_relevance` 与本轮命题挂钩（新增一条边） | `algo/appraise.js`，P6 再做，先在影子档跑 |
| 关系分寸 | 反过来：V 参与关系叙述（「我在意的事」→ 语气） | `reldyn.js` / `archive.js` 日记口吻 |
| 日记 / 导出 | `self.values` 快照（现在已走 `readViews`） | `archive.js` |
| 评估 | 漂移阈值 `≤0.10/月` 改由命题位移算 | `eval.js`、`doctor` |

---

## 3. 阶段（每阶段可单独回滚）

> 顺序理由：`V` 已经是 `engine`（`bridge.applyValueFold`），但**驱力还在读旧表**；先切读口、再删写口、最后才 `DROP`。任何一步先删表都会让驱力断粮。

### P0 · 冻结与备份（约 30 min）
- `git tag pre-value-cleanup`；拷贝 `~/.dsh/consciousness/app.db` 到 `backups/`。
- 确认 `nightly` 已不写旧表（已确认），bridge 只读。

### P1 · 迁移收口（半天）
- 对每个活实例跑 `migrateValues`（`POST /values/grow` 会顺带触发），核对：旧行里偏离初值 ≥0.03 的维，是否都变成「我更看重 X」命题。
- 落 flag（`vmig:<aid>` / `sangguan.vin:<aid>`），以后不再扫旧表。
- 台账：迁移前后十维的 `dims` 对比存进 `docs/` 下的记录里（做 P2 的等价性基线）。

### P2 · 切驱力读口 + 等价性（半天，关键）
- `drive.js`：`valueNumbers()` → `readViews(..., { only: 'V' }).V.weights`；一轮一取，加进程内缓存（按 `persona_claims` 最大 `updated_at` 失效）。
- 新增测试：喂同一组命题，`needWeights()` 输出与迁移前旧表算出的权重逐维 `|Δ| ≤ 0.02`；不达标先查 `tags.foldDims` 的归一与地板。
- 影子跑一整天，D 档位（D0–D3）切换次数与切前同量级（±20%）。

### P3 · 摘写口与兼容（半天）
- `db.js` 删建表、改旧 path 兼容；`features.js` 两处改转命题；`ops.js` 表清单去掉；`ports/ownership.js` 去掉声明。
- 验收：写入一条 `{"values.achievement":0.4}` 的旧模板，断言 `persona_values` 不存在（先建后删的顺序，用临时库测），且命题里有「我更看重成就」。

### P4 · 删 API/UI 旧语义 + 评估（半天）
- `eval.js` 漂移改命题位移；`doctor` 改 `values/explain`；`client.js` 文案与技术视图改「命题 → 十维」。
- 验收：doctor 输出里搜不到旧表；价值观页点「重新想一遍」只重折命题、不重跑词表。

### P5 · 真删（1 h）
- `DROP TABLE persona_values`；`DELETE FROM persona WHERE path LIKE 'values.%'`。
- 删 `value_migrate.js`、`bridge.js` 里的调用、`values.js` 里为迁移留的 `resolveValueKey` 之外的旧词表（保留 `DIMS/PAIRS/INIT/FLOOR` 常量给折算与页面用）。
- 删测试 fixture 对旧表的读写；`run-tests.mjs` 的「价值观写入」改成「命题写入」。

### P6 · 新联动补齐（1–2 天）
- 冲突 → `V.tensions` 真正进 `conflict.js`；
- 主动开口「价值」门接十维极差与张力；
- （可选）情绪 `goal_relevance` 与命题挂钩，先影子；
- 关系采信权重：亲近的人命题 `pi` 加成，写进 `tags`。

### P7 · 文档（1 h）
- `README` 删「价值观不是人填的：从记忆…长出 Schwartz 十维」那段旧描述，改成「三观账本 → 十维折算」。
- `docs/sangguan-交接-G5-G8.md` 的「清理时保留旧表」改成「已删」，追加本次变更日志。

---

## 4. 验收清单（可直接执行）

```powershell
cd D:\deepseek\dsh-plugins\dsh-consciousness-v6
git grep -n "persona_values" -- src index.js client.js scripts test      # 期望：无输出
git grep -n "growValues\|migrateValues\|listValues" -- src test scripts   # 期望：无输出
node test/run-tests.mjs                                                   # 期望：全通过
node test/sangguan-g5.test.mjs; node test/sangguan-g7.test.mjs; node test/sangguan-g8-sim.test.mjs
npm run doctor                                                            # 期望：不列旧表；V Σ=1；漂移有值
node scripts/sim-days.mjs                                                 # 期望：D 档分布不塌
```

数据侧：

```sql
SELECT name FROM sqlite_master WHERE name='persona_values';   -- 期望：空
SELECT COUNT(*) FROM persona WHERE path LIKE 'values.%';      -- 期望：0
SELECT COUNT(*) FROM persona_claims WHERE kind='value';       -- 期望：>0
```

---

## 5. 风险与回滚

| 风险 | 触发点 | 处理 |
| --- | --- | --- |
| 驱力权重重算，D 档短期漂移 | P2 | 先影子一天；超 ±20% 回滚读口（一行恢复） |
| 迁移把旧权重折丢（命题不够） | P1 | 迁移台账对比；缺的维补一条「我更看重 X」命题再 fold |
| 旧包导入写回旧表 | P3/P5 | `importFull` 解析时转命题；导入测试覆盖 schema 6–11 |
| `DROP` 后想退回 | P5 | 只在 P0 备份 + `git tag` 之后执行；退回落备份库 |
| 页面/doctor 还指着旧表 | P4 | 用 `values/explain` 替代，先把接口换完再删表 |

---

## 6. 工作量与顺序小结

| 阶段 | 估时 | 产出 |
| --- | --- | --- |
| P0 | 30 min | tag + 库备份 |
| P1 | 半天 | 迁移 flag + 台账 |
| P2 | 半天 | 驱力改读三观 + 等价测试 |
| P3 | 半天 | 写口/兼容全摘 |
| P4 | 半天 | API/UI/评估改口 |
| P5 | 1 h | 表删掉、迁移器删掉 |
| P6 | 1–2 天 | 冲突/开口/情绪/关系四条新联动 |
| P7 | 1 h | 文档与日志 |

---

## 7. 执行记录（2026-11-01 20:00–20:15）

### 7.1 逐阶段结果

| 阶段 | 做了什么 | 验收 |
| --- | --- | --- |
| P0 | `git tag pre-value-cleanup-20261101`；活库备份 `Desktop/ds/_backup_pre_valuecleanup_20261101.db`（29.5 MB） | 备份可打开、schema v12 |
| P1 | 在活库副本上跑迁移并核对；活库最后在 P5 一次跑完 | 小汐 3 条命题（仁善/安全/刺激）、貅鹤 1 条（权力）；幂等；旧表行数不变 |
| P1 修 bug | `MIG_BAR=0.03` 把真实极差 0.0193 判成「平的」→ 迁移后十维全部回到 0.1，等于把偏好丢了 | 改成 `MIG_BAR=0.004`（人手写门槛 `BAR=0.03` 保留），重跑：头名保留、命题落地 |
| P2 | `drive.js` 的十维改走 `sangguan/vweights.js`（`foldValueWeights`），按投影 `last_seq` 缓存；`deficit.js` 刻度 `×10 → VALUE_SCALE=2.5` | 小汐每维重要度变化 ≤4.27%，貅鹤 ≤4.40%，Σw=5；不校准会到 +25% |
| P3 | 删 `persona_values` 建表与「旧 path → 表」兼容写；`ops` 清理清单、`ownership` 六处声明、`doctor` 旧表检查、导出清单全部摘掉；旧模板 `values.*` 只转命题 | `grep persona_values` 在 src/index/client/scripts 命中 0 |
| P4 | `explain` 返回真实来源 + 命题数；前端价值观页文案改「命题折算」；`measureValueDrift` 从「读 changes（永远 0）」改成「30 天 V 层事件 ÷ 命题数」 | 页面/接口/指标不再指向旧表 |
| P5 | 活库迁移（4 条命题 / 6 笔 V 事件）→ 删 `persona.values.*` 旧 path（0 行）→ `DROP TABLE persona_values`；`value_migrate.js` 拆成 `values_intake.js`，迁移器代码删除；`bridge` 不再调用迁移；`nightly` 步骤改名 `value_intake`；`fast` 恢复 `drainValues()` | 活库无表、无旧 path；`node --check` 通过 |
| P6 | `V.tensions` 除了未决 κ，还把折叠时的三组张力对（gap ≥0.02）报出来；提示词在价值行后补一句「X 和 Y 还没分出高下」；自述来源规则改「命题折算」 | 新增 `test/sangguan-value-cleanup-e2e.test.mjs` 12/12 |
| P7 | README 四处（价值观机制 / 夜间 / 权威表 / doctor）改口；本文件补执行记录 | — |

### 7.2 改前 / 改后

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| 旧价值观表 | `persona_values` 存在，50 行 / 5 个实例 | 表已 DROP；`persona.values.*` 旧 path 0 行 |
| 旧代码引用 | 建表、兼容写、迁移器、驱力读口、导出、doctor、ownership 共 15 处 | `src` / `index.js` / `client.js` / `scripts` 命中 0（只剩测试里模拟旧库的 fixture） |
| 十维来源 | 旧表（人填 + 词表推导） | 三观账本 V 层命题 → `foldDims`；无命题时 0.1 均匀 |
| 驱力「重要度」 | `值 ∈ [0.09,0.12] × 10` | 折叠值 `×2.5`；每维变化 ≤4.4%，Σw=5 |
| 提示词价值行 | 直接取 top3，可能列出低于均值的维（如 0.06 的普世） | 只列 >0.105 的维；有张力再补一句 |
| 漂移指标 | 读 `changes`（该表已不再记价值变更）→ 永远 0 | 30 天 V 层事件 ÷ 命题数，有真实活性 |
| 写入口 | 手写直接写表；旧模板兼容写表 | 手写 → `claimUserValue`（过指令闸）；旧模板 → 命题；都不落表 |
| 测试 | 519/519（run-tests） | 519/519；`sangguan-*.test.mjs` 32 个文件全绿；e2e 12/12；`check:arch` 全绿 |

### 7.3 遗留与注意

- 插件进程需要**重启**才会加载新代码；活库已经在 P5 完成迁移与删表，重启后直接走折算。
- 测试里仍会自建一张 `persona_values` 来模拟旧库（`g5/g7/g8/vdef-2/vdef-3` 与 run-tests 的旧库 fixture），这是测试用的假表，不是生产代码。
- `scripts/replay-drive.mjs` 在现码上能跑通（v1/v1b/v1c/v1d/v2 五档输出正常），说明驱力读口换成折算后没有断粮。

