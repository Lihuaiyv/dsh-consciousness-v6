# 意识体 · dsh-consciousness-v6

设置 → 意识。整页由 Client 半注册进 `settings.section`（React 组件，在设置内容区里渲染），
不再往页面注入浮层，也不开 iframe。宿主半在插件进程内提供 `/dsh-consciousness/api`。

## 数据

`~/.dsh/consciousness/app.db`（node:sqlite + FTS5，schema 11，含 `algo_bindings`、`affect_user_read`、`action_config`、`research_seen`、`research_runs`）。

## 接口

```
POST /dsh-consciousness/api
{"method":"GET","path":"/v1/agents","body":{},"token":"user"}
```

写命令在 `body.__idempotencyKey` 带幂等键；`/v1/agents?include_deleted=1` 连软删的一起列。

## 界面

- 入口：设置左侧导航「意识」（order 26，在「智能体预设」之后）。
- 结构：意识体列表（新建 / 进入 / 软删 / 恢复）→ 实例详情（页头 + 9 个页签）。
- 页头：实例切换、日常 / 工作、用户 / 技术、待办 / 变更（计数不合并）、保存状态。
- 页签：概览 / 记忆 / 鱼格 / 情绪 / 驱力 / 关系 / 自修改 / 验收 / 设置。
- 设置页：按页头标签分组——记忆设置（四个常用旋钮）、鱼格设置（学习速率 / MBTI 效应，默认开）、情绪设置（敏感度滑杆 + 衰减 / 映射 / 动力学）、驱力设置（没有旋钮：五条基线自己长，只读展示「基线 / 习惯」和缺口算法版本）；能改的参数收在对应组里（C4 直改留痕、C3 发起提案、C0 只读）。不归标签的头像、自动行为、额度、维护和说明统一放到最后「其他」，内部按「外观 → 自动行为 → 额度 → 维护 → 说明」排成可收起的一行摘要，点开才看控件。顶部有分组跳转。MBTI 效应「开」时，只把真正偏出阈值的轴投影成一句「怎么说」注入系统提示（如：MBTI：E 多说一点、带点热度；N/T/J 没偏就不写，轴漂了下一轮自动跟着变）；「只算不用」只更新数字，不影响说话。
  每个旋钮都有消费方：学习速率 / 单次步幅上限 → 鱼格自动漂移的实际步幅（取小）；工况系数 → 过载时 E9 的情绪强度与 E2 的记忆权重（2.5 = 原值）；候选池 → 召回取多少条候选；关系权重 → 记忆挂在熟人 / 主人名下时的召回加成；C3 令牌上限 → 令牌补充的封顶；情绪衰减 0 = 不回落。金额预算没有计价来源，已从界面移除（数据库字段保留，等有 token 单价再接）。
