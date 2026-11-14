# 三观引擎 · 交接通用部分（四组都先读这份）

剩余工作分四组，每组用一个新对话完成：
- 第一组 `sangguan-交接-G1-S3S4.md`：接模型和快环
- 第二组 `sangguan-交接-G2-S5S8.md`：引擎核心（审议 / 扬弃 / 实践回流 / 三层差异）
- 第三组 `sangguan-交接-G3-S9S11.md`：先例、升维、活性
- 第四组 `sangguan-交接-G4-S12S13.md`：注入、接口、三观页、整体模拟

每组结束时：跑全量测试 → 更新本文件第 3 节「当前进度」→ 在组文档末尾写「完成记录」（做了什么、偏离计划的地方、遗留问题）→ 告诉用户可以换下一组。

## 1. 设计文档
目录：`C:\Users\ygys1\.cursor\projects\d-deepseek-dsh-plugins-dsh-consciousness-v6\canvases\`
- `sangguan-logic-gates.canvas.tsx`：规则真源
- `sangguan-code-guide.canvas.tsx`：施工图（§8 编码顺序 S1–S13）
- `sangguan-master-plan.canvas.tsx`：架构、事件目录
- `sangguan-frontend-plan.canvas.tsx`：三观页（第四组才用）
- 冲突优先级：logic-gates ＞ master-plan ＞ code-guide ＞ frontend-plan；其他 `sangguan-*.canvas.tsx` 是旧资料，不作规则。

## 2. 用户的硬要求（每一步都适用）
1. 新代码放 `src/modules/sangguan/`；现有模块尽量不改，必须改的先向用户说明再改，改前做 `.bak-sangguan-<步>-<日期>` 备份（项目不是 git 仓库）。
2. 开关 `sangguan.enabled` 默认关；关闭时项目行为与现在完全一致。所有挂点先过 `isEnabled(db, aid)`。
3. 每步先写测试再写实现；测试放 `test/`，风格同现有（独立 `.mjs`、`check(name, ok, detail)`、末尾打印「通过 x / y」），并加进 `package.json` 的 `test:sangguan`。
4. fold 纯函数（I15）：不调模型、不读时钟，时间从参数 / 事件传入。
5. 账本只增；状态与计数从事件派生（I1–I3）。
6. 三观模型预算独立于 `memory.llm.daily_cap`。
7. 中文注释，少而精，贴合周边风格。
8. 每步：实现 → 模拟测试找 bug → 修 → 全绿再进下一步；全部做完再整体模拟。
9. 三观页放在情绪页后面。

## 3. 当前进度
- 已完成：S1、S2、第一组（S3 + S4）、第二组（S5–S8，见 G2 文档「完成记录」）、第三组（S9–S11，见 G3 文档「完成记录」；含 G2 复查修复与 N4 立案）、第四组（S12–S13，见 G4 文档「完成记录」）。S1–S13 全部完成。
- 注入默认 shadow；影子满 7 天后用 `PUT /v1/agents/:id/sangguan/config {"inject":"live"}` 或三观页技术视图切 live。

第四组新增：`inject.js`、`summary.js`、`explain.js`、`verdict.js`、`purge.js`、`api.js`；改 `index.js`（提示词挂点）、`src/api.js`（路由）、`client.js`（三观页）、`src/modules/ops.js`（清除）、`src/ports/ownership.js`（sangguan 域）。备份均为 `*.bak-sangguan-s12/s13-20261101`。

第三组新增：`precedent.js`、`elev.js`、`liveness.js`、`open.js`；`night.js` 重写为 N1–N8 + 每周慢环（`runWeek`）；`budget.js` 加 `canAfford`（审议整链预估，防紧预算饿死）。升维审批走三观账本（ELEV_PROPOSE / ELEV_COMMIT / ELEV_REJECTED），没有复用 selfmod。
- 用户已拍板：第一组之后不加只读三观页。

第二组新增：`deliberate.js`（plan/commit/execute/runNight）、`trial.js`（试用结算）、`practice.js`（J7/J8、CON、m/Rev/Degen、跨层派生、VException）、`night.js`（中环 N1–N5）。`gates.js` 补 A(κ)/Eq.8/S 闸；`templates.js` 补 J4–J8 / J12；`fold.js` 补 SUB_EXTEND / SUB_DORMANT / P5。挂点：`nightly.js` 末尾动态 import `runMid`（先过 `isEnabled`，失败不影响记忆巩固）。备份 `src/modules/nightly.js.bak-sangguan-s7-20261101`。

## 4. 已有代码（S1、S2）
`src/modules/sangguan/`：
- `catalog.js` 事件目录（41 类，含 slots / need）、层、种类、终态、σ 常量
- `theta.js` §14 参数 Θ（[默认, 可调范围]）、`thetaOf`
- `ulid.js` ULID（时间由调用方传入，同毫秒单调）
- `schema.js` 8 张只增表 + UPDATE/DELETE 拒绝触发器；6 张投影表；`claim_llm_cache`
- `errors.js` `SangguanError(code)`：INVALID / TRANSITION / INVARIANT；`ConflictError`：EXPECT / DUP_JOB
- `events.js` 读账本（ledger 与 projection 共用同一读取路径）
- `ledger.js` `append(db, aid, events, expect)` → `{ids, seqs, entities}`；`newId(slot, at)`
- `machine.js` 状态机迁移表（§2.1 / §2.2）
- `fold.js` `emptyState / apply / fold / run / checkInvariants / eOf / theta`
- `projection.js` `commitBatch / loadState / rebuild / snapshot / stateToSnapshot / stateAt / listHeads / derivedCounts`
- `config.js` 开关（flags 表，key = `sangguan:<aid>`）；`index.js` 统一出口

改过的现有文件：`src/db.js`（openDb 末尾一行 `ensureSangguanSchema`，失败只告警，未抬 schema 版本）、`package.json`（`test:sangguan`）。备份：`*.bak-sangguan-s1-20261101`。

与 DDL 草图的差异：投影表加 `agent_id`；`persona_claims` 加 `q_id`；新增 `claim_proj_edge`、`claim_proj_meta`；去掉 `fresh` / `hollow`（依赖当前时间，改为读取时传 `now` 现算）。

payload 约定：新实体放 `payload.claims / questions / kappas / nus / evidence / edges` 数组；角色字段如 `old_id`、`kappa_id`、`winner_id/loser_id`、`from_id`、`old_core_id`。证据权重必须等于 Θ 的 w_kind（跨层派生为一半）。

S2 修过的真 bug（新增逻辑时别重犯）：`KAPPA_OBSOLETE` 只释放「本 κ 之前处于 SIGMA_LOCK」的极点，靠 `ctx.kFrom` 判断，不能释放别的 κ 正在争的极点。

## 5. 测试基线
- `npm run test:sangguan`：S1 81、S2 82、S3 83、S4 72、S5 64、S6 43、S7 26、S8 23、G1 模拟 16、G2 模拟 15、G2 复查 23、G2 立案 23、S9 24、S10 40、S11 60、S12 43、S12 提示词 8、S12b 34、S13 71、三观页 34、G4 收尾 22。模糊模拟可用 `SG_SEED=<n>` 换种子。新组沿用 mulberry32 + `SG_SEED`。
- `npm run test:sangguan:long`：G3 300 天整体模拟 20 项 + G4 200 天整体模拟 26 项（共约 8 分钟，`SG_DAYS` 可缩短）。
- 全量：`node test/run-tests.mjs` = 519/520。剩下一项是旧断言过期（健康检查期望 schema 11），与三观无关。清单已重新生成（93 项）；以后改 client.js 的 Sec / FoldBlock 要跑 `node scripts/build-catalog.mjs`。
- `check:arch` 六个脚本全过；新增文件后也要保持全过。

## 6. 已拍板的决定
1. **试用期延长与休眠**（第二组 S6）：见 G2 文档。
2. **整 agent 清除**（第四组 S13）：见 G4 文档。
3. **整数型 Θ**（第三组 S11）：见 G3 文档。
4. **预算独立**（第一组 S3）：自写 `sangguan/budget.js`，不改 `llm_budget.js` 的 KINDS。

## 7. 挂点事实
- 对话后入队：`index.js` 约 528 行 `enqueueExtraction`
- 夜巡：`index.js` 约 684 行调用 `runNightly`（`src/modules/nightly.js`）
- 前端页签：`client.js` 约 45 行 `TABS`，三观页插在 `['affect','情绪']` 之后
- 接口：`src/api.js`
- 模型入口：`src/model.js`（`createModel`、`attachHostLlm`）
- 行号会漂移，动手前用 Grep 重新确认。

## 8. 环境坑
- 编辑工具写文件后约 1–2 秒才落盘，紧接着跑测试可能跑到旧文件：跑前 `Start-Sleep 2`。
- PowerShell 输出中文会乱码、`Select-String '通过'` 常匹配不到；需要解析输出时写临时 `.mjs` 用 node 读文件，用完删掉。
- `rg` 不在 PATH，用 Grep 工具。
- node 22 的 `node:sqlite` 会打印 ExperimentalWarning，无害。
