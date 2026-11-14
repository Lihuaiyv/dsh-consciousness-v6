# 意识体 v6 · 记忆模块升级规划 v2（H0–U8）

> 前提：U0–U5 / M0–M3 **已落地**。  
> 本版：硬化真缺口 + 改口黄灯 + 长尾习惯 + 观测收口。  
> **不做**：Neo4j / Graphiti 双时态（G1/G2）、公开 LoCoMo（E1）——另立项。

---

## 0. 批次总览

| 批 | 主题 | 状态 |
|----|------|------|
| **H0** | 仿真校准（探针日序 / 改口考核门槛） | ✅ |
| **H1** | recall-tool 四失败 + tiers 纪要 UTC 日漂移 | ✅ |
| **U6** | 改口 → 冲突黄灯（`flip_policy`） | ✅ |
| **U7** | 长尾习惯稳进 T1（不碰日记事实源） | ✅ |
| **U8** | `memory-health` 观测 + M4 抽检勾完 + 技术页对齐 | ✅ |

---

## 1. 不变量（本轨未破）

- T4 原文 / 存根只追加；日记 ≠ 事实源  
- gate 序：极性翻转 → merge → UPDATE → new  
- 证据门 ⊥ heat；S1 默认挡 cold/archived（习惯窄穿透可关）  
- schema 增量；不上图库  

---

## 2. 验收快照（落地后）

| 套件 | 结果 |
|------|------|
| recall-tool | 68/68 |
| tiers | 75/75 |
| u6-flip | 12/12 |
| u7-habit | 12/12 |
| u8-health | 6/6 |
| upgrade-u（U0–U5） | 35/35 |
| sim:days 60 | 8/8，召回 5/5（游泳已埋） |
| sim:days 200 | 8/8，改口冲突开案，召回 5/5 |
| eval:memory | 4/4 = 100% |

---

## 3. 相对升级前的提升

| 以前 | 现在 |
|------|------|
| 60 天「游泳」假 miss（剧本 day90 未埋却考） | 游泳提前到 day15 + 低频复提；探针按 `after` 过滤 |
| 60 天「冲突 0」被当成产品 bug | day&lt;120 跳过改口考核；≥120/200 必开案 |
| recall-tool：同义词误召 / days 漏旧条 / 无关硬凑 | 字面门槛 + 缺 `at` 收紧 days + 软匹配抬门 |
| tiers 纪要单测中途挂（UTC vs 本地日） | 测试改 `localDay()` |
| 改口可能被 UPDATE 叙事混淆 | 默认 `flip_policy=conflict`；consolidate 极性跳过可观测 |
| 习惯易冷掉出 S1 | 重要度地板 + `habit.*` key + 可选冷层窄穿透 |
| 缺一页健康快照 | `GET /memory-health` |

---

## 4. 关键参数

| 键 | 默认 | 含义 |
|----|------|------|
| `memory.write.flip_policy` | `conflict` | 改口黄灯；`update`=静默覆盖 |
| `memory.retrieve.habit_cold` | `on` | S1 对冷习惯字面命中窄穿透 |

回滚：`flip_policy` 保持 conflict；`habit_cold=off` 即关穿透。

---

## 5. 之后路线

```
意识体日常够用（H0–U8）
    │
    ├─ G1「时效索引 + 冷库出证」——已落地（2026-11-01），见 memory-asof-plan-g1.md
    ├─ 再打磨人格/情绪一体
    ├─ E1 公开榜子集 ——可选
    └─ G2 真双时态图 ——另议
```

口令：要 E1 再说「另立项」；默认不再开大图。G1 的对话自动段（`memory.asof.auto`）默认关。
