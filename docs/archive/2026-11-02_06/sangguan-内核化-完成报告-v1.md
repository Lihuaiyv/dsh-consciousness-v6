# 三观内核化 · 完成报告 v1

> 对应计划：[sangguan-内核化-plan-v1.md](./sangguan-内核化-plan-v1.md)
> 完成时间：2026-11-02
> 结论先行：**计划里的 P0–P5 全部落地并各自有测试；线上库的旧价值观残根已清零；三观账本第一次有了「违背 / 兑现 / 改主意 / κ」四类账。页面上的三个数还没接（后端接口已就绪）。**

---

## 1. 完成情况

| 阶段 | 做了什么 | 验收 |
|---|---|---|
| **P0 拔根** | 旧表停写（nightly 不再 `growValues`）、6 处读口换到命题折算、新库不再建 `persona_values`、4 条旧 seed 收回、导出/清除兼容缺表 | 线上库 `persona_values` 30 → **0 行**；V 层旧 seed 生效 4 → **0**；`test/kernel-p0` 9/9 |
| **P1 仪表** | `GET /sangguan/scorecard`（违背/兑现率/改主意/κ/进料/注入）、盲拆度量 `blind.js` + `scripts/blind-diff.mjs` | `kernel-p1` 9/9；线上库副本冒烟通过 |
| **P2 会疼** | `VIOLATE` 事件、π 负更新、30 天三次自动立案（κ）、注入里提一轮「刚才没做到」、默认 shadow | `kernel-p2` 14/14 |
| **P3 会欠账** | 承诺抽取（承诺词+期限词，否定/问句不记）→ 命题 + ν；到期无正面证据即 miss；兑现率有分母 | `kernel-p3` 17/17 |
| **P4 会改主意** | `REV` 必须写 `cost`、30 天额度（保护带 3 次 / 核心 1 次）、改完注入说一轮 | `kernel-p4` 8/8 |
| **P5 切 live 闸** | 四条件（影子 7 日、违背、已结算 ν、改主意、κ）+ 盲拆 > 0；三条反作弊测试 | `kernel-p5` 7/7 |
| **整体模拟** | 7 天生命周期：承诺→miss→三次违背→立案→改主意→攒影子→盲拆→过闸 | `kernel-e2e` 15/15 |

---

## 2. 前后数据对比

### 2.1 线上库（小汐 `agt_3977d80f17`）

| 指标 | 实现前（11-02 11:05） | 实现后（11-02 11:33） |
|---|---|---|
| `persona_values` 行数 | 30 | **0** |
| 新库是否建旧表 | 是（DDL 里） | **否** |
| 每夜重写旧表 | 是（`nightly` ⑧） | **否**（step 记为 `skipped: removed`） |
| 读旧表的地方 | 6 处（drive / lifeview / worldview / archive / persona / api） | **0** |
| V 层旧 seed 生效中 | 4 条（3 条小汐 + 1 条貅鹤） | **0**（4 条 withdrawn，账本 seq 1384–1387 可查） |
| 三观 κ / ν / 违背 / 改主意 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0（线上还没跑过新链路；机制在模拟里全部走通） |
| 注入 | shadow 第 2 天，151 token | 同（切 live 要过新闸） |

> 说明：线上库的四个计数仍是 0，是因为**进程还跑着旧代码**、且这几天没有新对话。重启后：`violate` 默认 shadow（只记不判账），`pledge` 立即生效，κ/改主意要真实发生才会有。

### 2.2 测试

| 套件 | 实现前 | 实现后 |
|---|---|---|
| `test:sangguan` | **红**：`g7` 因 `thoughts.js` 不导出 `gather` 直接崩，链路中断；单独跑 `s12-prompt` 5/10、`s13` 70/71、`g4-fix` 18/22 | **32/32 套件，1032 项全绿** |
| `test:kernel` | 不存在 | **7 套件 79 项全绿** |
| `run-tests.mjs` | 542/543（`表白名单 CI` 既有失败） | 542/543（**同一个**既有失败） |
| `check:arch` | 同一处既有的 INV10 白名单失败 | 同 |

