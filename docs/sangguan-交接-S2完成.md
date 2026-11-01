# 三观引擎 · 交接（S1–S2 已完成，下一步 S3）

## 0. 新对话先读
- 规则真源：`C:\Users\ygys1\.cursor\projects\d-deepseek-dsh-plugins-dsh-consciousness-v6\canvases\sangguan-logic-gates.canvas.tsx`
- 施工图：同目录 `sangguan-code-guide.canvas.tsx`（§8 编码顺序）
- 架构 / 事件目录：同目录 `sangguan-master-plan.canvas.tsx`
- 前端（S13 才用）：同目录 `sangguan-frontend-plan.canvas.tsx`
- 冲突优先级：logic-gates ＞ master-plan ＞ code-guide ＞ frontend-plan；其他 sangguan-*.canvas.tsx 是旧资料。

## 1. 用户的硬要求（每一步都适用）
1. 新代码放 `src/modules/sangguan/`；现有模块尽量不改，必须改的先说明再改，改前做 `.bak-sangguan-<步>-<日期>` 备份（项目不是 git 仓库）。
2. 开关 `sangguan.enabled` 默认关；关闭时项目行为与现在完全一致。所有挂点先过 `isEnabled(db, aid)`。
3. 每步先写测试再写实现；测试放 `test/`，风格同现有（独立 `.mjs`、`check(name, ok, detail)`、末尾打印「通过 x / y」）。
4. fold 纯函数（I15）：不调模型、不读时钟，时间从参数 / 事件传入。
5. 账本只增；状态与计数从事件派生（I1–I3）。
6. 三观模型预算独立于 `memory.llm.daily_cap`。
7. 中文注释，少而精，贴合周边风格。
8. 每步：实现 → 模拟测试找 bug → 修 → 全绿再进下一步；全部做完再整体模拟。

## 2. 已完成（S1、S2）
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

测试：`npm run test:sangguan` → S1 81/81、S2 82/82；模糊模拟可用 `SG_SEED=<n>` 换种子（10 个种子全过）。
全量基线：`node test/run-tests.mjs` = 518/520，失败两项是旧断言过期（健康检查期望 schema 11、清单计数 80≠82），与三观无关，不要动。`check:arch` 六个脚本全过。

## 3. 已拍板的三件事
1. **试用期延长与休眠**（S6 实施）：新增事件 `SUB_EXTEND`（sub_trial 中、每个 κ 至多一次，`trial_until += T_trial`）与 `SUB_DORMANT`（写 `dormant_since = at`）。dormant 期间来了绑定 c* 的证据，fold 清空 `dormant_since`（纯函数，从事件得出）。`SUB_EXPIRE` 守卫：`dormant_since` 非空。两者 actor 只能是 sys。改动点：catalog（事件）、machine（不改 σ）、fold（SPECIAL）、测试补 P17 有限占用夹具。
2. **整 agent 清除**（S13 实施）：新增表 `claim_purge(agent_id)`；触发器改为 `WHEN NOT EXISTS (SELECT 1 FROM claim_purge WHERE agent_id=OLD.agent_id)`；`sangguan.purgeAgent(db, aid)` 在一个事务里：插标记 → 删本 agent 全部 L0 + 投影 + flags 配置 → 删标记。schema 里用 DROP TRIGGER + CREATE 升级旧库。同时在 `src/ports/ownership.js` 登记 sangguan 域，在现有 purge 流程（ops.js）里调用它（先说明再改）。
3. **整数型 Θ（n_min、N_trial、N_delib、N_inq）**（S11 实施）：Θ 允许存小数，使用处一律 `Math.round(theta(...))`。L5 的「每周 ≤10%」作用于存储值，所以 3 → 3.3 → 3.63 → 3.99，第三周起生效为 4。确定可重放，不改宪法。

