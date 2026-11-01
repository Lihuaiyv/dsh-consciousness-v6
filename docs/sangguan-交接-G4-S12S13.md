# 三观引擎 · 第四组交接：S12 + S13（注入、接口、三观页、整体模拟）

先读 `docs/sangguan-交接-00-通用.md` 和第三组的「完成记录」（`sangguan-交接-G3-S9S11.md` 末尾），再读设计文档里 S12、S13 相关章节和 `sangguan-frontend-plan.canvas.tsx`。

本组会改多个现有文件，并且开始影响回复：每处改动都先向用户说明、备份再改。

## S12 注入与解释
- `inject.js` 的 `lines`：只读投影生成注入行，不写账本。
- 先 shadow 模式（只记录会注入什么，不真正注入）7 日，再切 live；模式放 `config.js`，默认 shadow。
- L2 自传摘要 J16；explain J19（回答「为什么持有这个观点」）。
- 注入挂点在现有提示词组装处，先 Grep 定位，向用户说明后再改；开关关闭时提示词与现在逐字一致（写测试比对）。

## S13 接口与三观页
- `api.js` 路由 `/v1/agents/:id/sangguan/*`：状态、链头、κ、ν、事件账、开关、审批、verdict。
- `client.js`：在 `['affect','情绪']` 之后加 `['sangguan','三观']`，按前端计划 F0–F6 实现。如果第一组做过只读页，在它基础上扩展。
- 已拍板决定 2（整 agent 清除）：
  - 新增表 `claim_purge(agent_id)`。
  - 触发器改为 `WHEN NOT EXISTS (SELECT 1 FROM claim_purge WHERE agent_id=OLD.agent_id)`；schema 里用 DROP TRIGGER + CREATE 升级旧库。
  - `sangguan.purgeAgent(db, aid)` 一个事务内：插标记 → 删本 agent 全部 L0 + 投影 + flags 配置 → 删标记。
  - 在 `src/ports/ownership.js` 登记 sangguan 域，在现有 purge 流程（ops.js）里调用它。
  - 测试：普通 UPDATE/DELETE 仍被拒；purge 只删目标 agent，其他 agent 不受影响；purge 后标记不残留。

## 整体模拟
- 开关关闭：全量测试与基线一致（518/520），提示词、接口、页面行为与改动前一致。
- 开关打开：多 agent、长时段、假 LLM 的端到端模拟，覆盖六个场景；P1 重放一致；预算不超；不变量全程成立。
- 修完所有发现的 bug 后再跑一轮。

## 完成标准
- `test:sangguan` 全绿（S1–S13）；全量 518/520（两项旧失败不动）；`check:arch` 全过；无 lint 错误。
- 向用户汇报：改过的现有文件清单和备份位置、shadow 切 live 的方法、遗留问题。

## 完成记录

### 做了什么
- **S12 注入**（`inject.js`）：`injectView / lines` 只读投影出世界观 / 人生观 / 价值观三行 + 自传一句 + 还没想定的一处 + 它想问的一句（G3 遗留的 ask 注入）；预算 `INJECT_BUDGET=160` token，零术语（不出现 κ π ν σ），终态命题不进。`promptHook` 挂在 `index.js` 提示词组装处：关闭原样返回（测试逐字比对备份版）；shadow 只写影子记录；live 才替换有链头的层。影子满 `SHADOW_DAYS=7` 天才能切 live。
- **S12 自传 / 解释**：`summary.js`（中环 N7，J16）上一章之后新增实质事件 ≥ 10 且距上一章 ≥ 7 天才写，J16 走周池；转折点 id 必须来自输入。`explain.js`（J19）事实清单 + 模板句，润色只许改说法、不许加数字，失败回落模板句；只读、按事实句缓存。
- **r_J 用户覆盖**（`verdict.js`）：用户「对 / 不对」写 EVIDENCE（kind verdict，权重 = Θ w_verdict），可带 `override_of`、`inquiry_id`（回答提问）；同目标同日只计 1 次；`rJOf` 进每周稳态。
- **S13 清除**：`claim_purge` 表 + 删除触发器加 `WHEN NOT EXISTS`（旧库自动 DROP + CREATE）；`purge.js` 一个 savepoint 内清本 agent 全部 L0 + 投影 + flags；`ops.js` 的 `purgeExpired` 删 agent 前调用；`ownership.js` 登记 sangguan 域。
- **S13 接口**（`sangguan/api.js`，挂在 `src/api.js`）：GET status / config / heads / claims/:id/chain / claims/:id/explain / kappa / deliberations/active / precedents / predictions / events（分页）/ timeline / epochs / summaries / vitals / inject/preview / elev / candidates；POST verdict、elev/:id/approve|reject；PUT config（切 live 未满影子期 409，`force` 可越过）。写入沿用全局幂等键与角色（viewer 写 403）。关闭时数据接口返回 `{enabled:false}`、写入 409。
- **S13 三观页**（`client.js`，情绪页之后）：未启用页 + 打开按钮；表头三层一句话、第 n 季、判断条；世界观 / 人生观（自传两栏）/ 价值观（平时怎么做 / 仰望什么）各带未决矛盾卡；预见与回流（对 / 不对）；它最近在想什么（可回答）；史（时间线分层分页）；命题抽屉（解释、链、裁决）；技术视图：注入预览与切换、体征与预算、升维审批、事件账分页。旧的价值观雷达折叠保留。
- **测试**：S12 43、S12 提示词逐字 8、S12b 34、S13 71、三观页 34（vm 里跑真实 client.js + 真实接口）；`test/sangguan-g4-sim.test.mjs` 200 天整体模拟 26 项（并入 `test:sangguan:long`）。

