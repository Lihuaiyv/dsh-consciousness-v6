(node:11132) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
{
  "sentence": {
    "before": {
      "hard": 7,
      "soft": 0,
      "kept": 60
    },
    "after": {
      "hard": 1,
      "soft": 5,
      "kept": 56
    }
  },
  "memory": {
    "before": {
      "tokens": 80,
      "total": 5,
      "time": 0,
      "special": 3,
      "bare": 2,
      "hardCut": 0
    },
    "after": {
      "tokens": 86,
      "total": 5,
      "time": 2,
      "special": 3,
      "bare": 0,
      "hardCut": 0
    }
  },
  "block": {
    "before": {
      "tokens": 301,
      "lines": 21,
      "examples": 0,
      "timeTags": 0
    },
    "after": {
      "tokens": 411,
      "lines": 26,
      "examples": 4,
      "timeTags": 2
    }
  },
  "pressure": {
    "before": [
      {
        "budget": 200,
        "hasAffect": false,
        "tokens": 200
      },
      {
        "budget": 150,
        "hasAffect": false,
        "tokens": 150
      },
      {
        "budget": 120,
        "hasAffect": false,
        "tokens": 120
      }
    ],
    "after": [
      {
        "budget": 200,
        "hasAffect": true,
        "tokens": 199
      },
      {
        "budget": 150,
        "hasAffect": true,
        "tokens": 150
      },
      {
        "budget": 120,
        "hasAffect": true,
        "tokens": 120
      }
    ]
  },
  "anchor": {
    "before": {
      "distinct": 2,
      "picked": 10
    },
    "after": {
      "distinct": 4,
      "picked": 10
    }
  }
}

## 对照表

| 指标 | 改前 | 改后 | 说明 |
|---|---|---|---|
| 超长句硬切（条） | 7 | 1 | 停在半个词上的句子数 |
| 切在标点处（条） | 0 | 5 | 读起来还是一句话 |
| 记忆行带时间标签（条） | 0 | 2 | 共 5 行 |
| 记忆行完全没有时间线索（条） | 2 | 0 | 越少越好 |
| 记忆块硬切残留（行） | 0 | 0 | 以「…」结尾的记忆行 |
| 注入示例条数 | 0 | 4 | 默认 19 条 |
| 整段注入 tokens | 301 | 411 | 预算 800 |
| 200 预算下保住情绪 | 否 | 是 |  |
| 150 预算下保住情绪 | 否 | 是 |  |
| 5 轮锚点去重后条数 | 2/10 | 4/10 | 越多越不重复 |
