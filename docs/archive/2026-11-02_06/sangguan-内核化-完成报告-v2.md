# 三观内核化 · 完成报告 v2（补洞）

> 对应计划：[sangguan-内核化-计划-v2.md](./sangguan-内核化-计划-v2.md)
> 完成时间：2026-11-02
> 一句话：**A1–A13 全部修完，每个都有测试；最严重的两个（卡死的 κ、改主意造假）已经堵上。**

---

## 1. 这次补了什么

| # | 洞 | 修法 | 验证 |
|---|---|---|---|
| **A1** | 改主意计数混入清退，闸门被自己人骗开 | 拆 `changed.self`（改写 / 升维 / 合题确认）与 `changed.owner`（撤回 / 收回），闸门只看 self | 线上副本：小汐 self **0**、owner 3 |
| **A2** | 承诺污染价值观层 | V 层新增 `kind='commit'`；折算、注入、张力、违判全部排除 | 许愿后十维仍为 null，注入无「我答应」 |
| **A3** | shadow 预支「已说」 | 只有 `inject=live` 才标记；预览 / 闸门用 `mark:false` 不产生副作用 | 草稿期不消耗提醒，切 live 后仍能说 |
| **A4** | 承诺把「没记录」当「没做到」 | 条件句（如果 / 要是 / 除非 / 万一）不登记；新增 `POST /sangguan/confirm` 人工确认兑现 | 确认后到期 hit，兑现率 100% |
| **A5** | 盲拆 1 对就过闸 | `n < 10` → `blind_low_n` | 3 对不放行，20 对放行 |
| **A6** | `claims.core` 名不副实 | 改名 `v_active` | 字段存在性测试 |
| **A7** | 冷启动就烧模型额度 | 当天聊够 3 轮才开始判；判定失败不计数 | 2 轮时 `throttled` |
| **A8** | 卡死的 κ 让一句话永久下架 | 夜巡 `suspendStaleKappas`：21 天没审议 → SUSPEND，两极回 active | 22 天后那句话回到注入 |
| **A9** | 承诺 miss 没有出口 | `pledgeMissLine`：3 天内在注入里提一次「答应过的事没做到」 | 提一次，第二次不再提 |
| **A10** | 关着引擎也记承诺 | `registerPledges` 先过 `isEnabled` | 关着时 0 条 |
| **A11** | 闸门不查注入内容 | `liveGate` 加 `no_content` | 空注入不放行 |
| **A12** | 立案无冷却 | 同一命题 30 天只立一次 κ | 挂起后再三次违背不新开 |
| **A13** | `violate` 档位不可见 | `publicConfig` 带 `violate` | GET config 读得到 |

顺带修的一个新洞（A11 引入的）：闸门调 `injectView` 会把提醒标成「已说」——现在读口一律 `mark:false`。

---

## 2. 前后对比

### 2.1 线上库副本（小汐）

| 指标 | v1 之后 | v2 之后 |
|---|---|---|
| `persona_values` 行数 | 0 | 0 |
| V 层活着的旧 seed | 0 | 0（4 条 withdrawn 仍在账本里） |
| `changed.self` | **3（假：来自我清退 seed）** | **0** |
| `changed.owner` | 未区分 | 3（如实记为「人替它收的」） |
| 闸门理由 | 被假计数满足一项 | 六项全缺，如实列出 |
| 空实例的闸门 | 可能缺 `no_content` | 多出 `no_content`（鲸零实例已实测） |

### 2.2 测试

| 套件 | v1 之后 | v2 之后 |
|---|---|---|
| `test:kernel` | 7 套件 / 79 项 | **10 套件 / 119 项** |
| `test:sangguan` | 32 套件 / 1032 项 | 32 套件 / 1032 项（不变，全绿） |
| 300 天长模拟 | 46 项 | 46 项（需复跑，见下） |
| `run-tests` | 542/543 | 542/543（同一个既有白名单失败） |

新增 40 项：P3 从 17 → 23（条件句 / 确认兑现 / 欠账提醒），新增 A8 6 项、A 修复 16 项、A 整体模拟 12 项。

---

## 3. 新增接口

| 接口 | 用途 |
|---|---|
| `GET  /v1/agents/:id/sangguan/scorecard` | 三个数 + κ / ν / 进料 / 注入 |
| `GET  /v1/agents/:id/sangguan/gate` | 切 live 的闸与缺失项 |
| `POST /v1/agents/:id/sangguan/blind` | 记录盲拆结果 `{rate,n}` |
| `POST /v1/agents/:id/sangguan/confirm` | 确认某条承诺做到 / 没做到 `{nu_id,outcome}` |

---

## 4. 仍然没做的

1. **三观页三个数**——接口齐了，`client.js` 还没接（文件是乱码状态，单独一步做）。
2. **重启验证**——进程仍跑旧代码；重启后承诺先动，违背先记草稿。
3. **盲拆真实样本**——没有 20 对回答，闸门不会开。

