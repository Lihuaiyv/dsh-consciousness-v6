# 意识体 v6 · 属性真源收口规划 v1

> 背景：各属性大方向分表，但导入 / 注入 / 面板仍有「两套数」。  
> 原则：每类属性一个写权威、一个读权威；导入写活账本；旧表只镜像或只迁不新写。  
> 不做：把价值观改回「人填定死」、方案 B 多会话、评价挪到生成前。

---

## 0. 核查结论（对照代码，2026-10-31）

| 属性 | 真源（应读） | 第二套 | 状态 | 证据 |
|------|-------------|--------|------|------|
| 鱼格五轴 | `persona` 的 `axis.{ei,sn,tf,jp,sensitivity}`；读应走 `readAxes` / `AXIS_DEFAULTS` | 注入手扫 `persona` 行，缺行不填；`expressionLine` 缺 ei→0.5，`toneOf` 缺 ei→0.6 | ⚠️ 兜底三套 | `index.js` ~288–294、391；`traits.js` `AXIS_DEFAULTS` / `readAxes` |
| 价值观十维 | `persona_values` | 导入 `values.*` → `setPersona` 写进 `persona` 表；种子还有无人读的 `values.weight` | ❌ 导入静默丢 | `features.js` import `personaOk` + `setPersona`；注入/API 读 `persona_values`；`values.weight` 全库无业务读 |
| 关系三轴 | `rel_person` | 导入 / API 旧写 `relations`；注入有 `rel_person` 优先兜底 | ⚠️ 新导入面板≠提示词 | `upsertRelation` 只写旧表；`consciousnessBlock` / `selfview` 优先活账本 |
| 整体心情 | 应对齐 `getAffect` 的同一语义 | 「整体心情」用 `affect.v3.total`；关系温度 `toneOf.mood` 用 `affect_state.mood`（0~1） | ⚠️ 两数可反向 | `index.js` ~362 vs ~386；`moodValenceOf` 已偏 `slow` |

**干净的部分（保持）：** 禁忌 / 偏好 / 记忆各表不互写；big5 已迁删；仪式衰减已写 `rel_person` 并镜像旧表；驱力重要度读 `persona_values`。

**顺带核实：**

- `axis.shown.*`：源码无此 path 写入；风险是注入用 `startsWith('axis.')` 未走 `isAxisPath`，以后若有人写投影行会混进 `axisVals`。收口时改为 `readAxes` 即可。  
- `isMid(0.45)`：JS 下 `Math.abs(0.45-0.5)≈0.049999… < 0.05`，会误判中间——与审查一致；`typeProfile` 已用 `shown` 修展示，`axisWords` / `isMid` 未修。

---

## 1. 产品语义（本版冻结）

| 点 | 本版行为 |
|----|----------|
| 五轴 | 唯一读写走 `traits`（`readAxes` / `setAxis*`）；出生缺省 = `AXIS_DEFAULTS`；注入不得手扫或另兜 0.5 |
| 价值观 | 唯一真源 `persona_values`；导入映射 Schwartz 十维键 → `setValue` / `growValues` 种子；废弃 `persona.values.*` 与 `values.weight` |
| 关系 | 写权威 `rel_person`（经 `relations.js` commit）；`relations` 只镜像或只读迁移；导入不得只写旧表 |
| 心情（注入） | 「整体心情」与关系温度同源：优先 `moodValenceOf` / `v3.slow`（或文档写明用 total 则两处都用 total）；`affect_state.mood` 仅作兼容投影，由评价路径回写，不单独当第二真相 |
| 旧字段 | 导入模板去掉 `values.weight`；读到遗留 `persona` 上的 `values.*` 可一次性迁入 `persona_values` 后忽略 |

---

## 2. 批次总览

| 批 | 主题 | 预估 | 依赖 |
|----|------|------|------|
| A0 | 价值观导入 → 真表 | 0.5d | 无 |
| A1 | 关系导入 / 写入统一活账本 | 0.5–1d | 无（可与 A0 并行） |
| A2 | 心情单源（注入 + toneOf） | 0.3d | 无 |
| A3 | 五轴读权威 + 中间带浮点 | 0.3d | 无 |
| A4 | 死字段清理 + 文档 + 验收 | 0.3d | A0–A3 |

建议顺序：**A0 → A1 → A2 → A3 → A4**（与先前建议一致：价值观导入 → 关系账本 → 心情单源 → 五轴兜底）。

---

## 3. 分批明细

### A0 · 价值观导入不丢 ❌→✅

| ID | 任务 | 文件 | 做法 |
|----|------|------|------|
| A0.1 | 导入模板 | `features.js` `importFreeform` | JSON 模板改为 `"values":[{"key":"achievement","weight":1.0},…]`（Schwartz 键）；去掉 `persona.values.*` / `values.weight` |
| A0.2 | 落库 | 同上 | 解析后 `setValue`（或规范化权重后写入 `persona_values`）；未知键跳过并计数 |
| A0.3 | 遗留迁 | 导入或一次性 helper | 若 `persona` 仍有 `values.<dim>`，迁入 `persona_values` 后可删行（可选同批） |
| A0.4 | 种子 | `persona.js` `seedPersona` | 停写或标注废弃 `values.weight`；十维初值仍由 `growValues` / seed values 负责 |