- 情绪敏感度（设置 → 情绪）：鱼格第五条轴从只读条搬到设置里，0~1 连续滑杆随便挑，出厂默认 **0.80**（偏高：底色摆幅约 ±0.39、小事门槛 0.35、恢复 ×1.48；0.50 是中性，1.00 是顶格）。滑杆旁边实时预告「摆幅 / 门槛 / 恢复」三个数；保存写 `origin=manual`，这个值以后不再自己漂，「交回经历」还给它。它影响的是同一件事有多响、多小的才算事、坏情绪多久散——不制造情绪。旧库迁移：从没漂过、也没有手调记录的 auto 0.50 一次性抬到 0.80。接口：`GET …/persona/axes`（当前五轴 + 曲线 + 效果）、`PUT …/persona/axis.sensitivity`（`{value}`，`{value, origin:'auto'}` 交回）、`POST …/affect/rebuild-baseline`（按新 σ 重铺接下来的底色；已走完的段不动，当前段在「此刻」截断）。
- 人格页：上屏「它自己长成了什么样」= 第一人称自述（记忆 + 五条 Big Five + 自己长的价值观 + 关系模式 + 语气档 + 你写的人格卡）；下屏「你想让它」= 语气（自由输入）/ 称呼 / 口头禅 / 禁用词 / 自由人格卡，全部有字数上限（语气 8 / 称呼 4 / 口头禅 6 / 禁用词 15 / 人格卡 60，最坏 93 字 ≈ 66 token/轮）。
- 三毒（贪/嗔/痴）：src/modules/poisons.js 只读派生，初值 0.30 / 0.10 / 0.30（§5.2）；贪随 R/E 缺口高于均值上涨，嗔 = 0.10 + 刺激 + 过载（E9），痴 = 1 − 确定性。GET …/affect/poisons，只在情绪页技术视图露出，不进对话。
- 它现在觉得你（情绪页）：把模型给的 `user_scores`（说话人情绪）摆成它对你此刻的读数，不拿它自己的 `scores` 冒充。猜错了点「不对」→ 从八类里选你真有的那个 → 写进 `affect_user_read`（一条 episode 一条，可改、可撤）。学的是 8×8 混淆矩阵 P(你实际 | 它读成 g)（30 天半衰、向对角线收缩 3）；不加「你的情绪底色」全局先验——反馈只在读错时产生，那个分布是被选的，不是你的底色。下一轮读你时先把读数掰一遍，再拿它算共情 `e_user`；最近一次纠正只在读数不确定时给一点 2h 偏置（模型越笃定给得越少）。提示词里那句「对方刚才的情绪」也用校准后的标签，被改过时会写明「我一开始读成 X」，所以它说话的口径和它自己的情绪都会跟着变。「最近的情绪事件」每条也能单独纠错；「读你准确率」进了验收目录（`affect.read_accuracy`）。接口：`GET …/affect/guess`、`POST …/affect/feedback`（`clear: true` 撤销）。
- 关系的时间效应：R09 —— 14 天没有共同活动亲近 −0.02（每 14 天最多一次，回合结束时自动跑）；F7 修复 —— POST …/relations/:rid/repair（道歉/补偿/时间），信任 +0.03，7 天内第 3 次把安全维拉回基线 0.60。
- 冲突悬置（R05）：冲突超过 7 天未解 → 涉及的两条记忆权重 ×0.8（只罚一次，conflicts.opened_at / penalized_at，留痕 memory.conflict_decay）；每回合自动检查。
- 火气门（R03）：情绪是 irritated / frustrated 且强度 > 0.7 时，主动开口直接判「不主动」，决策里留一道 	emper 门。- 注入顺序按 6 号 §8：身份（含 MBTI 表达倾向，on 时）→ 关系 → 情绪（含语气档）→ 记忆 → 约束（禁忌/禁用词/理想自我卡）。- 价值观不是人填的：src/modules/values.js 从记忆、禁忌、偏好、关系、五维、情绪长出 Schwartz 十维（初值各 0.10）；三组张力（仁善↔权力 / 传统↔自主 / 安全↔刺激）互相压上限但不归零；同一维 ≥5 条证据进惯习、步幅减半。GET …/values 自动长，POST …/values/grow 强制重长，GET …/values/explain 给张力与证据。
- 自述接口：GET|POST /v1/agents/:id/persona/selfview（默认 7 天缓存，可手动重想）；来源权重：Big Five 1.00 / 记忆 0.60 / 价值观 0.40 / 关系 0.30 / 人格卡 0.25 / 情绪 0.20，逐条规则在技术视图「这段自述是怎么来的」。
- 视觉：膨胀点（Orb 呼吸环、状态点脉冲、浮点粒子、点阵、扫描线、按钮微光），
  全部走 `--dsw-alias-*` 主题 token，跟随明暗主题，`prefers-reduced-motion` 时关闭动效。

## 测试

```bash
node test/run-tests.mjs     # 456/456
node scripts/render-audit.mjs  # 40 个页面组合渲染审计（含设置页分组 / 参数行）
npm run check:host          # 宿主契约自检：19 条 mock 宿主用例，不启 DSH
npm run check:arch          # INV9 / 参数 / 归属 / 依赖图 / 宿主契约
```

## 体检


`npm run doctor`：一次把「改动到底上线了没」和「状态自不自洽」看完——插件活没活、四个宿主接缝、实例/记忆/驱力、价值观 Σ=1、三毒范围、自述状态、关系三维、冲突迁移、各表行数。读库一律 readOnly，HTTP 只发 GET 信封，不触发任何生成。

