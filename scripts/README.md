# scripts/ 里的东西怎么放

> 一句话：**能反复跑的留在这里，跑一次的进 `scratch/`，产物进 `var/`。** 目录乱过一次——根目录堆了上百个 `_*.mjs`，谁也不知道哪个还有用——所以定下来。

## 三类

| 目录 | 放什么 | 例子 | 跑法 |
|---|---|---|---|
| `scripts/` 根 | 运维体检、闸、导出：跑完就能判断对错，只读或可回退 | `check-parts.mjs`、`check-paths.mjs`、`audit-claims.mjs` | `node scripts/xxx.mjs` |
| `scripts/sim/` | 模拟：用临时库跑一段，看分布/回归 | `sim-affect-v2.mjs`、`sim-prompt-gates.mjs` | `node scripts/sim/xxx.mjs` |

- **一次性探针**（查一下某个库、临时改批数据）：放 `scratch/`，不进版本库。
- **运行产物**（导出、回放结果、统计 json）：放 `var/`，不进版本库。
- 根目录有卫生闸（`scripts/check-hygiene.mjs`）守着，乱放会红。

## 加新东西的规矩

1. 能反复用的才进 `scripts/`；写完只跑一次就扔的，进 `scratch/`。
2. 模拟一律 `sim-` 前缀，放 `scripts/sim/`；要用相对路径就按新位置算（`../../src/...`）。
3. 路径不许写死：从 `src/paths.js` 取（`dbPath()` / `repoRoot()` / `stickersDir()`），或者用相对路径。`scripts/check-paths.mjs` 会拦。
4. 常用命令写进 `package.json` 的 scripts，名字统一 `check:` / `sim:` / `test:` 前缀。

## 现在常跑的几个

```
node test/run-tests.mjs              # 全量（含路径闸、目录卫生）
node scripts/check-parts.mjs         # 零件册界桩（25 个零件）
node scripts/check-paths.mjs         # 绝对路径
node scripts/check-hygiene.mjs       # 根目录卫生
node scripts/sim/sim-affect-v2.mjs   # 情绪通路（266 条）
node scripts/sim/sim-prompt-gates.mjs # 三句提示词的闸
```
