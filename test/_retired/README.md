# 已停用的测试（2026-11-02）

这些文件不在任何 `npm` 脚本里，且**引用的是已经被删掉的导出**，跑起来第一行就 `SyntaxError`。
放进这里是为了「需要时能找回写法」，不是当验收标准；验收看 `test/run-tests.mjs`、
`npm run test:humanlike`、`npm run test:kernel`、`npm run test:relations` 和 `test/g1-*`。

判断依据：`node scripts/check-test-imports.mjs`（静态比对 test 里的具名导入与 src 的真实导出）。

| 文件 | 缺什么 | 现在由谁覆盖 |
|------|--------|--------------|
| diary-pack.test.mjs | archive.js 的 packDiaryMaterial / DIARY_MATERIAL_BUDGET / clipDiaryBody / diaryMoodForDay / buildEpisodes | 日记与纪要在 run-tests 的「分层/日记/纪要」段落覆盖 |
| episode-distill.test.mjs | archive.js 的 buildEpisodes、retrieve.js 的 recentEpisodeTopics | 同上 |
| episode-stress.test.mjs | archive.js 的切段/打分/精修整组函数 | 同上 |
| thoughts-f.test.mjs | thoughts.js 的 shouldRefresh / cooldownHours / memLimit | run-tests 的「想法」段落（只测对外行为） |
| thoughts.test.mjs | thoughts.js 的 shouldRefresh / cooldownHours | 同上 |
| tiers.test.mjs | archive.js 的切段/打分/精修整组函数 | run-tests 的 tier / 分层段落 |
| u6-flip.test.mjs | consolidate.js 的 consolidateFactsRule | 同 key 改写/冲突的行为由 `g1-0`、`g1-2`、`g1-5` 覆盖 |
| u7-habit.test.mjs | memory.js 的 isHabitText / habitImportanceFloor / habitFactKey | 习惯键与重要度由 run-tests 与 g1 系列覆盖 |
| upgrade-u.test.mjs | consolidate.js 的 consolidateFactsRule | 同上 |

如果哪天要把其中某条行为重新立成契约：先在当前 `src/` 里找到承接它的函数，
把断言改成调用现在真实存在的入口，再从这里移回 `test/`——不要直接搬运旧断言。
