# 三观页「三列 + 草稿入口」· 完成报告 v1

> 对应计划：`docs/sangguan-页面-三列与草稿入口-计划-v1.md`。承接上一轮 `docs/sangguan-改造-完成报告-v1.md`（步骤 0–4）。
> 完成时间：2026-11-03。改动全部在 `dsh-plugin` 内，未动线上库（只对副本做了冒烟）。

## 1. 一句话

页面从「三层竖排 + 页头三个数」改成「三列各写自己的判据 + 一个草稿收件箱 + 一句召回预览」，三个数搬到概览的「它靠不靠谱」；草稿成为价值观唯一入口，自动起草出的稿也要人批、五闸全过才入库。上一轮遗留的三个尾巴（日记进 L、J1 抽 W/L、夜巡不接起草）一并收掉。

## 2. 做了什么

| 步骤 | 产物 | 验证 |
|---|---|---|
| P1 数据层 | `schema.js` 新表 `sangguan_drafts`；`draftstore.js`（建/列/改/弃/去重/计数）；`draft.gatesOf(...,{source})` 手写分档 | `sangguan-draftstore` 32 项 |
| P2 取料共用 | `draftfeed.js`（HONESTY/REDO/TRADEOFF/去重从脚本搬出）；`scripts/sangguan-draft.mjs` 改为 import | `sangguan-draftfeed` 17 项；脚本真库只读跑通（3000 回合 → 40 条） |
| P3 起草流水线 | `draftrun.js`：J32 标注 → 按放弃物聚类 → J33 起草 → 过闸进收件箱；后台任务 + 10 分钟卡死重起 + 30 天去重 | `sangguan-draftrun` 25 项 |
| P4 HTTP | `GET /drafts`、`POST /drafts`、`patch/commit/discard`、`POST /drafts/generate`、`GET /recall`、`inject/preview?text=`；`status` 带 `lanes/constitution/drafts`；`config` 回显 lanes 并接受写入 | `sangguan-drafts-api` 29 项 |
| P5 页面三列 | `client.js`：`.dshc-sg3` 响应式三列；每列判据 / 开关 / 核心 / 辅助 / 在争 / 「怎么长出来的」；召回预览框 | `sangguan-page` 扩到 53 项 |
| P6 草稿箱 UI | `SgDraftCard`（改 / 入库 / 丢掉、五闸人话标签、证据）；`SgDraftNew`（手写一条，日期 + 原话 + 「我认」）；三个数搬到 `SimpleHome` | 同上（点入库后账本多一条 V/norm origin=user） |
| P7 收口 | 日记 / 志向在 `lanes.L` 打开时不再进 L；`lanes.W/L` 打开时 J1 不再抽 W/L、不再给 W/L 链头，落库前再拦一次；夜巡每周起草（仅 `lanes.V`，`sg:draft:<isoWeek>` 幂等） | `sangguan-intake-lane` 6 项 + `sangguan-j1-lane` 11 项 |
| P8 回归 | 全量 + 长模拟 + 真库副本冒烟 + 本报告 | 见 §5 |

页面结构：

```
三观（一张卡里）
├ 三列：世界观 / 人生观 / 价值观（每列自己的判据与证据）
└ 召回：拿一句话试试它会想起什么 → 常驻 + 这一会儿会想起
草稿箱：现在起草 / 写一条 → 每条草稿（改 / 入库 / 丢掉）
预见与回流 / 它最近在想什么 / 史 / 旧维度仪表（保留，旧仪表默认折叠）
```

## 3. 五闸的力度（手写也过闸）

| 闸 | 自动稿 | 手写稿 |
|---|---|---|
| G1 有另一条路 | alt 非空 | 同左 |
| G2 有代价 | foregone 非空且不是「没什么」 | 同左，关键词也算 |
| G3 能排除 | exclusion 非空 | 同左 |
| G4 不是任务 | 窄任务词表 | 同一套 |
| G5 有生活作证 | ≥2 条、跨 ≥2 天 | ≥1 条带日期的真事 + 勾「这条我认」 |

落法：`gatesOf(d, cluster, {source:'manual'})`；`source` 与 `vouch` 落库，tech 视图可查；没有「强制入库」暗门。

## 4. 真库副本对照（不算模拟，是真的历史）

`scripts/sangguan-page-smoke.mjs` 用 `VACUUM INTO` 取线上库的一致副本，在副本上开三列再走一遍：