**验收**：设定 md 含成就/安全权重 → 导入后 `GET values` 与注入「你看重」一致；`persona` 表无新的 `values.*`。

### A1 · 关系一本账

| ID | 任务 | 文件 | 做法 |
|----|------|------|------|
| A1.1 | 导入写活账本 | `features.js` + `relations.js` | `importFreeform` / 抽取落库改为 `commit`/`ensurePerson`+三轴 patch；kind→tier；owner 唯一约束 |
| A1.2 | 旧 API | `upsertRelation` | 写 `rel_person` 并镜像 `relations`；或标 deprecated，面板改走 persons API |
| A1.3 | 抽取路径 | `features.js` 关系抽取 | 确认不再只 `INSERT relations` |
| A1.4 | 读方 | `index.js` / `selfview` / `drive` | 保持 `rel_person` 优先；文档写明旧表仅兜底至迁完 |

**验收**：新导入实例 `rel_person` 有主人行；注入关系数字 = 面板人物卡；旧表可有镜像但不是唯一写入。

### A2 · 心情单源

| ID | 任务 | 文件 | 做法 |
|----|------|------|------|
| A2.1 | 拍板语义 | — | 注入「整体心情」= 慢情绪 valence（与 `moodValenceOf` 一致）；不用 `v3.total` 与 `mood` 各说各话 |
| A2.2 | 注入 | `index.js` | `moodWord(moodValenceOf…)` 或 `affect.v3.slow`；关系 `toneOf.mood`：同一 valence 映射到 toneOf 所需 0~1（`(v+1)/2`） |
| A2.3 | 回写 | `affect.js` 评价路径 | 评价后把投影写回 `affect_state.mood`（若尚未），避免面板旧字段长期漂移 |
| A2.4 | 文案 | README / 情绪文档 | 标明 total / slow / mood 各自含义；注入只用哪一个 |

**验收**：同实例下注入「整体心情」档与关系温度所用 mood 同源；制造 v3.total 与 mood 反向的夹具时，注入两处不再打架。

### A3 · 五轴单一读权威

| ID | 任务 | 文件 | 做法 |
|----|------|------|------|
| A3.1 | 注入改 `readAxes` | `index.js` | 删手扫 `axis.*`；`axisWords(readAxes(…))`；`expressionFrom` / `toneOf` 的 ei 同源 |
| A3.2 | 中间带 | `traits.js` `isMid` | 按两位小数或 `Math.abs(round(v,2)-0.5) < MID`（与 `typeProfile` 对齐）；覆盖 0.45 用例 |
| A3.3 | 扫路径收紧 | 若仍有原始 dump | 只用 `isAxisPath`；禁止非五轴 `axis.*` 进注入 |

**验收**：删一条轴行后注入与面板同用 `AXIS_DEFAULTS`；`axisWords(0.45)` 对 sn 出「偏实感」；单元测 `isMid(0.45)===false`。

### A4 · 清理 / 文档 / 验收

| ID | 任务 | 做法 |
|----|------|------|
| A4.1 | 删或标注 `values.weight` | 种子、artifacts 白名单、导入模板 |
| A4.2 | 文档 | README / 性格·价值·关系层：真源表一览 |
| A4.3 | 验收 | `npm test`；导入夹具（价值观+关系）；可选小脚本 assert 注入块字段 |

---

## 4. 验收清单

- [x] 导入含 `achievement`/`security` → `persona_values` 有行；注入「你看重」含对应中文  
- [x] 导入关系 → `rel_person` 有人；注入亲近/信任/依赖与面板一致  
- [x] 注入整体心情与 toneOf 心情同源（同测例同档）  
- [x] 缺轴行时注入 = `AXIS_DEFAULTS`；`isMid(0.45)` 为 false  
- [x] `check:arch` + 全量 test 不降（518/518 · arch 23/23）  

- [x] 无新增「写旧表、读新表」热路径（旧表仅镜像/兜底）

---

## 5. 风险与回滚

| 风险 | 处理 |
|------|------|
| 导入模板变更，旧客户端仍塞 `values.achievement` | A0 兼容：识别 `persona["values.xxx"]` 仍写入 `persona_values` |
| 只写 rel_person 后旧面板只读 relations | A1 镜像写旧表，或面板切 persons API |
| 心情改 slow 后面板「心情」数字观感变 | 文档说明；保持 mood 投影回写 |
| 五轴默认从 0.5 变 0.6/0.8 仅「缺行」暴露 | 与产品出生语义一致，属修洞非改人设 |

---

## 6. 完成定义

- 四类混用（价值 / 关系 / 心情 / 五轴兜底）均有对应批且验收勾完  
- 导入不再出现「写了没人读」  
- 热路径读权威唯一：`readAxes` / `persona_values` / `rel_person` / `moodValenceOf`（或本版冻结的同一字段）