### 整体模拟修掉的问题
- J16 每晚都写（200 天 159 章，静默期照写）→ 加「一章至少隔一周」，降到 27 章。
- J16 占中环池，紧预算下 κ 排队最长 108 天（G3 长模拟断言 ≤ 90 失败）→ J16 改走周池，回到 41 天。
- 模拟本身：接口限流误伤（改用 `DSHC_TEST_NO_LIMIT`）、影子天数是数组按数字比、静默期断言过严（静默期内预测兑现 / 合题确认是真变化，改为「不比活跃期多、间隔 ≥ 7 天」）。

### 偏离计划
- 人格页没动（三观页单独成页，旧雷达折叠进三观页底部）。
- 切 live 不自动：影子满 7 天后由用户在技术视图或 `PUT /v1/agents/:id/sangguan/config {"inject":"live"}` 手动切。

### 遗留收尾（用户授权自行拍板）
- **清单**：`node scripts/build-catalog.mjs` 重新生成 `src/catalog.json`（93 项），「完整清单与代码同步」转绿；全量变为 519/520。备份 `src/catalog.json.bak-sangguan-g4fix-20261101`。
- **导出**：zip 里加 `sangguan.ndjson`（整本账按 seq，事件带命题原文，可离线重放）；导入不回放（同一 agent 的账本只增，往已有账本里灌另一本没有定义良好的语义）。没有账本的 agent 导出与原来一致。
- **孤儿**：`purge.purgeOrphans` 在 `purgeExpired` 末尾补清 agents 表里已不存在的三观数据（含只剩开关 flag 的）。`ops.js` 备份 `src/modules/ops.js.bak-sangguan-g4fix-20261101`。
- **PRESSURE**：V 层并存 κ 上的 TRADEOFF 同批连一条 PRESSURE（偏向的那一极 → L 层 telos，没有 telos 取 e 最高的活命题；同一对只连一条；L 层空则只记 TRADEOFF）。L10 的「生」因此计入。
- **冷启动**：`POST /sangguan/seed {layer, text}`（仅 user），只能给还没有核心的层种一句核心（origin seed、actor user）；已有核心 409 HAS_CORE，换核心仍走升维。三观页三处「尚未立论」改成可直接种下。
- **不改**：近邻召回整批退化（logic-gates「保证同批可比」，cos 与 Jaccard 量纲不同不能共用一个 θ_rel）；升维阈值（规则真源定的，罕见是设计本意）。
- 测试 `test/sangguan-g4-fix.test.mjs` 22 项，进 `test:sangguan`。

### 仍然遗留
- 「健康检查」旧失败（期望 schema 11，实际 12），与三观无关。
- 升维全程 0 次提案（G3 / G4 都是），审批流程只在单测里走过。
- 假 LLM 的助手不读注入，「接注入后 TRADEOFF / SUB 是否变少」要上真模型后观察。
