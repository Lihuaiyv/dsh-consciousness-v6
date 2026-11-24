# 改动 · 判断层 fact / expect / severity（2026-11-22）

> 40 条样本里查出三条：fact 把「问」读成「质疑」；expect 把「又来一次」判成意外（+0.35）；
> severity 的 strong 吃太多（13/40 = 32.5%），而 existence 仍是 0。
> 按主人规矩：不写反面例子，只写原则、收窄任务。

## 一、动了哪

`src/modules/affect_v4_shadow.js` 的 `JUDGE_SYS`：

1. **fact**：从「这一句在讲什么，只说事，不评价、不往自己身上安」改成
   「这一句在说什么——谁说了什么、做了什么。只记这一句里有的东西，不写它的意思、意图、态度；那些是 meaning 的活。」
   把「意思/意图/态度」明确划给 meaning，不让 fact 越位替自己判。
2. **expect**：加一条原则——
   「这件事在不在预料之内，看它是重复出现还是第一次撞上来：重复发生的、旧毛病又来的，是意料之中（负）；第一次碰到、被打断、没想到的，才是突然（正）。」
3. **severity**：none 里补「顺嘴的评价、派活」；strong 收窄成「当面、明确、冲我来的好评或差评」；
   「拿不准就写 strong 或 none」改成「写 none 或 strong」（先落轻的）。

**没动**：goal / future 两段刻度、by / to、十键严格模式。

## 二、为什么

三条错法的共同点：模型在替这句话「解释意思」，而这一步只需要它「如实记下」。
fact 只记原话里有的，意思留给 meaning；expect 只判重复不重复；severity 只给当面明确的褒贬。
任务收窄，比再补三条例子强——按主人定过的，例子永远补不完。

## 三、怎么验

```powershell
node --check src/modules/affect_v4_shadow.js
node test/run-tests.mjs
```

提示词不进门禁；重载后拿同一批句子对比：fact 是否只记原话、expect 在重复出现上是否给负、severity strong 的比例是否从 32% 降下来。

## 四、怎么退

`git` 取回 `JUDGE_SYS` 的 fact / expect / severity 三处。