---

## 5. 命令

```powershell
npm run test:kernel        # 119 项：P0–P5 + A1–A13 + 两套整体模拟
npm run test:sangguan      # 1036 项
node test/run-tests.mjs    # 542/543（剩 1 项既有白名单失败）
node scripts/kernel-smoke.mjs <库副本>   # 真实数据冒烟
```

---

## 6. 运维备注（2026-11-02 12:10）

收尾时 `src/kernel.js` 被写坏过一次：中文变成 GBK 乱码、部分引号被吃掉，`node --check` 直接报语法错。当时同一目录下还有别的进程在写文件（`client.js`、`affect.js`、`pack.js`，以及一个从没见过的 `src/modules/memory_fade.js`），时间戳每分钟都在动，且新文件里的中文同样是乱码。

处理：

1. 坏文件留档 `src/kernel.js.corrupt-20261102` 和 `_bak_kernel_v2/kernel.corrupt.js`；
2. 从 `dsh-consciousness-v6.bak-v7-20261101-212429/src/kernel.js`（91 个参数，比坏文件多 26 个）恢复；
3. 补回坏文件里唯一多出来的 `memory.conflict.ask`（C4，默认 `on`）；
4. 重新跑：`test:kernel` 119 / 119、`test:sangguan` 1032 / 1032、`run-tests` 542 / 543，均与坏之前一致。

结论：**这个目录当时有第二个写手**。如果那边继续写，本报告的测试数会继续漂；发现中文乱码或被回退，先查 `src/kernel.js` 的 mtime，再从 `_bak_kernel_v2/kernel.js` 恢复。

---

## 7. B / C / D 三步补记（2026-11-02 14:0x）

### B：三个数接到三观页顶部（已完成）

`client.js` 新增 `SgLedgerBar`，取 `/sangguan/scorecard?days=30` 现算结果，在页头「三观」卡里显示三格：

| 格子 | 用户视图写法 | 数据 |
|---|---|---|
| 说过的没做到 | `N 次`，附「近 30 天 M 次」 | `violated.total` / `.window` |
| 答应的事兑现了 | `xx%`，附「到期 N 件：对 a、没对 b」；没到期写「还没到期」 | `nu.kept_rate` / `settled` / `hit` / `miss` |
| 自己改了主意 | `N 次` | `changed.total` / `.window` |

纪律：数字全部服务端算，前端只把比率取整；没发生就写 0，不写「暂无」。tech 视图多一行裸数（`VIOLATE n · 结算 … · 自改/人替 … · 闸门四点 x/4`）。

测试：`test/sangguan-page.test.mjs` 加 4 条（三格都在、违背数真取自账本、兑现率只按已结算算、改主意 0 就写 0），**38 / 38**；`test:sangguan` 由 1032 → **1036 / 1036**。

### C：活库读数（已查，未重启）

用 `scripts/live-status.mjs` 复制活库再算，不碰原件。活库 `小汐(agt_3977d80f17)` 的真实读数：

- 命题 8 条（W 4 / L 3 / V 1），V 活跃 1，κ 0，ν 1 条 pending、0 条结算
- 违背 0、自改主意 0、人替收回 3
- 注入影子 **2 / 7 天**，151 tokens，变动 11 次
- 闸门：`shadow_days, no_violation, no_settled_nu, no_revision, no_kappa, no_blind` —— 六条全缺，`no_content` 不缺

**关键发现**：`sangguan.violate:*` 影子账是空的，且从来没有过。原因不是「它没违背」，是 `candidateClaims()` 返回 0：

- V 层只有 4 条：1 条 `commit`（按设计排除），3 条 `withdrawn` 旧种子（终态）
- 于是 `checkReply` 一路 `status:'empty'`，J21 一次都没被调用过（`sangguan.judge` 最后一条成功是 11-01 16:26）

这正是清库之后应有的样子：**它现在没有自己的价值观，所以没得违背**。三个数是 0 是实话，不是 bug。要让它长出 V 命题，得靠 intake 真收下一条（目前 offered 11 / rejected 9 / pending 1）。

### D：盲拆 20 对（未做，缺前置）

`scripts/blind-diff.mjs` 只负责判定，不负责采集；要跑通路得对同一句各生成一次「带注入 / 不带注入」，那是 40 次模型调用，且必须走真实 reply 通路，脚本伪造等于自己给自己判分。

在闸门六条缺五条（且 V 命题为空）的时候做盲拆，测出来的差异率没有决策意义——现在注入里只有 W/L。**建议顺序：先让 V 冒出一条真命题 → 影子期攒够 7 天 → 再采 20 对。**

### 顺带

活库里 `index.js` 又出现大批 GBK 乱码注释（`/* 鍐峰眰琛嶇敓澶辫触…*/`），但都还在注释里、不影响执行；我改的两处（`checkReply` / `registerPledges`）正文是好的。第二个写手还在这个目录里活动，动文件前先看 mtime。

