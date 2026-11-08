# 架构（dsh-consciousness-v6）

> 这份文档只回答三个问题：**代码分几层**、**谁可以依赖谁**、**新东西往哪放**。
> 约束不是写着好看的——`npm run check:arch` 会把它们当红线跑（INV9 / INV10 / 参数 / 归属 / 依赖图 / 宿主契约）。

## 一、两半

DSH 插件分两半，靠 `package.json` 的 `exports` 各开一个口：

| 出口 | 文件 | 跑在哪 | 干什么 |
|---|---|---|---|
| `.`（宿主半） | `index.js` | 插件进程 | 注册工具与钩子、心跳、挂 `/dsh-consciousness/api` |
| `./client`（客户端半） | `client.js` | 设置页（React） | 整页 UI：记忆、情绪、关系、零件、三观 |

两半**不共享模块**。客户端要的数据一律走 HTTP 接口，不 import `src/`。

## 二、宿主半的分层

```
index.js            入口 + 装配（注册工具、钩子、心跳）
└─ src/
   ├─ api.js        HTTP 路由（handle）——客户端唯一入口
   ├─ features.js   对话侧编排：主动开口、注入、模型钩子、关系
   ├─ core.js       领域操作：记忆召回、提案/草稿、变更日志
   ├─ db.js         SQLite：打开、schema、recover、时间
   ├─ model.js      模型选择与调用 —— 唯一允许出现厂商名的文件（INV9）
   ├─ kernel.js     内核状态机
   ├─ push.js / text.js / zip.js / selfmod_limits.js   小工具
   ├─ paths.js      路径唯一出处（home / dbPath / repoRoot / stickersDir）
   ├─ modules/      178 个域模块（traits / drive / memories / relations …）
   ├─ parts/         20 个可插拔零件
   ├─ algo/          21 个算法（deficit / kappa / recall / affect_*）
   ├─ ports/          3 个外部边界（observers / ownership）
   └─ host/           2 个宿主胶水
```

## 三、依赖规则

1. **modules/ 是一张 DAG**：同级模块只能 import 对方的公开 `.js`，不许出现环（INV10）。
2. **业务代码里不许出现模型厂商名**（openai / anthropic / claude / gpt / qwen / deepseek-*）；
   要换模型只动 `model.js`（INV9）。
3. **SQL 的表必须归你**：每张表的读写归属写在 `src/ports/ownership.js`，
   填了 `writes` 的域写别人的表会被拒（INV10）。新表先登记，再写代码。
4. **路径只从 `src/paths.js` 取**。别在业务代码里写 `C:\Users\...` 或 `D:\deepseek...`——
   搬家时这些会静默指向空目录，不报错，只是读到空库（11-07 那次就是这么翻车的）。
5. **客户端不碰 `src/`**，宿主不 import `client.js`。

## 四、一次对话的路径

```
用户消息 → 宿主 hook(index.js) → features.*（要不要注入、怎么措辞）
        → modules/* + algo/*（缺陷/情绪/召回/关系）
        → db.js（读写 app.db）
        → 注入行回到上下文
设置页 ← /dsh-consciousness/api ← api.handle ← core/modules
```

## 五、新代码往哪放

| 你要加 | 放这里 | 别忘了 |
|---|---|---|
| 新表 / 新字段 | `src/db.js` 的 schema | 同步 `src/ports/ownership.js` |
| 新业务动作 | `src/core.js` 或 `src/modules/<域>.js` | 加测试到 `test/` |
| 新算法 | `src/algo/` | 纯函数，别碰 db |
| 接外部系统 | `src/ports/` | 边界只在这一层 |
| 设置页新面板 | `client.js` | UI 改动要刷新页面才生效 |
| 新脚本/体检 | `scripts/` | 一次性探针放 `scratch/`，运行产物放 `var/` |

## 六、收工前的三条命令

```bash
npm run gate            # check:arch + 566 条测试（一条命令跑完）
npm run check:hygiene   # 根目录卫生：只允许入口、源码、约定目录
npm run move:check      # 搬家前体检；有红的先修
```

## 七、两条禁区

- **不要建 `*.bak` 或整目录副本**——git 已经是历史了，副本只会让人误以为还有用。
- **不要"挑文件复制"到别处部署**——profile 里的 `node_modules/dsh-consciousness-v6` 是指向本目录的
  junction，改完即生效；再存一份副本就会出现两个真源。