```bash
npm run doctor                         # 默认 127.0.0.1:58087 + ~/.dsh
node scripts/doctor.mjs --url http://127.0.0.1:58088
node scripts/doctor.mjs --offline      # 只查库，不碰 HTTP
node scripts/doctor.mjs --fix          # 补冲突表的 opened_at / penalized_at（只做加法迁移）
```

有 fail 退出码 1；`--fix` 只做和 `db.js` 启动时一致的加法迁移，不改数据、不删列。

## 插件没挂上时（设置里没有「意识」）

宿主半没加载时，/dsh-consciousness/ping 会 404，设置里也不会有「意识」。先跑 
pm run doctor 确认；**不用重启**的恢复办法：设置 → 插件 → 把 dsh-consciousness-v6 关掉再打开（等价于热重载），再刷新页面。仍不行才重启 DSH。

常见诱因：插件自己的 package.json 暂时非法（加载器读不到清单就不挂），或同一时刻有另一个实例持有 pp.lock。前者修好文件后按上面开关一次即可。
## 驱力回放

```bash
node scripts/replay-drive.mjs                         # 真实快照：v1 vs v1b
node scripts/replay-drive.mjs --agent agt_xxx
node scripts/replay-drive.mjs --ticks 1000 --variant max,l2
node scripts/replay-drive.mjs --scenario spike        # 合成：冷启动/休眠回来（看防尖峰）
node scripts/replay-drive.mjs --scenario multi        # 合成：五维同时缺（看 D 聚合）
node scripts/replay-drive.mjs --json
```

只读 `app.db` 的 `drive.satisfaction`（dims 快照）和 `drive.evaluated`（当时档位），
按同一套参数（α=0.35、c=0.05、设定点 0.6）重放，输出：档位切换、饱和率、基线误差、
D 分布、与线上档位一致率，以及“主动开口那条的维度当时是不是最高缺口”。
对比 v1 / v1b / v1c / v1d / v2：**默认是 v2**——五条设定点不再手填，由
`drive_state.setpoint` 里的「习惯 + 一点胃口 + 性格微倾」自己长（每天最多 0.02，
习惯时间常数 21 天），再用 5×5 符号耦合算缺口；v1c 是旧的防尖峰公式，v1d 是人格设定点候选。
`--variant l2` 是“不再 max”的预览，阈值未重标定。

## 驱力：五条基线自己长

- 设定点不再是五个手填旋钮，也不在参数目录里；它写在 `drive_state.setpoint`，
  跟着经历走：`habit`（最近过得怎么样，τ=21 天）+ 0.08 的胃口 + 性格微倾（最多 ±0.1）。
- 每个评估周期推进一次，每天最多挪 0.02（幅度限制在 0.35–1.00）；同时记一条
  `drive.setpoint.learned` 事件（真的挪动了才写）。
- 缺口 `n_i = max(0, s_i − x_i) / s_i` 仍走 `deficit@v2`：5×5 符号耦合 + 指数平滑 +
  迟滞分档 + 一次最多升一档。调参数目录里的 `drive.deficit.formula` 可回退到 v1c/v1d。
- 为什么用 21 天：突然被冷落时，基线还停在原来的水平，缺口会真的疼一阵；
  要是习惯当天就跟下去，它第二天就学会不指望了，驱力也就死了。
- 设置页「驱力」只读展示基线 / 习惯，没有保存键；要它变，只能靠过日子。

## 主动开口（它自己决定要不要说）

- 依据：五维缺口（R/E/C/A/S）+ 手头真事 + 沉默时长，现算，不落审批表。
- 判据：`benefit > cost` 才开口。收益 = 缺口 ×0.5 + 真事 ×0.3 + 时机 ×0.2；
  成本 = 基础 0.2 + 近 7 天发得太勤（每条 +0.05，封顶 0.3）+ 忽略率 ×0.35。
