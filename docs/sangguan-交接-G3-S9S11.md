# 三观引擎 · 第三组交接：S9 – S11（先例、升维、活性）

先读 `docs/sangguan-交接-00-通用.md` 和第二组的「完成记录」（`sangguan-交接-G2-S5S8.md` 末尾），再读设计文档里 S9–S11 相关章节。开始前问一下用户：第二组上线后观察到了什么问题，有没有要先修的。

## 目标
在核心循环上加先例、升维和活性机制；仍不影响回复。

## S9 先例
- Eq.9–10、Pool、Inhibit、b*_noprec。
- 测试 P7、I10。

## S10 升维
- E1–E4、辩证会。
- proposals 审批：复用 selfmod 的 proposals 机制；T_approve 超时视为拒绝；冷却按指数退避。复用前先读现有 selfmod 代码，如需改动先向用户说明。
- 测试 P12 不破；场景③后半。

## S11 活性（含已拍板决定 3）
- L1–L11、L5、Qi。
- 幂等键：`sg:night:YYYY-MM-DD`、`sg:week:YYYY-Www`（走 `JOB_DONE`，I16）。
- 决定 3：整数型 Θ（n_min、N_trial、N_delib、N_inq）允许存小数，使用处一律 `Math.round(theta(...))`。L5「每周 ≤10%」作用于存储值：3 → 3.3 → 3.63 → 3.99，第三周起生效为 4。需要回头检查 S5–S8 里读这几个参数的地方，全部改成 `Math.round`。
- 测试 P13–P16、P19、P20；场景⑤⑥；同一天 / 同一周重复跑不产生重复事件。

## 完成标准
- `test:sangguan` 全绿（S1–S11），多个 `SG_SEED` 通过；全量仍 518/520；`check:arch` 全过。
- 用长时段模拟（几百天、时间全部由参数推进）跑一次，确认活性机制不会让账本无限增长或卡死。

## 完成记录

### 先复查并修了一、二组
- S7：J7 的 refs 可以编造（不在输入记录里也收）→ 只认输入记录。
- G2 生产路径根本不立案（G2 模拟靠测试辅助开 κ）→ 补 N4 立案 `open.js`（J3 + U1–U4 + 问题去重 + K_open + KAPPA_QUEUED + 候选过期），夜间自己开 κ、开 SUB / COEX。
- 其余 G2 审查修复见 `sangguan-g2-review.test.mjs`（僵尸 κ、并存重开守卫、修补触发、J5 输入、Rev 同事务、ν void、verdict 每日 1 条、CORE_ESTABLISH）。

### 新增 / 改动
- `precedent.js`（S9）：结局表 o_d、Pool、sim = w_q/w_p/w_k、ω、P(b)、N_bad、Inhibit；`deliberate.js` 记 `precedent_ids / P / inhibit / b_noprec`。
- `elev.js`（S10）：E1–E4、辩证会 J20×2 + J10 + J11×2（慢环 8 单位）、W 层直接 ELEV_COMMIT，L / V 走 ELEV_PROPOSE → `approveElev / rejectElev`，T_approve 超时、指数冷却（≤ 90 天）、Frozen。
- `liveness.js`（S11）：L1 求证（VOI、Q_ask、T_ask、`N_inq` 取整）、L2 / L9 自我质疑、L3 惊奇加成、L5 稳态（宪法：只调带 * 参数、单周 ≤ 10%）、L6 溯因、L7 / L8 注入权重、L10 相生相克、L11 Qi 与动静、§12 FLIP；`night.js` 重写为 N1–N8 + 每周慢环，幂等键 `sg:night:` / `sg:week:`。
- `templates.js` 补 J10 / J11 / J13 / J14 / J15 / J17 / J20；`catalog.js` 补 ELEV_FAILED；`budget.js` 补 `canAfford`；`fast.js` 导出 `placeOne`。
- 未改任何三观以外的现有模块（本组无 `.bak`）。

### 偏离计划
- **升维审批没有复用 selfmod proposals**：那套批准会扣 token、占每日改动上限、写 rule_versions，语义不对。改为三观账本内的 ELEV_PROPOSE / ELEV_COMMIT(actor=user) / ELEV_REJECTED。
- FLIP 的局部 THETA_ADJUST（+2 / +0.1，scope=q）按规范是 10% 规则的例外。
- `DEGEN_CHECK` 只写在有在世核心的层，且「未退化且与上一检查点相同」时不写（E1 只看最近 W_deg 个是否全退化，不影响判定），空闲 agent 账本不再每夜白涨。

### 长时段模拟时找到并修的真 bug
- **紧预算下 κ 饿死 200+ 天**：①审议链中途预算不够（J4 花了、卡在 J5）→ 推迟、次夜重来，永远白烧；②队首贵的 κ 推迟后，后面不需要模型的审议也轮不到。修：`execute` 先用 `canAfford` 按降级阶梯估整条链，放不下一分不花；`runNight` 队首推迟后继续往下做零调用的审议。修后最长排队 41–57 天（K_open 限住上界）。
- L2：probe 按构造是目标的反命题，近邻没检到时也记 KAPPA_CANDIDATE。
- L1：在开 κ 的两极由 κ 条目代表，不再单独求证（免得同一件事问两次）。

### 测试
- 新增 `sangguan-s9`（24）、`s10`（40）、`s11`（60）、`g2-open`（23）、`g2-review`（23）；`test:sangguan` 15 个文件，种子 1 / 7 / 42 / 默认全绿。
- 长时段：`npm run test:sangguan:long`（`sangguan-g3-sim.test.mjs`，300 天四阶段、判定全挂 2 天、预算归零 1 天、核心持续受挫，约 4.5 分钟），种子默认 / 7 均 20/20。
- 全量 518/520（两项旧断言不变）；`check:arch` 全过。

### 遗留（给第四组）
- 种子核心冷启动入口（现在只能靠 L10 补边 + CORE_ESTABLISH 慢慢长）。
- TRADEOFF 不产 PRESSURE 边；r_J 的用户覆盖（G4）。
- L1 的 ask 只记 INQUIRY，没送到对话里；search 只记 query，没接记忆检索；L3 惊奇只调优先级，未接 drive / affect appraise。
- J16 摘要（G4 注入用）。
- 近邻召回「任一嵌入缺失 → 整批退化 lexical」（G1 设计，S4 有断言）：真实嵌入偶发失败时该条候选会漏判 DUP / 矛盾；要不要改成逐条混合，由用户定。
- 夹具里的助手在合题后仍反复说旧极，导致反复立案；真实人格注入合题后应少见，第四组接注入后再观察 TRADEOFF / SUB 量。
