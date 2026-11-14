# 三观改造 · 改进计划 v2（代码级）

> 相对 v1 的变化：先做了一轮逻辑审查，找出 8 个会让计划跑不通的问题，逐个改掉；然后把每一步落到文件、函数、SQL、事件序列和测试名。
>
> 结论先说：**W 和 L 不该在快环里抽，应该挪到夜巡批量做**。这一条改完，成本、场景计数、向量复用三个问题一起解决。原计划里「P1 改 fast.js」是错的。

---

## 0. 逻辑审查：8 个问题

| # | 严重度 | 问题 | 后果 | 修正 |
|---|---|---|---|---|
| B1 | 致命 | `growth_order` 死锁：V 空 → W 不进；可 V 要真实取舍才长，工程对话里没有取舍 → V 永远空 → W 永远不长 | 改造后一列都长不出来 | 只挡「W 立核心」，不挡 W 保护带；W 核心加第二条出路：≥2 次结算且 ≥1 次 miss |
| B2 | 致命 | W 的预见会退化成 V：预期写成「我下次先听完」，测的是我的行为，不是世界 | 三列又混回一堆 | `expectation` 必须描述对方/世界，且 `observe` 在她不干预时也能观测；闸里拒「我…」型预期 |
| B3 | 高 | 新加 `confidence` 与现有 `π` 语义重复 | 同一件事两个数，互相打架 | 删 `confidence`，用 π；W 的强度 = π 的绝对值 + 连续命中次数 |
| B4 | 高 | L 的「投入证据」在库里不存在：`action_log` 只有 9 条，对话文本不是时间 | L 只能靠嘴说，永远到不了核心 | `invest` 只从 `action_log` + 回合类型统计来；承认 L 两周内只能停在保护带 |
| B5 | 高 | 「合并成一条多说法」要 UPDATE，但命题表有触发器，不可改 | 合并写不进去 | 新建一条 + RETIRE 旧两条 + 新条 `variants` 记旧 id，一个批次写完 |
| B6 | 中 | 清退 V 的 `commit` 会留下悬空 ν：pledge 的 `nu.claim_id` 指向已退休命题 | 页面「预见与回流」出空指针 | 清退前先 `NU_RESOLVE(outcome=void)` 掉未结的 ν，再 RETIRE |
| B7 | 中 | 注入预算 160 字装不下「核心 3 + 召回 2」 | 一接就爆，退回每层 3 条 | 预算改 520 字（≈260 token），超了先丢召回，再丢矛盾对 |
| B8 | 中 | W 的「跨场景计数」需要向量，但 `persona_claims` 没有 embedding | P1 卡在检索 | W/L 抽取挪到夜巡，复用 `memory_vec`；claim 只存 `scene` 文本 |

附带修正两处表述：`DERIVES` 方向定为「核心 → 下条」（推出方向）；P1 的改动点从 `fast.js` 改为 `night.js`。

---

## 1. 数据模型

### 1.1 加列（幂等）

```sql
-- ensureSangguanSchema 里，CREATE 之后执行；先查 pragma，有就跳过
ALTER TABLE persona_claims     ADD COLUMN meta_json TEXT;
ALTER TABLE claim_proj_claim   ADD COLUMN meta_json TEXT;
```

`meta_json` 结构（全部可缺省，读时给默认）：

```json
{
  "scene": ["你说数据不对的时候", "你催我、我又还没验完的时候"],
  "expectation": "下次你倒苦水，我给方案，你会更冷",
  "observe": "你说完难受后我给了方案，你隔了很久只回一个字",
  "falsifier": "你明确说想要方案",
  "direction": "做一个能把话接住的人",
  "investment": [{"ref": "act:...", "kind": "act", "at": "..."}],
  "variants": [{"text": "旧说法", "claim_id": "cl_...", "at": "..."}],
  "derives": ["cl_..."],
  "lane_phase": "W-nightly | L-weekly | V-fast"
}
```

### 1.2 目录扩两项

```js
// catalog.js
export const EDGE_TYPES = Object.freeze(['DEPENDS', 'CONSTRAINS', 'PRESSURE', 'CITES', 'DERIVES'])
export const EVIDENCE_KINDS = Object.freeze(['act', 'verdict', 'check', 'invest'])
```

`DERIVES` 方向：核心 → 下条（「这条推出了哪些下条」）。查「这条被哪条推出」走反查索引。

### 1.3 不新增表

不建 `claim_meta`、不建 `persona_beliefs`。三列都走 `persona_claims` + `meta_json`，共用 `claim_events`。

