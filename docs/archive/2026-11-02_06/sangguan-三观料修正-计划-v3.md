# 三观料修正 · 计划 v3

> 起因：2026-11-02 看真机三观页，页首四行是三份工程笔记和一条承诺：
> 「电脑关机或插件没开，这套服务就不存在，微信也发不出去」「先做开机自启和后台守护，再考虑上服务器」「我答应：不是今天哪个设置改了把我的语气改掉的」。
> 看起来蠢，不是排版问题，是进料问题。

## 0. 病灶（都已取证）

| # | 事实 | 证据 |
|---|---|---|
| P1 | W1 只查形式，不查「是不是立场」 | `gates.js:70 fieldCheck` 只查层 / 种类 / text 长度 / 模型自评 / 元叙述 / 指令 |
| P2 | 抽取把「对话在聊什么」当成「它的看法」 | 活库 8 条命题全部 `origin=extract`、`actor=sys`、refs 空，11-01 16:26:57 同一秒入账 |
| P3 | 生长序反了 | 图纸要求 V → PRESSURE → L → W（logic-gates 生长序）；活库是 W 4 / L 3 / V 0 |
| P4 | `commit` 冒充价值观 | `pledge.js:99` 把承诺写成 `layer=V, kind=commit`；三观页 `belts('V')` 不过滤 |
| P5 | 承诺抽取把疑问句变成承诺 | 「我答应：不是今天哪个设置改了把我的语气改掉的」来自一句问句 |
| P6 | 冲突进 W 的通道裸奔 | `intake.js:61-62` 直接 `a.slice(0,300)`，连 `stanceText` 都不过 |
| P7 | 库里已有 5 条工程记录 | W 4 条全是工程事实，L 1 条是待办计划 |

对应图纸：`~/.cursor/projects/.../canvases/sangguan-logic-gates.canvas.tsx`（规则真源）、`sangguan-master-plan.canvas.tsx`（进料来源表）、`sangguan-philosophy-design.canvas.tsx`（生长序与戒条）。

## 1. 目标与不做什么

**目标**：三观层里只留三类句子——世界是怎样的、它为何在、它更看重什么。工程事实、待办、承诺不许进来（承诺走预言 / 兑现那条账）。

**不做**：
- 不改账本 schema、不动 `fold.js` 纯函数约定、不改事件目录。
- 不引入「大关键词表」当语义理解：闸只做两条可辩护的判定（有没有取向词；有没有工程名词），拒收一律记 `REJECT + gate_report.reason`，可回查。
- 不为了让页面上有东西而放行候选：空着就写「尚未立论」。

## 2. 步骤

### P0 取证与备份（不写代码）

- 备份活库 `app.db` → `app.db.bak-sangguan-stance-<ts>`（含 -wal/-shm）。
- 备份将改的文件：`gates.js`、`intake.js`、`values_intake.js`、`pledge.js`、`client.js`。
- 记基线：`test:kernel` 119、`test:sangguan` 1036、活库 `scorecard` 全字段、gate reasons 六条。
- 验收：基线数字写进本文件末尾的「前后对比」表。

### P1 立场闸 `stanceGate(text)`

- 位置：`gates.js`，挂在 `fieldCheck` 里（`W1` 之后）。
- 判定：
  - 有取向词（看重 / 在意 / 认为 / 觉得 / 相信 / 应该 / 值得 / 宁可 / 宁愿 / 愿意 / 不肯 / 不接受 / 更喜欢 / 更重要 / 更想 / 讨厌 / 喜欢 / 好过）→ 放行。
  - 无取向词且命中工程名词（插件 / 代码 / 测试 / 脚本 / 接口 / 数据库 / 服务器 / 配置 / 部署 / 文件 / 日志 / 版本 / 线上 / 本机 / 微信 / 设置 / 功能 / 报错 / 端口 / 进程 / 依赖 / 仓库 / 提交 / 分支）→ 拒，`reason: 'not_stance'`。
  - 无取向词且是待办句（先…再… / 下一步 / 需要 / 要做 / 得先 / 计划 / 待办）→ 拒，`reason: 'not_stance'`。
  - 原有 selfEval / metaSummary / instructionLike 全部保留，顺序在它们之后。
