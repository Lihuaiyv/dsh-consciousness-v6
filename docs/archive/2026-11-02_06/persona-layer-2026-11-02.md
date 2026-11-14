# 表达层改造 · 2026-11-02

目标不是「更聪明」，是「不僵」：把注入里的命令换成材料、把兜底从装懂改成承认、把「今天的她」挪到夜里写。

## 做了什么

1. **诚实兜底（P0）**：`composeRulesReply` 不再回「记下了：xxx」「我先记下来」「要我记住这条吗？」。
   没模型时她说「嗯，我在听」/「这个我还不知道」——承认没接住，不假装听懂。
2. **来源标签说实话**：`ModelPort` 记下这次是谁答的（primary / fallback），
   `chatReply` 的 `source` 不再把规则兜底标成 `model`。
3. **注入从命令改材料（B）**：
   - `expression_state.cardLine` 把「我想怎么说」+「这一轮怎么写」合成一句（含「不列点、不总结」底线）；
     `style_mode.styleText` 改为同一份文案，删掉重复的 STYLE 表。
   - `styleInjection` 闲聊时只返回文体清单一条，不再单发「这一轮怎么写」。
   - 新增「现在：下午；我上一句说的是「…」」——时间与上下文材料。
4. **夜里的她（C）**：夜巡第 ⑬ 步 `self_note`，有模型时写 3–5 句存 `flags`，
   白天注入读一份收拾好的；没模型 / 空回复 / 抛错都只是跳过，不拦整夜。
5. **行为示例扩池（C）**：`DEFAULT_EXAMPLES` 14 → 19 条，补被夸、被纠正、久别、吃醋、被质疑；
   `PICK` 按档挑，注入仍每轮 ≤ 6 条。
6. **测试跟着设计走**：`conversations-p2`（去掉「不超过 4 句」断言）、`style-texture`（注入形状）、
   `sangguan-s12-prompt`（改用「现在：」）。
7. 顺手修掉 `index.js` 11 行双重编码注释；`speaker-identity` 补 3 条主人侧断言。

## 前后数字

| 项 | 改之前 | 改之后 |
|----|--------|--------|
| 规则兜底含「记下了/记下来/要我记住」 | 5 / 9 条 | 0 / 9 条 |
| 注入命令行（24 场景合计） | 72 | 48 |
| 「这一轮怎么写」出现次数 | 24 场景 | 0 |
| 「现在：」时间材料 | 0 | 24 场景 |
| 注入平均 token | 460 | 465（+1.1%） |
| 「你今天真聪明」行为示例出现 | 1 场景 | 24 场景 |
| 评测硬伤（喊主人/记下了/总结腔/列点/空回复） | 0 | 0 |
| 主测试 | 544 / 544 | 544 / 544 |
| `test:humanlike` / `test:kernel` / `test:relations` / `test:sangguan` / `check:arch` | 全绿 | 全绿 |
| 新增测试 | — | `test/speaker-identity` 33、`test/self-note` 12 |

## 没做到 / 只能真机验的

- **模型路只有真机能测**：CLI 里 `model.status().served` 恒为 `fallback`，
  评测出来的 24 条全是规则兜底。模型换个说法之后像不像人，要跑
  `npm run eval:persona -- --model` 在你装了模型的实例里出报告。
- 吃醋样本只在 `warm` 档注入，评测里没有 warm 档场景（24 条的情绪底色都偏平稳），所以那一项的覆盖是 0。
- 注入 token 略涨 1.1%：换来时间与上下文材料，仍在 800 预算内（实测 465）。

## 怎么复跑

```bash
npm run eval:persona -- --label after     # 出 docs/eval-after.md 与 docs/eval-inject-after.json
npm run test:speaker
npm run test:selfnote
```
