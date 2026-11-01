# 意识体 v6 · 修复规划 v1

> 拍板：会话方案 A（全局单 active）· 默认 retrieve v3 · C4 只修注入衰减（评价仍回合后）  
> 原则：尽量都修；按批可独立合并；每批有验收；不半吊子接线就删。

---

## 0. 范围与不做

**做**

- 审查里的严重 / 高 / 大部分中；低优先级里影响安全或明显死代码的一并收。
- 热路径与设计对齐：单一真相源、单一写入权威。

**不做（或只文档）**

- 按会话多实例绑定（方案 B）——本版不做，只清死代码。
- 把评价挪到生成前（本轮情绪进本轮回复）——本版不做。
- 大拆 `features.js`、PAD 与 v3 情绪合并成一套强度体系。
- 企业级 SSRF 策略（只做私网/link-local 黑名单）。

---

## 1. 产品语义（本版冻结）

| 点 | 本版行为 |
|----|----------|
| 会话 | 全局最多一个 `status=active`；所有会话共用它 |
| 推送 | 推到「最近有用户消息」的会话；无则跳过 |
| 召回 | 新默认 `memory.retrieve.formula=v3`；老库无覆盖则迁移写 v3 |
| 情绪注入 | 一律 `getAffect`（含衰减）；评价仍在 `commitTurn` 异步 |
| 关系 | 活账本 = `rel_person`；`relations` 只镜像/兼容读 |
| 驱力满足 | 只走过闸 `coupleAffectToDrive` |
| 主动消息 | 注入与 push 互斥；claim 成功才投递；必写 `delivered_at` |

---

## 2. 批次总览

| 批 | 主题 | 预估 | 依赖 |
|----|------|------|------|
| P0 | 纯 bug 止血 | 0.5d | 无 |
| P1 | 宿主热路径 + 单 active | 1d | P0 |
| P2 | 记忆管道 + 默认 v3 | 1–1.5d | P0 |
| P3 | 情绪 / 驱力 / 关系单路径 | 1–1.5d | P1 |
| P4 | 主动消息 + 行动安全 | 1d | P1 |
| P5 | 清理 / 夜间 / 文档 / 验收 | 0.5d | 前面 |

建议操控顺序：**P0 → P1 → P2 → P3 → P4 → P5**。  
你可以说「做 P0」或「做 P0 的 C6」来细控。

---

## 3. 分批明细

### P0 · 止血 ✅ 已完成

| ID | 任务 | 文件 | 做法 |
|----|------|------|------|
| P0.1 | buildEpisode TDZ | `archive.js` | 先算 `meaningful` 再 `titleSrc`；删无用 `firstUser` |
| P0.2 | curious 符号 | `affect_need.js` | `curious: { E: -1.0 }` |
| P0.3 | 「太」误判负 | `algo/gate.js` | `neg` 去掉裸「太」 |
| P0.4 | 冲突单写 | `memory.js` + `features.js` | `skipConflict`；极性改 `polarityFlip` |
| P0.5 | FTS 用 search_text | `archive.js` + `ops.js` | 重建/导入走 search_text |
| P0.6 | 抽取队列 | `extract_queue.js` | 原子 claim + `reclaimStuck` |

**验收**：`run-tests` 508/508；`p2` 34/34；`affect-gate` / `tiers` 含新用例。

---

### P1 · 宿主热路径 + 单 active ✅ 已完成

| ID | 任务 | 文件 | 做法 |
|----|------|------|------|
| P1.1 | 注入用 getAffect | `index.js` | `consciousnessBlock` 走 `getAffect` |
| P1.2 | 排他激活 | `features.ensureExclusiveActive`；create/resume/restore | 新建/恢复/继续都排他；导入短暂激活后还回 |
| P1.3 | 清死绑定 | `bindSession`/`bindingOf` 空实现；ping/health 去掉 `pending_agent` | README 写明单 active |
| P1.4 | lastSessions | `captureTurn` | 仅用户话更新 |
| P1.5 | 未用 import | `index.js` | 删 `expressionFrom`（P3.4 再接） |

**验收**：`run-tests` 510/510。

---

### P2 · 记忆 + 默认 v3 ✅

| ID | 任务 | 文件 | 做法 |
|----|------|------|------|
| P2.1 | 默认改 v3 | `kernel.js` PARAMS | `'memory.retrieve.formula': ['C3', 'v3']` |
| P2.2 | 老库迁移 | `db.js` 或启动钩子 | 无 `agent_params` 覆盖时写入 v3（或 schema 迁移一次） |
| P2.3 | 向量写入 | `memory.js` / `features.ingest` / `vector.js` | 落库成功后异步 embed + `writeVector`；失败静默；`clearVectorCache` |
| P2.4 | 向量尊重冷层 | `retrieve.js` `loadVectors`/`searchByVector` | 与词法同 `temp_state` / includeCold |
| P2.5 | searchByTerms 与升级 | `retrieve.js` | `includeSuperseded`；S1→S3 保留 `oldAccount` |
| P2.6 | 日记窗口 | `retrieve.js` | S1 日记默认 days 与文档对齐（30 或参数） |
| P2.7 | bandOf 时钟 | `tiers.js` | `bandOf(row, heat, at)` |

