# 三观引擎 · 第一组交接：S3 + S4（接模型和快环）

先读 `docs/sangguan-交接-00-通用.md`，再读设计文档里与 S3、S4 相关的章节（code-guide §8 的 S3/S4、logic-gates 的 W1–W5、F1–F5、§3 预算）。

## 目标
打开开关后，对话结束会抽取候选观点并按规则记进账本；不影响回复。关闭开关时零模型调用、零写入。

## S3 模型调用与预算
新文件：
- `llm.js`
  - 模板注册：id@版本，每个模板带输入构造和输出 schema。
  - 手写 JSON 校验器（不引新依赖）；校验失败做 1 次修复重试，再失败返回结构化错误，不写账本。
  - 判定缓存：`claim_llm_cache`，成对判定 key = sha1(模板@版本 + 两 id)，顺序无关。
  - 档位 T1/T2 走宿主模型（`src/model.js` 的 `createModel` / `attachHostLlm`），配置 `sangguan.model.light/heavy` 放 `config.js`。
- `budget.js`
  - 自管日额，flags 键 `sangguan.budget:<aid>:<日>`；日期由调用方传入。
  - 池：快 20 / 中 30 / 保留 6 / 周 40；结转 ≤1.5 倍；月度硬顶；降级阶梯按 §3.2；保底 2 单位。
  - 不改 `llm_budget.js`，与 `memory.llm.daily_cap` 互不挤占。

测试 `test/sangguan-s3.test.mjs`：
- 假 LLM 按模板 id 回放夹具，全部离线。
- 校验器：缺字段、类型错、多余字段、修复重试成功 / 失败。
- 缓存：命中、顺序无关、模板版本变化不命中。
- 预算：各池扣减、结转上限、月顶、降级阶梯、保底；与记忆预算互不影响。

## S4 快环
新文件：
- `sim.js`：复用 `vector.js` 嵌入；无嵌入时退化为字二元组 Jaccard，结果标 `sim_mode=lexical`。
- Eq.2 召回。
- `gates.js` 的 `classify`：W1–W5 分类，必须穷尽且互斥。
- J1 抽取、J2 关系判定（经 `llm.js`）、F1–F5 入账规则。
- `fast.js`：组织上述流程，调 `ledger.append`。

挂点（改现有文件，先向用户说明再改，改前备份）：
- `index.js` 的 `enqueueExtraction` 附近：每 5 轮或会话结束触发；异步，不阻塞回复；先过 `isEnabled`，关则直接返回。

测试 `test/sangguan-s4.test.mjs`：
- P11 分类穷尽（模糊生成输入，每个都恰好落入一类）。
- 假 LLM 端到端：对话 → 抽取 → 入账 → 投影正确，且 P1 重放一致。
- 开关关闭：零模型调用、零账本写入（用计数桩验证）。
- 预算耗尽：不抽取、不写账本、不报错。
- 回复延迟：挂点不 await 快环。

## 完成标准
- `test:sangguan` 全绿（S1–S4），多个 `SG_SEED` 通过；全量仍 518/520；`check:arch` 全过。
- 告诉用户：可以打开开关真实跑几天，看抽取质量和花费。这是整个项目最关键的检验，效果不好就先调 S4，不急着进第二组。

## 可选（先问用户）
做一个很简单的只读三观页（只显示账本和当前观点），方便后面各组观察。要改 `api.js` 和 `client.js`，必须先征得用户同意；完整页面仍在第四组。

## 完成记录
**做了什么**
- S3：`config.js`（预算 / 模型路由配置清洗）、`budget.js`、`http_chat.js`、`llm.js`、`templates.js`。测试 `sangguan-s3.test.mjs` 83 项。
- S4：`sim.js`、`gates.js`、`fast.js`；`index.js` 的 `commitTurn` 里加一行 `sangguanAfterTurn`（开关关闭直接返回，只入缓冲，满 5 轮或闲置 10 分钟后台抽取）。测试 `sangguan-s4.test.mjs` 72 项（含 P11 4000 例、P1 重放、120 次模糊）。
- 整体模拟 `sangguan-g1-sim.test.mjs` 16 项：3 个 agent × 30 天、9 个话题、判定断网两天、中途关开关一天。
- 10 个种子全过；全量 518/520 不变；`check:arch` 全过。

**偏离计划**
- J2 调不通（网络 / 超时，code=CALL）进 PENDING_JUDGE（reason=`judge_unavailable`），下次快环补判；J2 答了但两次都不合格（SCHEMA）仍按「闸不通过」走 EXP。逻辑门元规则 (1) 写的是「超时 = 闸不通过」，原样执行会在断网期间产生重复观点、永久漏记矛盾（整体模拟里最多 6 个重复头）。待用户确认，可否决。

**改过的现有文件**：`index.js`、`package.json`，备份 `*.bak-sangguan-s4-20261101`。

**遗留 / 观察**
- 没配嵌入时退到字面 bigram Jaccard，θ_rel 0.55 是按余弦定的，换种说法的同义句容易判成新观点。建议配嵌入。
- J1 输入（12 轮 × 600 字 + 现有观点）比 code-guide 里 T1 的估算大，真实跑时留意 token 花费。
- 可选只读三观页未做，待用户决定。