---

## 2. 模块划分

```
src/modules/sangguan/
  gates.js      改：fieldCheck 按 layer 分派；新增 gateW / gateL / gateV
  fast.js       改：只跑 V；候选带 lane 字段；W/L 不再进快环
  night.js      改：新增 runLaneW / runLaneL（批量）
  templates.js  加：J1W（世界观归纳）、J1L（自传章节）、J20（反事实）、J21（起草）
  draft.js      新：取料后的聚类、五闸、冲突检查、提交
  recall.js     新：按场景召回（向量 + 轻判断）
  constitution.js 新：把 committed 条目拼成常驻文本
  inject.js     改：核心 + 召回 + 矛盾 + 摘要，预算 520 字
  meta.js       新：meta_json 的读写与默认值
scripts/
  sangguan-draft.mjs   已有：取料 + 提示词
  sangguan-prune.mjs   改：清退前先 void 未结 ν
```

---

## 3. 三条写入路径

### 3.1 V（快环，每轮）— 基本不改

沿用 `fast.js`：J1 抽取 → `gateV` → W1–W5 → `CLAIM_EXP`。只把 `fieldCheck` 改成按层分派，V 的判据不变：能排除 + 有代价 + 非任务。

新增一条只对 V 生效：如果 `foregone` 为空且正文里没有任何「放弃/宁可/没」的语义，进 `REJECT`（`reason: 'no_tradeoff'`）。这是把「取舍」从提示词要求变成硬闸。

### 3.2 W（夜巡批量）— 新写

```js
// night.js
export function runLaneW(db, aid, at) {
  if (!laneOn(db, aid, 'W')) return { skipped: 'off' }
  // 1) 取这一周的 episode 摘要 + 被结算的 nu + 日记
  const bag = collectWeek(db, aid, at)        // 只读
  // 2) 归纳：同一条模式在 ≥3 个不同对象/场景出现
  const cands = model.ask('J1W', bag)         // 输出 belief/scene[]/expectation/observe/falsifier
  // 3) 闸
  for (const c of cands) {
    const reason = gateW(c)
    if (reason) { append(REJECT); continue }
    append(CLAIM_EXP({ layer: 'W', kind: c.kind || 'belt', text: c.belief, meta_json: {...} }))
    if (c.expectation) append(NU_REGISTER(...))
  }
}
```

`gateW(c)` 的判定顺序：

1. `belief` 长度 8–80，第一人称之外的客观句；
2. `scene.length >= 3` 且来自 ≥3 个不同 `episode_id`；
3. `expectation` 非空，且**不含「我 / 她 / 自己」开头的行为描述**（正则 `^(我|自己|下次我)`），否则拒（B2）；
4. `observe` 非空且不是「我问一下就知道」这类自证；
5. 老三条（自评 / 元叙述 / 指令）保留；
6. 工程场景占比 ≥2/3 → 拒（复用 `TECH_WORD`，但只算命中数，不再一票否决）。

### 3.3 L（每周，或每 3 章）— 新写

```js
export function runLaneL(db, aid, at) {
  if (!laneOn(db, aid, 'L')) return { skipped: 'off' }
  // 1) 这一周日记 → 压成一章（复用 claim_summaries 的写法，但要先有章）
  const chapter = model.ask('J1L', weekDiaries(db, aid, at))
  // 2) 投入证据：action_log（按 port 聚合）+ 回合类型统计
  const invest = collectInvest(db, aid, at)   // 只认 action_log 与 raw_turns 的计数
  // 3) 成条
  const cands = model.ask('J1L', { chapter, invest })
  for (const c of cands) {
    const reason = gateL(c, invest)
    if (reason) { append(REJECT); continue }
    append(CLAIM_EXP({ layer: 'L', kind: 'chapter', text: c.self, meta_json: {...} }))
  }
}
```

`gateL(c, invest)`：

1. `self` 能解释 `c.past` 里的至少 2 个转折（模型自评 + 人可看）；
2. `direction` 非空且不是「变好」这种空词；
3. `invest` 至少 1 条，且时间跨度 ≥7 天；
4. 没有 invest 也允许进，但 `kind='role'` 且 `status='provisional'`，不进核心。

### 3.4 核心怎么立（B1 修正）

```js
// 只在夜巡
if (row.status === 'provisional' && passesCoreGate(layer, row, state)) append(CORE_ESTABLISH)
```

`passesCoreGate`：

- W：`V` 有 ≥1 条 committed **或**（W 的 ν 已结算 ≥2 次且 ≥1 次 miss）；
- L：`invest` 覆盖 ≥30 天；
- V：现有规则不变（π ≥ 阈值 + 无未结 κ）。

