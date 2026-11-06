import fs from 'node:fs'
// ① pair-judge：同 key 用例改写 + 新增复核/短文本
{
  const p = 'test/pair-judge.test.mjs'
  let s = fs.readFileSync(p, 'utf8')
  const old = `    // （a）同 fact_key：规则直接判取代，不调模型（历史脏数据才会出现两条 active 同 key）
    let calls = 0
    insertRaw(w.db, w.aid, { id: 'mem_k_old', text: '用户咖啡偏好是冰美式', fact_key: '用户.咖啡.偏好', created_at: ago(120) })
    insertRaw(w.db, w.aid, { id: 'mem_k_new', text: '用户咖啡偏好改成手冲', fact_key: '用户.咖啡.偏好', created_at: ago(5) })
    const a = { old: w.db.prepare('SELECT * FROM memory_items WHERE id=?').get('mem_k_old'), newer: w.db.prepare('SELECT * FROM memory_items WHERE id=?').get('mem_k_new') }
    const r1 = await judgePair({ db: w.db, aid: w.aid, oldRow: a.old, newerRow: a.newer, complete: async () => { calls++; return '无关' }, via: 'test' })
    check('同 key → supersede', r1.verdict === 'supersede', r1)
    check('同 key 不调模型', calls === 0, calls)`
  const neu = `    // （a）同 fact_key 不再规则直判：交给模型，且 supersede 要两次一致
    let calls = 0
    insertRaw(w.db, w.aid, { id: 'mem_k_old', text: '用户咖啡偏好是冰美式', fact_key: '用户.咖啡.偏好', created_at: ago(120) })
    insertRaw(w.db, w.aid, { id: 'mem_k_new', text: '用户咖啡偏好改成手冲', fact_key: '用户.咖啡.偏好', created_at: ago(5) })
    const a = { old: w.db.prepare('SELECT * FROM memory_items WHERE id=?').get('mem_k_old'), newer: w.db.prepare('SELECT * FROM memory_items WHERE id=?').get('mem_k_new') }
    const r1 = await judgePair({ db: w.db, aid: w.aid, oldRow: a.old, newerRow: a.newer, complete: async () => { calls++; return '取代' }, via: 'test' })
    check('同 key 交给模型 → 取代', r1.verdict === 'supersede', r1)
    check('同 key 不再规则直判（判 + 复核两次）', calls === 2, calls)

    // （a2）复核不一致 → uncertain，宁可不改
    calls = 0
    const r1b = await judgePair({ db: w.db, aid: w.aid, oldRow: a.old, newerRow: a.newer, useCache: false, complete: async () => { calls++; return calls === 1 ? '取代' : '补充' }, via: 'test' })
    check('复核不一致 → uncertain', r1b.verdict === 'uncertain' && r1b.reason === 'supersede-unconfirmed', r1b)

    // （a3）同 key 没模型 → uncertain
    const r1c = await judgePair({ db: w.db, aid: w.aid, oldRow: a.old, newerRow: a.newer, useCache: false, complete: null, via: 'test' })
    check('同 key 没模型 → uncertain', r1c.verdict === 'uncertain' && r1c.reason === 'no-model', r1c)

    // （a4）短文本不花模型（真数据里「嗯嗯很好了」被判成取代）
    const short = makePair(w, { oldText: '嗯嗯很好了', newText: '这样是不是有点暴力了', oldKey: '用户.评价.短', newKey: '用户.评价.质疑', oldType: 'appraisal', newType: 'appraisal' })
    let shortCalls = 0
    const r1d = await judgePair({ db: w.db, aid: w.aid, oldRow: short.old, newerRow: short.newer, complete: async () => { shortCalls++; return '取代' }, via: 'test' })
    check('短文本 → uncertain(too-short)', r1d.verdict === 'uncertain' && r1d.reason === 'too-short', r1d)
    check('短文本不调模型', shortCalls === 0, shortCalls)`
  if (!s.includes(old)) { console.error('pair-judge anchor missing'); process.exit(1) }
  fs.writeFileSync(p, s.replace(old, neu), 'utf8')
  console.log('pair-judge test patched')
}
// ② write-gate：supersede 现在调两次
{
  const p = 'test/write-gate-judge.test.mjs'
  let s = fs.readFileSync(p, 'utf8')
  const a = "check('shadow：调了一次模型', calls === 1, calls)"
  if (!s.includes(a)) { console.error('gate anchor missing'); process.exit(1) }
  fs.writeFileSync(p, s.replace(a, "check('shadow：supersede 判了两次（判 + 复核）', calls === 2, calls)"), 'utf8')
  console.log('gate test patched')
}
// ③ judge-sim：daily_max 下 supersede 复核会让调用数翻倍
{
  const p = 'test/judge-sim.test.mjs'
  let s = fs.readFileSync(p, 'utf8')
  const a = "check('daily_max=2：只调了两次模型', calls === 2, calls)"
  if (!s.includes(a)) { console.error('sim anchor missing'); process.exit(1) }
  fs.writeFileSync(p, s.replace(a, "check('daily_max=2：只判了两次对（每对 supersede 调两次）', calls === 4, calls)"), 'utf8')
  console.log('sim test patched')
}