- 五道门：依据 / 空闲 / 频率 / 打扰 / 内容，每条门的结论都写进 `proactive_decisions`。
- 模型回 `SILENT`、或句子没过内容门，就不投递；模型超时/失败退回规则句（`source=rules`）。
- 主动发消息（`push`，默认关）：打开后心跳把待发那句通过 `sessionController.prompt` 推进你最近的会话，
  不再等你先开口；会话里会先出现一句括号提示，再是它说的话。关着时只在下一轮对话里自然提起。
- 接口：`GET /v1/agents/:id/proactive/why`（现在为什么说 / 不说）、
  `GET /v1/agents/:id/proactive/decisions`（最近每次判断的完整理由链）。

## 宿主接缝

`src/host/dsh.js` 是**唯一认识 DSH 的文件**；`index.js` 只提供业务内容。

| 接缝 | 契约 | 断了会怎样 |
|---|---|---|
| `systemPrompt` | `section({name, order, text, interpolate})` | 人格 / 记忆不注入，对话变成普通 DSH |
| `agent/pre-step` | `(payload, next) => next()`，waterfall | 按这句话召回失效，退回静态最近 10 条 |
| `session/event` | `(session, event) => void` | 不回写记忆、不更新情绪驱力 |
| `webServer` | `register({kind, path, handler})` | 设置页打不开（API 404） |

每个接缝独立降级，结果在 `GET /dsh-consciousness/ping` 的 `host` 段：

```json
"host": { "status": "ok", "ok": 4, "attempted": 4, "handler_errors": 0,
          "summary": "systemPrompt=ok/12 agent/pre-step=ok/57 session/event=ok/412 webServer=ok/0",
          "seams": [{ "seam": "agent/pre-step", "level": "ok", "reason": "", "hits": 57, "contract": "..." }] }
```

`level`：`ok` / `pending`（服务还没起来）/ `absent`（没这个服务）/ `degraded`（服务在、方法改名）/ `error`（调用了但抛错）/ `skipped`。
`hits` 是「装上了且真被调用过」的计数——**契约没变但 hits 一直是 0，说明上游链路改了**。

DSH 破坏性更新时：先跑 `npm run check:host`；红了就只改 `src/host/dsh.js` 一个文件。

## 行动接口（模型真的能动手）

四个端口，**默认全关**；开关在 设置 → 意识 → 驱力 → 行动接口。每个接口是一行：
左边名字 + 一句话说明，右边开关；点行体展开「它能做什么 + 怎么接」，配置就长在里面。
关着时工具仍然注册（模型看得见），但执行会被拒，并告诉模型「去哪个设置页打开」。

| 端口 | 工具 | 能做什么 |
|---|---|---|
| 发消息 | `act_send` | 微信（个人 / 企业微信）、QQ；每次发送占 1 次打扰预算（默认 3 条/天） |
| 浏览 | `act_browse` | 通用网页检索（不限站点）、抓网页正文；B 站搜索 / 推荐流 / 视频详情 + 高赞评论 |
| 浏览（写） | `act_comment` | 在 B 站视频下发评论；公开、不可撤回，和发消息共用端口和预算 |
| 研究搜集 | `act_research` | 多轮检索 → 去重 → 抓正文 → 抽说法 → 按来源可信度交叉印证 → 写带 `[S#]` 引用的报告 |
| 提醒 | `act_remind` | 往收件箱放一条待办（可带 ISO 到期时间），不弹系统通知 |

### 通道怎么接

- **个人微信（默认）**：两条后端，设置里可切「自动 / Python / UIA」。
  - **Python（推荐，微信 4.1）**：`pip install wechatauto-replica`（发送路径另需 `winsdk`、`pypinyin`）。
    微信 4.1 聊天界面是自绘的，原生 UIA 只能看到 Qt 空壳；这个包会热激活 Qt accessibility gate，
    再用 UIA 优先 / OCR 兜底发送，安装后「后端=自动」会优先走它。
  - **UIA**：`scripts/wechat-send.ps1` 找搜索框 → **只点名字完全对上的联系人** → 找输入框 → 粘贴 → 发送。
    微信 3.9 可用；4.1 下通常找不到控件，会明确报错而不是乱发。找不到可点元素时默认**不降级**；
    设置里可开「键盘兜底」，打开后才走 Ctrl+F + 粘贴 + Enter（有发错人风险）。
  - 两条都要求微信已登录、窗口没最小化。