`growth_order` 的语义改成：**V 空时，W 只能进保护带，不许立核心**；不再拦 W 的新增。

---

## 4. 起草闭环（draft.js）

```js
export function build(db, aid, opts) {
  const eps = loadEpisodes(db, aid, opts.from)     // scripts 产出的同构数据
  const ann = annotate(eps)                        // J20，缓存到 claim_llm_cache
  const clusters = clusterByForegone(ann)          // 纯函数，按 foregone 的语义簇
  const drafts = clusters.flatMap((c) => compose(c)) // J21，2–3 版
  for (const d of drafts) d.gates = gates(d, eps)
  return drafts
}
```

- `clusterByForegone`：纯函数，先把 `foregone` 归到六类（时间 / 准确 / 被喜欢 / 省事 / 安心 / 面子），同类且跨 ≥2 天才成簇。
- `gates(d, eps)`：G1 有 alt；G2 foregone 非空且不是「没什么」；G3 补得出「所以不会___」（模型自检，失败降级为人审）；G4 抽掉项目词后仍成立；G5 证据 ≥2 跨 2 天。
- 提交：`POST /drafts/:id/commit` → 校验 `actor=user` → 一个批次写 `CLAIM_EXP(new)` + `EDGE_ADD(DERIVES)` + `CORE_ESTABLISH`（如果人勾了“设为核心”）。

---

## 5. 召回（recall.js）

```js
export function recall(db, aid, text, opt = {}) {
  const core = loadCore(db, aid)          // 每列 ≤2，共 ≤3
  const cands = topK(db, aid, text, 5)    // 向量：复用 memory_vec 的 cos
  if (!cands.length) return { core, picked: [] }
  const ids = model.ask('J22', { text, cands: cands.map((c) => ({ id: c.id, text: c.text, scene: c.scene })) })
  return { core, picked: cands.filter((c) => ids.includes(c.id)).slice(0, 2) }
}
```

- `topK`：`score = 0.75 * cos(text, claim_text) + 0.25 * cos(text, scene_joined)`；claim 没有向量时退化为字面 BM25（复用 `memory_fts` 不行，得在 claim 上加 FTS 或每次 embed；W/L 每天只新增几条，现算可接受）。
- `J22` 只回编号数组，schema `{ pick: [string], max 2 }`，没预算就跳过，只用 core。
- 兜底：`picked` 为空且 `core` 为空 → 返回一条「最久没被用过的 committed」。

---

## 6. 注入组装（inject.js）

```
[核心 ≤3 条，每列最多 1]      ~120 字
[召回 ≤2 条]                  ~100 字
[活跃矛盾 ≤1 对，带偏向]      ~60 字
[自传摘要 1 句]               ~40 字
[改口/违背提示 ≤1 条]         ~30 字
预算：520 字（est ≈ 260 token），超了按上面顺序从后往前丢
```

`INJECT_BUDGET` 从 160 改 520；`PER_LAYER` 保留给回滚路径；新增 `assertBudget(lines)` 在组装后断言，超了记 `inject.overflow` 指标，不静默截断。

---

## 7. 事件序列（三个容易写错的）

### 7.1 合并（B5）

```
一次 append，顺序固定：
1. CLAIM_EXP  new（携带 variants:[oldA, oldB]）
2. CLAIM_RETIRE oldA   reason='merged_into:<new>'
3. CLAIM_RETIRE oldB   reason='merged_into:<new>'
4. EDGE_ADD   new -DERIVES-> oldA? 否；不要给被合并的旧条建边
```

不允许 UPDATE；`variants` 只记旧 id 与原文。

### 7.2 清退带承诺的 V（B6）

```
1. NU_RESOLVE 所有 claim_id ∈ 待清退集合 且 outcome=pending 的 ν，outcome='void'
2. CLAIM_RETIRE 每条
3. 不重建 projection；等下一次 fold
```

### 7.3 打架的落地（复用现有）

```
KAPPA_CANDIDATE → KAPPA_OPEN → DELIBERATE(branch)
  RESOLVE：一条赢，另一条 superseded
  SUB：新建合题，两条 sublated
  COEX：两条都 active，记 loss{lean_pole, cost}
  SUSPEND：两条留 active，记 suspended_until
```

---

## 8. API