| 项 | 改造前（三列关） | 开三列后 |
|---|---|---|
| 真历史 | 3285 回合，W0 / L1 / V0 | 同左（库没被改） |
| 注入内容 | 4 行 / 79 tokens（每层链头 + 改主意 + 欠账 + 想问） | 4 行 / 83 tokens（常驻 L 全文 + 改主意 + 欠账 + 想问） |
| 常驻宪章 | 无 | 1 行 / 27 tokens（只有 L 一条，W/V 空着就空着） |
| 日记进 L | 会（intake 把 diaries 搬进 L） | **0 条**（L 开着就整段不进） |
| 取料 | 无入口 | 60 个取舍现场（诚实 36 / 自述 23 / 欠账 1） |
| 手写一条入库 | 无入口 | 五闸全过 → V/norm，`origin=user`，V 从 0 变 1 |

注入行数没有变少（4→4），但内容换了：以前是「每层取三条链头」碰运气，现在是「常驻一条 + 欠账 + 想问」；常驻那条还是全文，不再被截成「…」。

## 5. 测试与验证

- 三观专项：**52 套 / 1402 项全绿**（新增 7 套：draftstore 36、draftfeed 17、draftrun 28、drafts-api 31、intake-lane 6、j1-lane 11、values-lane 5；页面测试从 34 项扩到 53 项）。
- 全项目：`node test/run-tests.mjs` **546 / 546**（含完整清单同步）。
- 长模拟：G3 三百天 **20 / 20**，G4 两百天 **26 / 26**。
- 真机：服务端代码要重启 DSH 才生效；页面刷新即可看到（详见 §7）。

## 6. 过程中发现并修掉的问题

第一轮：

1. `PUT /config` 没转发 `lanes`：页面开关点了不报错也不生效（测试先红）。
2. 草稿去重只查开口的，入库后同文 30 天内还能再进箱 → 把 `committed` 也算进去。
3. 三列里 `belts` 多加了 `status==='active'` 过滤，把「在争」的命题藏了 → 恢复旧口径。
4. 三列注入只拼了 `lane + kappa + summary + precedent`，把「改主意 / 欠账 / 想问」三行弄丢了 → 补回（这几行管兑现，不是链头）。
5. 夜巡调 `runDraftRound(db, aid, now, opt)` 参数顺序错，会把 `now` 当 `opt`。
6. `catalog.json` 没随页面新增的「草稿箱」区块更新，`run-tests` 唯一一项失败 → 重新生成。
7. 测试里「10 分钟卡死」用了未来时间戳，阈值判断方向反了。
8. 手写草稿的日期证据如果只写 `2026-11-01`，`Date.parse` 在部分环境当 UTC；统一只留 `YYYY-MM-DD` 并只做格式判断，不参与时区换算。
9. 冒烟脚本用只读连接 `VACUUM INTO` 不行，改用普通连接（`VACUUM INTO` 本身不改源库）。

复查追加（2026-11-03 下午）：

10. **同一条草稿点两次「入库」会先写一条重复 V、再报 409**：提交前没查草稿状态 → 先查 `draft/edited` 再写，第二次直接 409 且账本不增。
11. **硬删 agent 不清草稿**：`purgeAgent` 只清 L0/投影/flags，`sangguan_drafts` 和 `sangguan.draftjob:<aid>` 会留孤儿 → 一起清，`purgeOrphans` 也把只有草稿的 agent 捞回来清。
12. **V 列打开后 `values_intake` 仍自动把志向 / 关系 / 驱力缺口写成 V**：绕过了草稿箱 → V 列一开就跳过机器进料；人自己写的那条（`claimUserValue`）保留。
13. **起草流水线没把 `chat` 转给 J32/J33**：测试或自定义端点会被绕过、偷偷走宿主模型 → 统一用 `ctx.chat` 转发。
14. 复查时撞到 `pulse.js` 正在被另一处编辑（`consumeSurface` 还没导出就已被 index.js 引用），是写入中途的瞬时状态，重跑即过，不属于本次功能。复盘记一笔：改同一插件时别把测试跑在别人写到一半的文件上。

## 7. 怎么开、怎么退

1. **重启 DSH**（服务端模块改了；只刷新页面不够）。
2. 打开「设置 → 意识 → 三观」，三列各有「打开这一列」；也可以 `PUT /v1/agents/:id/sangguan/config {"lanes":{"W":true,"L":true,"V":true}}`。
3. 建议先只开 W 跑一周，再开 L；V 一开，夜巡每周会起草一轮，进收件箱等你批。
4. 退回：把 `lanes` 三项设回 `false`，页面回旧取法；草稿表可以留着，不影响账本。
5. 线上库没有被动过；这次只对副本做了冒烟。

## 8. 本期没做

- 合并 / 去重界面（`merge.js` 有能力，等真出现重复再说）。
- J34 模型二段召回（仍是字面召回，零成本、可复现）。
- 从命令行草稿文件导入收件箱。
- 月度复盘指标进 `eval.js`。