## 4. 后续计划（S3–S13）
挂点事实：对话后入队在 `index.js` 约 528 行 `enqueueExtraction`；夜巡在 `index.js` 约 684 行调用 `runNightly`（`src/modules/nightly.js`）；前端页签在 `client.js` 约 45 行 `TABS`，三观页插在 `['affect','情绪']` 之后；接口在 `src/api.js`；模型入口在 `src/model.js`（`createModel`、`attachHostLlm`）。

- **S3 模型调用与预算**：`llm.js`（模板注册 id@版本、手写 JSON 校验器、1 次修复重试、`claim_llm_cache` 成对缓存 key=sha1(模板@版本+两 id)）；`budget.js` 自管日额（flags 键 `sangguan.budget:<aid>:<日>`，池：快 20 / 中 30 / 保留 6 / 周 40，结转 ≤1.5 倍，月度硬顶，降级阶梯 §3.2，保底 2 单位）——**决定不改 llm_budget.js 的 KINDS**，以满足「现有模块尽量不改」与「预算独立」；档位 T1/T2 走宿主模型，配置 `sangguan.model.light/heavy` 存在 config.js。测试：假 LLM 按模板 id 回放夹具，全部离线。
- **S4 快环**：`sim.js`（复用 vector.js 嵌入；无嵌入退化为字二元组 Jaccard，标 `sim_mode=lexical`）、Eq.2 召回、`gates.classify` W1–W5、J1 抽取 / J2 关系判定、F1–F5。挂到对话后（每 5 轮或会话结束，异步不阻塞回复，开关关则零调用）。测试 P11 分类穷尽。
- **S5 审议骨架**：A(κ)、Eq.8、Decisive / Loser / 平局规则、优先级 Eq.5 + 老化、每夜 ≤N_delib 且至少 1 次、plan（只读）/ commit（校验 expect）、没预算推迟不写 DELIBERATE。只含 RESOLVE / SUSPEND。测试 P4、P10、P17。
- **S6 扬弃**：S1–S5 闸、J4/J5、SUB_ACCEPT、试用结算（含决定 1）、SUB_EXPIRE。测试 P3、P2；场景①②。
- **S7 实践回流**：证据绑定、ν 到期与 J7、π、m(ℓ)、退化 Rev/Bad/Degen、修补 J8 与 REPAIR_FAILED、nightly N1–N3、DEGEN_CHECK。测试 P5、P12、P18；场景③前半。
- **S8 三层差异**：COEX + loss、TRADEOFF（J1 绑定）、VException、跨层证据与边、KAPPA_OBSOLETE 自动同事务、REVIEW_FLAG 传播。测试 P6、P9、P21、P22、P23；场景④。
- **S9 先例**：Eq.9–10、Pool、Inhibit、b*_noprec。测试 P7、I10。
- **S10 升维**：E1–E4、辩证会、proposals 审批（复用 selfmod proposals，T_approve 超时拒绝、冷却指数退避）。测试 P12 不破；场景③后半。
- **S11 活性**：L1–L11、L5（含决定 3）、Qi、幂等键 `sg:night:YYYY-MM-DD` / `sg:week:YYYY-Www`。测试 P13–P16、P19、P20；场景⑤⑥。
- **S12 注入与解释**：inject.lines（只读投影，先 shadow 7 日再 live）、L2 自传摘要 J16、explain J19。
- **S13 接口与三观页**：`api.js` 路由 `/v1/agents/:id/sangguan/*`（状态、链头、κ、ν、事件账、开关、审批、verdict），先说明再改；`client.js` 在情绪页后加「三观」页签，按前端计划 F0–F6；落实决定 2（purge）；整体模拟 + 修 bug。

## 5. 环境坑
- 编辑工具写文件后约 1–2 秒才落盘，紧接着跑测试可能跑到旧文件：跑前 `Start-Sleep 2`。
- PowerShell 输出中文会乱码、`Select-String '通过'` 常匹配不到；需要解析输出时写临时 `.mjs` 用 node 读文件，用完删掉。
- `rg` 不在 PATH，用 Grep 工具。
- node 22 的 `node:sqlite` 会打印 ExperimentalWarning，无害。