```
GET  /v1/agents/:id/sangguan/drafts            列表（status=draft|edited）
GET  /v1/agents/:id/sangguan/drafts/:id        单条（含 gates、evidence）
POST /v1/agents/:id/sangguan/drafts/:id/patch  改字（status→edited）
POST /v1/agents/:id/sangguan/drafts/:id/commit 入库（actor=user）
GET  /v1/agents/:id/sangguan/recall?text=...   预览这一句会捞到哪几条
```

全部只读投影，不改判据；`commit` 是唯一写路径。

---

## 9. 页面改动点（client.js）

| 位置 | 改动 |
|---|---|
| `SgLedgerBar` | 从三观页移到「靠谱度」；三观页不再渲染 |
| `headLine(l)` | 改成「核心 + 一条在争」；没有核心显示「还没立论」 |
| 三层 `Sec` | 改成三列（W/L/V），每列：核心 / 条目 / 在争 / 证据 |
| 新增折叠 | 「草稿」：显示 `drafts.json`，只读，带「去改」入口 |
| 技术视图 | 加「召回预览」：输入一句话，看会捞到哪几条 |
| 旧雷达 | 折叠保留，标注「仪表，不进提示」 |

---

## 10. 测试清单

```
test/sangguan-lanes.test.mjs        三套闸正反例、W 的「我…」预期被拒、L 无投入降级
test/sangguan-lane-w.test.mjs       跨 3 场景归纳、ν 结算回写 π、连续 2 次 miss 进 κ
test/sangguan-lane-l.test.mjs       章节压缩、invest 跨度、无 invest 进 provisional
test/sangguan-draft.test.mjs        聚类、五闸、合并事件序列、清退前 void ν
test/sangguan-recall.test.mjs       topK 打分、J22 只回编号、超预算丢召回
test/sangguan-inject-budget.test.mjs 520 字预算、超了按序丢、overflow 指标
```

全量：`test:sangguan` 1086 项一条不能掉；`run-tests` 全绿；`check:arch` 全绿。长模拟：G3 300 天 + G4 200 天，新增「三列各自长出 ≥1 条」断言。

---

## 11. 实施顺序（每步都能停）

| 步 | 做什么 | 文件 | 验收 |
|---|---|---|---|
| 0.1 | 加 `meta_json` 列（幂等） | `schema.js` | 老库能开、新库能开、重复开不报错 |
| 0.2 | 扩 `EDGE_TYPES` / `EVIDENCE_KINDS` | `catalog.js` | 事件校验不拒 |
| 0.3 | `meta.js` 读写与默认值 | 新文件 | 单测覆盖缺省/坏 JSON |
| 0.4 | 清库脚本先 void ν 再 RETIRE | `scripts/sangguan-prune.mjs` | 活库 6 条清退、无悬空 ν |
| 1.1 | `gateW` + `gateL` + 分派 | `gates.js` | 三套正反例全过；老测试不掉 |
| 1.2 | `runLaneW` | `night.js` | 模拟 7 天出 ≥1 条 W |
| 1.3 | `runLaneL` | `night.js` | 模拟 14 天出 ≥1 条 L，且带 invest |
| 1.4 | 核心闸修正（B1） | `night.js` | V 空时 W 只进保护带；有 2 次 miss 可立核心 |
| 2.1 | J20 / J21 | `templates.js` | schema 通过、缓存命中 |
| 2.2 | `draft.js` + 五闸 | 新文件 | 80 条料出 3 条草稿 |
| 2.3 | 草稿 API | `api.js` | commit 需 actor=user |
| 3.1 | `recall.js` | 新文件 | 命中率抽样 ≥60% |
| 3.2 | `constitution.js` + 注入改造 | 新文件 / `inject.js` | 预算断言通过 |
| 3.3 | shadow 观察 | 配置 | 一周 `inject.overflow=0` |
| 4.1 | 合并 / DERIVES / 月审 | `draft.js`、`night.js` | 合并事件序列正确 |
| 5.1 | 页面三列 | `client.js` | 工程句 0、日记原文 0 |
| 5.2 | 旧管线收口 | `fast.js`、`intake.js` | 关开关后行为与改造前一致 |

每步：先写 `.bak`，再写测试，再实现，跑 `test:sangguan` + `run-tests`，全绿进下一步。

---

## 12. 回滚

- 三个开关：`sangguan.lane.W` / `.L` / `.V`，默认 `false`，关掉即回到只读。
- `meta_json` 加列不回滚（只加不减），读时容错即可。
- 注入取法留旧路径：`inject.legacy=true` 时回到「每层 3 条链头」。
- 清退只增，可逆性靠重放；不提供“恢复已退休命题”的按钮，避免伪造历史。