测试里修掉的**开工前就存在**的问题（都不是本次功能引入）：
- `thoughts.js` 丢了 `gather` 导出 → g7 无法加载（已恢复导出，并把「未决矛盾」重新接回思绪素材）
- `ops.js` 丢了 `sangguan.ndjson` 导出、`purgeExpired` 不再清三观账本 → g4-fix 4 项失败（已恢复）
- `s12-prompt` 的 5 条断言对着已被删掉的「做法 / 按需尺度」机制 → 按当前契约重写（不是放宽，是换测得对）
- `ops.purgeExpired` 没调 `purgeOrphans` → s13 失败（已补）
- 新库缺 `persona_worldview` / `persona_lifeview` 两张表，fresh DB 直接崩（已补 DDL）

---

## 3. 改了哪些文件

新增（9 个源码/脚本 + 7 个测试）：

| 文件 | 作用 |
|---|---|
| `src/modules/sangguan/score.js` | 仪表盘 + live 闸 |
| `src/modules/sangguan/violate.js` | 违背判定、立案、注入提醒 |
| `src/modules/sangguan/pledge.js` | 承诺抽取、ν 登记、miss 结算 |
| `src/modules/sangguan/revision.js` | 改主意 + 代价 + 额度 |
| `src/modules/sangguan/blind.js` | 盲拆差异度量 |
| `src/modules/sangguan/retire.js` | 旧价值观残根清退 |
| `scripts/kernel-p0-retire.mjs` | 线上库迁移（带备份、dry-run） |
| `scripts/blind-diff.mjs` | 盲拆离线判定 |
| `scripts/kernel-smoke.mjs` | 真实库副本冒烟 |

修改：`db.js`、`api.js`、`persona.js`、`values.js`、`nightly.js`、`drive.js`、`worldview.js`、`lifeview.js`、`archive.js`、`features.js`、`ops.js`、`thoughts.js`、`index.js`、`package.json`，以及 `sangguan/` 下的 `catalog / machine / fold / config / inject / api / practice / elev / templates`。

新增事件：`VIOLATE`、`CLAIM_RETIRE`。新增模板：`J21`。

---

## 4. 偏离计划的地方（如实记）

1. **「撤三条种子」变成「收回四条」**：线上那 4 条 seed 已经各长过一笔证据（π=0.2、n=1），`CLAIM_WITHDRAW` 只收未占用的种子。为此新增了 `CLAIM_RETIRE`（保护带可收回，核心仍只能升维），终态 `withdrawn`，账本只增。
2. **P0 发现旧表是活的**：不只是三条句子，`nightly` 每晚在重写，且 drive/lifeview/worldview/archive 都还在读。计划里只写了「撤种子」，实际必须先换 6 个读口。
3. **页面三个数没做**：`client.js` 是 7000+ 行、且当前文件是 GBK 乱码状态，动它风险高于收益（今天已经因为一次整文件重写把 `templates.js` 写坏、从 `_audit` 备份恢复过一次）。`GET /sangguan/scorecard` 已可用，页面接三个数留作下一步。
4. **违背判定要模型**：没模型时返回 `no-judge`，**不落账**（不猜）。默认 `violate: shadow`，要显式改 `live` 才记账。
5. **盲拆没有真实样本**：`scripts/blind-diff.mjs` 能算，但 20 对真实回复要模型跑两遍才能采到；当前线上 `no_blind`，所以闸门不会放行。

---

## 5. 现在能用的命令

```powershell
npm run test:kernel        # 79 项：P0–P5 + 整体模拟
npm run test:sangguan      # 1032 项：三观全链路
node test/run-tests.mjs    # 542/543（剩 1 项是既有白名单失败）
node scripts/kernel-p0-retire.mjs --dry   # 只看会动什么，不写库
node scripts/kernel-smoke.mjs <库副本>     # 真实数据冒烟
node scripts/blind-diff.mjs pairs.json     # 盲拆差异率
```

闸门与读数：`GET /v1/agents/:id/sangguan/scorecard`、`GET .../sangguan/gate`、`POST .../sangguan/blind {rate,n}`。

---

## 6. 还没解决 / 下一步

1. **重启 DSH**，让新代码生效；然后看 `scorecard` 是否开始出数。
2. 采集 20 对盲拆样本 → `POST /sangguan/blind`，闸门才可能打开。
3. 三观页顶部三个数（后端已就绪）。
4. 线上 `violate` 从 shadow 切 live 前，先人工抽检 20 条 shadow 记录（误判率 < 20% 再切）。
5. 这套东西能到的是「有账可查的内核」，不是「有内心」——报告里的所有数字都只证明前者。