**验收**：新实例参数为 v3；新记忆有向量（有 embed 能力时）；`npm run eval:recall` 或现有 memory 测试；冷记忆不进 S1 向量路。

---

### P3 · 情绪 / 驱力 / 关系 ✅

| ID | 任务 | 文件 | 做法 |
|----|------|------|------|
| P3.1 | E→N 强度源 | `drive.js` `coupleAffectToDrive` | 用 episode intensity；`sig` 作增益 |
| P3.2 | curious 已在 P0 | — | 回归驱动 replay |
| P3.3 | 去掉 chat 硬编码满足 | `features.js` `chatReply` | 删 R/E/S 手写增量；改调 `evaluateDrive` / couple |
| P3.4 | 表达接线 | `affect.js` + `index.js` | `frameOf`/`expressionFrom` → 注入「说话分寸」一行；删重复硬编码 |
| P3.5 | 关系账本 | `persona.js` `tickRitual`；`selfview.js` | 读写 `rel_person`；必要时回写镜像 `relations` |
| P3.6 | ALGO_SLOTS 对齐 | `features.js` | deficit fallback → `v3`；与 PARAMS 一致 |
| P3.7 | shadow gate 日志 | `affect.js` | payload 分字段 `passed` / `emit` / `mode` |

**验收**：`npm run replay:drive`；仪式衰减后注入三轴变；设置页驱力/情绪技术视图不打架。

---

### P4 · 主动消息 + 行动安全 ✅

| ID | 任务 | 文件 | 做法 |
|----|------|------|------|
| P4.1 | 单投递 | `index.js` + `push.js` | push 开：先 `UPDATE … WHERE state='pending'` claim；成功才 `prompt`；注入跳过非 pending / 已 claim。push 关：仅注入并标 delivered + `delivered_at=now()` |
| P4.2 | delivered_at | `push.js` | 成功推送写 `delivered_at=now()`（勿 NULL） |
| P4.3 | settle 按会话 | `features.js` `settleProactiveAnswered` | 只结本 `sessionId` / 对应 proactive id，不全表刷 |
| P4.4 | action-config 脱敏 | `api.js` | GET 返回 `publicConfig`；PUT 空串=保留原密钥 |
| P4.5 | test 闸门 | `api.js` actions/test | `requirePort` + 预算或强制 dry-run |
| P4.6 | 预算时机 | `actions/index.js` | 成功后再 consume，或失败 refund；文案「本月」 |
| P4.7 | browse 私网 | `actions/index.js` | 拦 RFC1918 / link-local / localhost（可配置例外） |
| P4.8 | 发送显式 target | `channels.js` | 无 target 拒绝，不默认「文件传输助手」 |

**验收**：开 push 不双份；忽略冷却能统计；GET 无明文密钥；关端口 test 不真发。

---

### P5 · 收尾 ✅

| ID | 任务 | 做法 |
|----|------|------|
| P5.1 | nightly growValues | `nightly.js` 可选一步 `growValues({force})`（参数开关，默认 on） |
| P5.2 | consolidate keep:false | 真丢弃/supersede（非 dry_run） |
| P5.3 | journal recover | `recover` 顺带清 `fact_archive` / vec / links |
| P5.4 | 死代码 | 删未用 export 或注明；双 `getFlag` 收敛到 kernel |
| P5.5 | 文档 | README + `memory-layers.md`：默认 v3、单 active、投递语义 |
| P5.6 | 全量验收 | 见 §4 |

---

## 4. 验收清单

每批结束至少：

```bash
npm test
npm run check:arch
```

相关批额外：

```bash
npm run doctor -- --offline    # P1/P4
npm run eval:recall -- --fixture   # P2
npm run replay:drive           # P3
npm run test:actions           # P4
npm run test:memory            # P2
```

发布前：`npm run doctor`（在线）看 host 四缝。

---

## 5. 操控话术（给你用）

- 「做 P0」→ 整批止血  
- 「做 P0.1」→ 只改 TDZ  
- 「做 P1 到 P2」→ 连续两批  
- 「P2 先别迁老库，只改默认」→ 收窄范围  
- 「停，先提交」→ 当前批收尾 + 按你的要求 commit  

---

## 6. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 默认 v3 改变注入内容 | 参数可改回 v2；迁移只动「无覆盖」实例 |
| 向量回填吃 CPU | 异步、限速；无 embed 能力则跳过 |
| 排他激活影响多开习惯 | UI/文案说明「同时只能跑一个」；resume 会 pause 其它 |
| push claim 竞态 | `UPDATE WHERE pending` + changes 判断 |

回滚：按 git 批次回退；参数级回滚 retrieve→v2、expand→off、vector→off。

---

## 7. 完成定义

- 审查 Canvas 中严重/高项均有对应提交或「本版明确不做」记录  
- 热路径：注入衰减一致、单 active、v3 默认、投递不双份、密钥不泄 GET  
- `check:arch` + `test` 绿；doctor 无新增 fail  
