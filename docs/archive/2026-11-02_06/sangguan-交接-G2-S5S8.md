# 三观引擎 · 第二组交接：S5 – S8（引擎核心）

先读 `docs/sangguan-交接-00-通用.md` 和第一组的「完成记录」（`sangguan-交接-G1-S3S4.md` 末尾），再读设计文档里 S5–S8 相关章节。

本组最重，预计要中途换一次对话：**做完 S6 后停下**，在本文件末尾写「中途记录」，告诉用户换新对话从 S7 继续。

## 目标
审议、扬弃、实践回流、三层差异四个机制完整；引擎内部循环能自己运转。仍不影响回复。

## S5 审议骨架
- A(κ)、Eq.8、Decisive / Loser / 平局规则。
- 优先级 Eq.5 + 老化；每夜 ≤N_delib 且至少 1 次。
- plan（只读）/ commit（校验 expect）分离；没预算就推迟，不写 DELIBERATE。
- 本步只含 RESOLVE / SUSPEND。
- 测试 P4、P10、P17。

## S6 扬弃（含已拍板决定 1）
- S1–S5 闸、J4/J5、SUB_ACCEPT、试用结算、SUB_EXPIRE。
- 决定 1：新增事件 `SUB_EXTEND`（sub_trial 中、每个 κ 至多一次，`trial_until += T_trial`）和 `SUB_DORMANT`（写 `dormant_since = at`）。
  - dormant 期间来了绑定 c* 的证据，fold 清空 `dormant_since`（纯函数，从事件得出）。
  - `SUB_EXPIRE` 守卫：`dormant_since` 非空。
  - 两个新事件 actor 只能是 sys。
  - 改动点：catalog（事件）、machine（不改 σ）、fold（SPECIAL）。
- 测试 P3、P2；补 P17 有限占用夹具；场景①②。

## S7 实践回流
- 证据绑定、ν 到期与 J7、π 更新（上移 `π + α·w·(1−π)`，下移 `π − β·w·(1+π)`）、m(ℓ)。
- 退化 Rev / Bad / Degen；修补 J8 与 REPAIR_FAILED。
- nightly N1–N3、DEGEN_CHECK。夜巡挂点在 `index.js` 的 `runNightly` 附近，改前先说明、备份，先过 `isEnabled`。
- 测试 P5、P12、P18；场景③前半。

## S8 三层差异
- COEX + loss、TRADEOFF（J1 绑定）、VException。
- 跨层证据与边（跨层权重为一半）。
- KAPPA_OBSOLETE 自动同事务；注意通用文档第 4 节那个已修 bug，不能释放别的 κ 正在争的极点。
- REVIEW_FLAG 传播。
- 测试 P6、P9、P21、P22、P23；场景④。

## 每步通用要求
- 模糊模拟扩展到新事件类型，统计拒绝原因；多个 `SG_SEED` 全过。
- 每步都验证 P1：全量重放与前缀重放一致。
- 模型调用全部经 S3 的 `llm.js` 和 `budget.js`，测试用假 LLM。

## 完成标准
- `test:sangguan` 全绿（S1–S8）；全量仍 518/520；`check:arch` 全过。
- 告诉用户：核心循环已完整，建议打开开关观察一段时间再进第三组。

## 中途记录（S6 完成后填写）
用户要求本组一次性做完 S5–S8，未在 S6 后换对话。S6 已绿（43/43，含场景①②、P2/P3/P17、种子 20261101 与 1）。

## 完成记录
**做了什么**
- S5：`gates.js` 补 A(κ)/Eq.8/Decisive/Loser/Novel/prio；`deliberate.js` 的 plan/commit/execute/runNight。只执行 RESOLVE/SUSPEND。测试 64 项。P21：RESOLVE 同批 `KAPPA_OBSOLETE` 关掉仍挂着败方的未结 κ。
- S6：S1–S5 闸、J4/J5、SUB_ACCEPT；`SUB_EXTEND` / `SUB_DORMANT`（sys、每 κ 延长一次、证据清空休眠）；`trial.js` 结算。测试 43 项。场景①合题试用通过；场景②零证据 → 延长 → 休眠 → 过期。
- S7：`practice.js` + `night.js`。J7 到期 ν（void 不改 π）、Eq.3 π、CON（π≤π_fals）、m(ℓ)、Rev/Bad/Degen、J8 修补 / REPAIR_FAILED、DEGEN_CHECK、E1 就绪（升维本身仍是 S10）。P5 写入 fold：指向 ν 的证据必须晚于登记。测试 25 项。P18 夹具走到 E1 就绪。
- S8：J6 并存、TRADEOFF、VException、V 层 SUB（P6 附证据 id）、跨层半权派生、REVIEW_FLAG 1 跳、P21/P22/P23。测试 23 项。
- 整体模拟 `sangguan-g2-sim.test.mjs` 15 项：同一套 30 天对话 + 夜间开 κ + `runMid`（N1–N5）。

**挂点**
- 改了现有文件 `src/modules/nightly.js`：巩固末尾动态 import 三观中环。先过 `isEnabled`，默认关；失败记步骤但不把夜间巩固打成失败。备份 `src/modules/nightly.js.bak-sangguan-s7-20261101`。
- `package.json` 的 `test:sangguan` 加上 s5–s8 与 G2 模拟。

**偏离计划**
- 未在 S6 后停（用户明确要求连续做完）。
- 生产路径仍不自动 `KAPPA_OPEN`（N4 / J3 / U 闸是第三组 S9）。G2 模拟里用测试辅助函数把已有 `KAPPA_CANDIDATE` 立案，才能看到审议循环。
- E1 只算「就绪」，不写 `ELEV_PROPOSE`（S10）。
- 整数型 Θ 的 `Math.round` 仍按决定 3 留给 S11。

**遗留 / 建议**
- 核心循环已完整，建议打开 `sangguan.enabled` 观察抽取、花费、合题与并存质量，再进第三组。
- 第三组开始前先问：上线观察到的问题要不要先修。
- 真实跑时 J4/J6/J7 会吃中环预算；没配嵌入时合题 S5 走 Jaccard，换说法容易被当成站边。
