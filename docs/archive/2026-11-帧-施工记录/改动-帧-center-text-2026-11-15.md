# 改动 · 帧 `center_text` 取中心（D52）· 2026-11-15

## 动了哪

只动一处：`scratch/proto/frame_writer.py` 的 backfill 段。

- 原先：`fr["center_text"] = (w[0][1] if w else "")[:40]` —— 取窗口里**最早**那一帧的 focus，但 `frame_line.js:55` 把它渲染成「最近二十帧的中心是「…」」。
- 现在：先算窗口重心向量 `c = _center(...)`（偏离 `dev` 本来也要用它，只算一次），再取**离重心最近**（cosine 最大）那一帧的 focus 当 `center_text`。
- `deviation`（相对上一帧锚）**没动**，它本来就对。

## 为什么

夯实的“力”是“偏远了往回拉”。拉的方向得是一个**真实存在**的位置。原先那句给的是“窗口起点”，不是中心——力指错了地方。这就是问题登记 D52。

## 怎么验

1. 语法：`python -m py_compile frame_writer.py` → OK。
2. 功能（副本，不碰真库）：把 `frames_v2.bak-0413.jsonl` 复制成临时目录里的 `frames_v2.jsonl`，跑 `backfill` → 76 帧全部补出 `anchor_vec` / `center_text`；抽查一条 `center_n=3`，`center_text` 不再是窗口首帧的 focus。
3. 门禁：`node test/run-tests.mjs`（本次改动只在 python 侧，与 node 门禁无交集；仍跑一次确认全绿）。
4. **还没验的**：真库里的老帧。`backfill` 只处理“还没有 center_text”的帧（`frame_writer.py:238`），所以 805 条老帧的 `center_text` 仍是旧口径。新帧从下一条开始是对的。

## 老帧怎么办（待定，本轮不做）

三条路，选一条：
- 不迁（老值错就错着，新值对就行）；
- 只重算最近 N 条（比如今天那 20 条），代价小、风险低；
- 全量重算（要跑一遍 embedding，且会覆盖 `deviation`/`drift` 口径，风险高——不建议）。

## 怎么退

`git checkout -- scratch/proto/frame_writer.py`（只改了一个文件，无数据迁移）。