- 覆盖：`fieldCheck` 已被 `fast.js:213 / 307`（抽取）、`gates.js:103 classify`、`values_intake.js:178` 调用，一处改全覆盖。
- 测试：新增 `test/sangguan-stance.test.mjs`，正例 8（含「人多数时候愿意讲道理」「汐是夜里涨落的潮水…」「我更看重照顾身边的人」）、反例 8（上面那三句 + 「线上 536 个测试全过」等）。**要求：现有 1036 项一条不能掉**（怕是误杀真立场，掉一条就停下来看是哪条）。
- 风险：误杀。缓解：拒收全带 reason，跑完后看 `REJECT` 里有没有真立场句。

### P2 进料通道补丁

- `intake.js` 冲突 → W：`a.slice(0,300)` 改为先过 `stanceText` 再过 `stanceGate`，不过就记 `REJECT`。
- `intake.js` 志向 / 日记 → L：同样补 `stanceGate`（现在只有 `stanceText`）。
- `values_intake.offerValue`：`fieldCheck` 已带闸，确认无重复调用。
- 测试：模拟三类来源各 3 例（工程句被拒、立场句进来、待办被拒）。

### P3 承诺归位

- `pledge.js`：抽取前先排除疑问句（含 ？ / 吗 / 呢 / 是不是 / 有没有），且 `commit` 文本不得由「我答应：」拼接从句产生；文本不合法就整条不登记。
- `client.js` 三观页：`belts('V')` 与 `headLine` 过滤掉 `kind === 'commit'`；承诺只出现在「预见与回流」区（那里已有 ν）。
- 测试：page test 断言价值观区不出现「我答应」；pledge 单测断言问句不登记。

### P4 生长序（先设计，默认关）

- 规则草案：V 层无任何活命题时，W 层新增保护带须记 `REJECT`（世界信念该由 L 的实践失败逼出来，不是先长出来）。参数 `theta('growth_order')`，默认 `off`，先在模拟里跑。
- 这一条影响面最大，单独一个开关；跑通模拟、确认不误伤 S 系列测试后再议是否默认开。
- 验收：模拟 300 天，V 空 → W 不新增；V 有 → W 正常长。

### P5 清库（一次性脚本）

- `scripts/sangguan-prune-facts.mjs`：扫活库里所有 active 非核心命题，跑 `stanceGate`，命中的列清单。
- 两步走：先 `--dry` 打印（哪条、为什么、哪条事件带进来的），人工确认后再执行。
- 执行方式：写 `CLAIM_RETIRE`（`actor=user`），**不删行**，账留着。
- 注意 A1：清退走 `CHANGE_OWNER`，不计入「自己改主意」，不会把 live gate 骗开。
- 验收：清完 `scorecard.claims.by_layer` 变化符合预期；`changed.owner` +N，`changed.self` 不变；gate 仍六条缺。

### P6 页面收尾

- 空层不硬撑：显示「还没有立论」+ 一句为什么（例如「这段时间没出现让它在取舍上动心的事」）。
- 三个数旁边加折叠说明：这三个数怎么算的、为什么现在都是 0。
- `build-catalog.mjs` 要重跑（改 client.js 的 Sec / FoldBlock 之后）。
- 测试：page test 加断言。

### P7 回归与对比

- `npm run test:kernel`（119）、`npm run test:sangguan`（1036 + 新增）、`node test/run-tests.mjs`、`check:arch`。
- 长模拟：G3 300 天 + G4 200 天。
- 出「前后对比」表：命题分布、被拒候选数（`REJECT` 里 reason 分布）、gate reasons、页面截图。

### P8 真机观察（3 天）

- 重启后观察：`REJECT[not_stance]` 比例、V 是否长出第一条真命题、κ 是否仍为 0。
- 判据：三天里若 `not_stance` 占比 > 50%，说明对话本身在聊工程，进料没料是对的；若 < 10%，说明闸可能过宽，回头看被放行的样本。

## 3. 顺序理由

P1 先行，因为它是唯一的「源头闸」，后面几项都在它放行之后才有意义；P2 是补漏（不同通道）；P3 与 P1 无关、可并行；P5 必须等 P1 装上再跑，否则清完还会再进；P4 影响最大放最后，且先给开关不给默认。

## 4. 前后对比（P0 记，P7 填）

| 项 | 改前 | 改后 |
|---|---|---|
| 命题分布 | W 4 / L 3 / V 1（commit） | |
| 页面页首 | 四行工程笔记 | |
| `test:kernel` | 119 / 119 | |
| `test:sangguan` | 1036 / 1036 | |
| 活库 gate reasons | shadow_days, no_violation, no_settled_nu, no_revision, no_kappa, no_blind | |
| `not_stance` 拒收 | 无此概念 | |
