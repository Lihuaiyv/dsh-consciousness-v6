# 记忆连续性 · 2026-11-02

上一轮把表达层松开了；这一轮接的是「她知不知道自己隔了多久、是不是同一个人」。

## 做了什么

1. **时间距离（`src/modules/presence.js`）**
   查最近一条 `chat_turns`，把间隔翻成人话：刚才 / 不到一小时前 / 今天早些时候 / 昨天 / 三天前 / 一个多星期前 / 半个多月前 / 一两个月前 / 好久以前。
   注入里那行从「现在：下午」变成「现在：下午；上次说话是三天前；我上一句说的是「…」」。
   只读，不写；`sessionBridge` 仍然管「上次聊到什么」，两者分工不重复。

2. **「今天的她」攒成线（`src/modules/selfnote.js`）**
   从单个 flag 改成按天存，保留最近七天；注入读今天一条 + 往前两天一条（合并成一行）。
   夜巡 ⑬ 写入走 `writeNote`，同一天覆盖；没模型 / 空回复 / 抛错都只跳过。
   走 flags 不走新表：新表要同时动 db.js、导入导出白名单、清理任务、INV10 四处，先功能后形态。

3. **主动开口按「事」触发（`features.js`）**
   新增 `proactiveTriggerOf`：到期开环（`open_loops`）就是事由。
   `decideSpeak` 收到事由时：越过缺口门槛和额度一天一次，但**夜间静默、气头上、预算、开关**一个都不松；说出来后 `markLoopsFired` 把这件事标掉，不重复念。

4. **快情绪影子档（只算不生效）**
   `expressionState` 多返回 `fast` 和 `wouldLevel`；`level` 仍然只看慢情绪。
   `scripts/fast-shadow-report.mjs` 出网格数据：80 种组合里会改档 18 种（抬 6 / 压 12）。
   报告见 `docs/fast-shadow-2026-11-02.md`。接不接由你定；数据上看，先只接「抬档」比较稳。

5. **评测从 24 涨到 30 条**
   补：吃醋、被夸到开心（warm 档）、久别三天、隔一周、生闷气、深夜。
   场景可带 `affect`（指定这一轮的情绪底色）和 `days`（把历史往前挪几天）。
   顺手修了评测里的一个方法错误：注入快照原来在回话之后取，最新的那句就是「刚才」，
   时间距离全被抹平；改成回话之前取——那才是她真正看到的东西。

6. **清债**
   三个旧脚本（`sim-turns`、`bench-style`、`sim-real-prompt`）的断言改成新文案。
   新增 `npm run check:encoding`：扫双重编码的中文行，只报告不自动改（原意丢了，猜比坏更糟）。
   当前存量 **91 行 / 61 个文件**，集中在老 docs 和注释；本轮新写的文件 0 行。

## 前后数字

| 项 | 上一轮 | 这一轮 |
|----|--------|--------|
| 评测场景 | 24 | 30 |
| 注入平均 token | 465 | 494（+6.2%，仍在 800 预算内） |
| 注入里有「上次说话是…」 | 0 | 30 / 30 |
| 其中「今天早些时候」 | — | 24 |
| 其中「三天前」「一个多星期前」 | — | 各 1（专门造的场景） |
| 注入里有「早些时候我写下的」 | 0 | 30 / 30 |
| 注入里有「前两天写下的」 | 0 | 30 / 30 |
| 吃醋样本出现 | 0 | 2 |
| 评测硬伤 | 0 | 0 |
| 新增测试 | — | presence 24 / selfnote 20 / proactive 12 / shadow 58 |
| 主测试 | 544 / 544 | 544 / 544 |
| `test:humanlike` / `test:kernel` / `test:relations` / `test:sangguan` / `check:arch` | 全绿 | 全绿 |

## 只能真机验 / 还没做的

- 模型路仍然只能在装了模型的实例里跑 `npm run eval:persona -- --model`。
- 主动开口的事由只在 `decideSpeak` 层验证过；真机上要观察它是不是「只在有事时说，不变成每天定点提醒」。
- 快情绪「抬档」还没接线，等你定。
- 编码存量 91 行是历史债，本机无法还原原意；`npm run check:encoding` 会一直报着，别涨就行。

## 复跑

```bash
node test/presence.test.mjs
node test/self-note.test.mjs
node test/proactive-triggers.test.mjs
node test/fast-shadow.test.mjs
node scripts/fast-shadow-report.mjs
npm run eval:persona -- --label v2
npm run check:encoding
```