- **企业微信**：群里加「群机器人」，把 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…` 粘进设置。
  官方接口、最稳，但只能发群。
- **QQ**：装 NapCat（或任意 OneBot v11 HTTP 网关），在设置里填地址（默认 `http://127.0.0.1:3000`）和 token。
  发私聊用 `/send_private_msg`，发群用 `/send_group_msg`；target 填 QQ 号 / 群号。
- **B 站**：公开接口 + wbi 签名，游客可用；填 `SESSDATA` 后能看关注流、少撞风控。
  写评论要 Cookie 里同时有 `SESSDATA` 和 `bili_jct`（csrf），走 `/x/v2/reply/add`；
  公开可见、不可撤回，所以界面和工具都要求先确认内容。

配置存 `action_config`（按点号 key 扁平保存）；体检 / 测试发送走
`GET /v1/agents/:id/action-status`、`POST /v1/agents/:id/actions/test`。

### 研究长什么样

`act_research` 的产出一律带这些字段，方便判断「能不能信 / 能不能做」：

- 每个来源：域名分档（政府 / 学术 / 官方媒体 / 技术文档 / 百科 / 社区 / 未知）、可信度 0–1、发布年份、是否回访；
  另带一份 CRAAP 式的字段：权威（域名档）、时效（一年内 / 三年内 / 较旧 / 无日期）、用途（信息 / 商业推广）、
  相关度（标题+摘要与主题的词重合），准确性在交叉印证后回填「多来源印证 / 单一来源」。
- 每条说法：支持它的来源编号、独立来源数、置信度（高 / 中 / 偏低 / 低）；同一簇里既有支持又有反对时标「来源互相矛盾」并扣置信度。
- 报告固定章节：一句话结论 / 关键发现 / 证据表 / 分歧与不确定 / 可行性评估（前置条件 / 成本 / 时间 / 风险）/ 下一步。
- 去重：`research_seen` 记归一化 URL（去 utm、锚点），窗口默认 60 天；重复跑到没新料时明确写「本轮没有新来源」。
- 模型不可用时退化为「检索 + 摘要」模板，并注明没做语义交叉验证；抽取失败也计数进 `stats.extract_failed`。

报告落 `~/.dsh/consciousness/research/<run_id>.md`，同时进 `research_runs` 表。
接口：`POST /v1/agents/:id/research`、`GET /v1/agents/:id/research`、`GET /v1/agents/:id/research/:run_id`。
注意：HTTP 手动触发没有会话上下文，宿主 `web` 服务可能拒绝调用；**要在对话里让模型用 `act_research`**。

## 日志

`~/.dsh/consciousness/hook.log` 只记关键行（接缝状态 / 召回 / 回合落库 / 报错原因）。

- 逐事件行（`event:*`）默认关，一次工具调用就一行，太吵；排查事件链路时设 `DSHC_PROBE_EVENTS=1`。
- 每次启动检查大小，超过 **4MB** 就把上一份挪成 `hook.log.1`（只留一代）。

## 结构

```
index.js           宿主：业务内容（注入什么 / 事件做什么 / 挂哪些路由 / 四个行动工具），接缝交给 host/
client.js          Client：window.__ModuleLoader__.load → settings.section（含行动接口配置面板）
src/host/dsh.js    宿主适配层：六个接缝的探测 / 安装 / 降级 / 报告
src/db.js          schema / journal / recover
src/core.js        兼容层：按域再导出 kernel / modules/*
src/features.js    关系、价值观、偏好、禁忌、工况、预算、规则版本、指标采样、主动开口判据与决策记录
src/model.js       ModelPort（规则适配器 + 宿主 llm + 可选 OpenAI 兼容），研究工具走 chat
src/modules/actions/  行动层：channels（微信 / QQ / 企业微信）、bilibili、research、credibility、wechat(channel)
src/api.js         信封路由
src/zip.js         导出 / 导入
scripts/wechat-send.ps1  个人微信窗口自动化（UIAutomation + 可选键盘兜底）
```
