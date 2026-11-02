# 自我框架 v1 · 实现报告

> 2026-11-02 · 分支工作区：`D:\deepseek\dsh-plugins\dsh-consciousness-v6`
> 验证：主测试 **545/545**、新增测试 **94/94**、`check:arch` 全绿、真机热重载通过。

---

## 1. 一句话

先把「可回滚是假的、来源分不清、冲突在重复问」这三类洞补掉，再让她**有事可做、敢改自己、会回头看**。
没有新建表：全部落在 `events` / `changes` / `memory_items` / `persona` 上。

---

## 2. 交付清单

| 块 | 文件 | 做了什么 |
|---|---|---|
| 漏洞 1 来源 | `src/modules/memory_tag.js` | `source='life'` 的记忆注入时带「我自己看到的」，不再和「你之前说」混 |
| 漏洞 2 回滚 | `src/modules/selfmod.js` | 新增 `restorePersonaFromChange`；`rollbackChange` 真的能还原 `persona.style.*` |
| 漏洞 3 指标 | `src/modules/selfmod.js` | `self.rollback_rate` 排除 `self-authorship`，她改样子不背自修改的指标 |
| 漏洞 4 冲突 | `src/modules/conflict_ask.js` | 同一对说法归一化后 7 天只问一次，不再两条 id 问两遍 |
| 漏洞 5 旧账 | `src/modules/ops.js` | 7 天没投递的 `proactive.pending` 转 `expired` |
| 漏洞 6 索引 | `src/db.js` | `idx_event_agent`，生活流按 agent 查事件不全表扫 |
| 漏洞 7 权限 | `src/ports/ownership.js` | 新模块登记 `selfhood` 域；selfmod 可写 persona、ops 可清 proactive |
| 漏洞 8 选题 | `src/modules/life.js` | 只选生活化的在意，不碰 `task` 开环、摘要腔、技术词 |
| 生活流 | `src/modules/life.js` + `index.js` | 每天 ≤1 次，选事→只读浏览/想一想→写事件+记忆+注入行 |
| 分享门 | `src/features.js` + `life.js` | `share` 优先于开环；3 天冷却；排过队不再重复 |
| 自我改写 | `src/modules/self_author.js` + `src/api.js` | 白名单（语气/口头禅/兴趣）、每天 1、30 天冷却、7 天观察、可回滚 |
| 反刍 | `src/modules/reappraise.js` + `nightly.js` | 被反复想起的旧事，一晚最多一条；只读记忆、不改情绪；防螺旋 |
| 手动入口 | `src/api.js` | `GET/POST /v1/agents/:id/life[/tick]`、`GET/POST /v1/agents/:id/author[/rollback]` |
| 模拟 | `scripts/sim-selfhood.mjs` | 30 天离线模拟：生活/分享/反刍/自改/注入增量 |
| 测试 | `test/selfhood-*.test.mjs` | 94 条：漏洞 17、生活 25、分享 8、自改 28、反刍 16 |

---

## 3. 30 天模拟（`node scripts/sim-selfhood.mjs --days 30`）

| 指标 | 结果 |
|---|---|
| 生活流成功 | 29 / 30 天（1 天没新事，`nothing`） |
| 生活事件落库 | 29 条 |
| 可进入分享门 | 8 次 / 30 天（3 天冷却后） |
| 反刍 | 4 条，4 条判定变淡 |
| 自改 | 1 条，0 回滚 |
| 活跃记忆 | 40 条，其中 `source='life'` 29 条 |
| 注入增量 | 平均 42.9 字 ≈ **26.8 token**，峰值 ≈ 28.1 token |

---

## 4. 真机验证

- 热重载：`include:dsh-consciousness-v6` 关→开，`ping` 五个接缝 `ok`（systemPrompt / pre-step / session/event / webServer / tools）。
- `POST /v1/agents/agt_3977d80f17/life/tick` 成功：
  - `kind=think`，`summary=有点好奇，这种底色偏低的时候，正面情绪到底是怎么撑住的`
  - 写入 `memory_items`（`source='life'`），`GET /life` 能读出注入行：
    > 前不久我自己想了想「…」：有点好奇，这种底色偏低的时候，正面情绪到底是怎么撑住的
- 真机暴露并修掉两个选题质量问题：
  1. 选了 `source='summary'` 的第三人称摘要（里面出现「喜欢」就被误收）→ 排除摘要腔、`type='reflection'`、长文本。
  2. 选了技术讨论记忆（情绪/参数/代码）→ 排除技术词，只留生活化的在意。

---

## 5. 改造前后对比（真实库 `~/.dsh/consciousness/app.db`）

| 指标 | 改造前 | 改造后 |
|---|---|---|
| `life.done` / `life.fail` | 0 | 真机首次成功；模拟 29 条 / 30 天 |
| 主动消息里 `share:*` | 0 | 有独立触发，优先于冲突/开环；模拟 8 次 / 30 天 |
| 主动消息里 `conflict:*` | 近 30 天 7 条，且有一对重复问两遍 | 同对 7 天只问一次；`share` 可插队 |
| `self-authorship` 变更 | 0 | 白名单通道可用；9 条真机测试断言覆盖回滚 |
| `memory.reappraise` | 0 | 模拟 4 条 / 30 天，注入「后来再看」 |
| `source='life'` 记忆 | 0 | 模拟 29 条；注入带「我自己看到的」 |
| persona 回滚 | 假回滚（只恢复算法） | 真回滚（`changes.before` → `persona`） |
| 注入 token | 平均 507.8，峰值 800 | 新增两行平均 +26.8 token（有生活时），仍在 800 内 |
| 浏览端口 | `browse` 53 个全关 | 仍默认关；关时自动退化为「想一想」，不报错、不编造 |
| 事件查询 | `events` 无 agent 索引 | 有 `idx_event_agent` |

---

## 6. 还没做的 / 需要观察

1. **自修改 UI 那一栏还没接**。后端 `GET/POST /v1/agents/:id/author` 已通，设置页「自修改」还没有「她自己改的」列表和回滚按钮；现在只有 API。
2. **browse 端口默认关**，所以她多数时候只能「想一想」，还看不到「去看了」的真实生活。要真正上网，得在设置里开 `browse` 端口。
3. **反刍依赖 `affect_samples`**。老记忆没有当时情绪采样时，`changed` 会是 `null`（只记文本，不判变淡），模拟里已用样本覆盖验证。
4. **真模型内容质量**需要多跑几天：模拟用的是固定假模型，只能验证机制，评不了句子好不好。
5. **主动开口的分享**还要观察会不会变成「日更播报」；现在 3 天冷却 + `proactive` 每天 1 条双保险，真机上要看一周。

---

## 7. 回滚方式

- 关生活流：`agent_params` 写 `life.enabled = "off"`（或设置页后续接上）。
- 关反刍：`agent_params` 写 `reappraise.enabled = "off"`。
- 回滚她改的样子：`POST /v1/agents/:id/author/rollback { change_id }`。
- 关主动分享：`proactive` 的 `per_day` 设 0，或关 `enabled`。
