/**
 * 起草流水线（P3）：取料 → J32 反事实标注 → 按放弃物聚类 → J33 起草 → 过闸入收件箱。
 *
 * 只产出草稿，不写账本；写账本永远要人批（draft.commitDraft + human:true）。
 * 调模型的次数是要算的：最多 60 条料、每批 8 条 → 最多 8 次 T1；每簇一次 T2，一簇出 2–3 版。
 *
 * 任务状态存在 flags（sangguan.draftjob:<aid>），页面轮询看；HTTP 不阻塞等结果。
 */
import { getFlag, setFlag } from '../../kernel.js'
import { call } from './llm.js'
import { mineEpisodes } from './draftfeed.js'
import { clusterByForegone, buildDrafts } from './draft.js'
import { createDraft } from './draftstore.js'

const DAY = 86400000
const STALE_MS = 10 * 60 * 1000
const BATCH = 8
const MAX_EPISODES = 60
const MAX_ANNOTATED = 60

const jobKey = (aid) => 'sangguan.draftjob:' + aid
const dayOf = (iso) => String(iso || '').slice(0, 10)

function readJob(db, aid) {
  try {
    const v = JSON.parse(getFlag(db, jobKey(aid)) || 'null')
    return v && typeof v === 'object' ? v : null
  } catch { return null }
}

function saveJob(db, aid, job) {
  setFlag(db, jobKey(aid), JSON.stringify(job))
  return job
}

/** 页面用：当前任务状态（没有就是 null）。 */
export function draftJob(db, aid) {
  return readJob(db, aid)
}

/**
 * 跑一轮起草。askAnno / askDraft 可注入（测试走假模型）。
 * 不抛错：坏一批只记 error，不让整轮死掉。
 */
export async function runDraftRound(db, aid, opt = {}) {
  const now = opt.at || new Date().toISOString()
  const day = dayOf(now)
  // 与夜巡其他步骤一致：调用方给了 chat（测试 / 自定义端点）就用它，别偷偷走宿主模型
  const ctx = { db, aid, day, at: now, chat: opt.chat }
  const askAnno = opt.askAnno || ((input) => call(ctx, 'J32', input))
  const errors = []
  const res = { episodes: 0, annotated: 0, clusters: 0, drafts: 0, created: 0, duplicates: 0, errors, day }

  const feed = mineEpisodes(db, aid, { limit: opt.feedLimit || 3000, max: opt.maxEpisodes || MAX_EPISODES })
  const eps = feed.episodes
  res.episodes = eps.length
  if (!eps.length) return res

  const ann = []
  for (let i = 0; i < eps.length && ann.length < MAX_ANNOTATED; i += BATCH) {
    const slice = eps.slice(i, i + BATCH)
    let r
    try {
      r = await askAnno(slice)
    } catch (e) {
      errors.push({ step: 'J32', at: slice[0] && slice[0].at, error: String((e && e.message) || e).slice(0, 200) })
      continue
    }
    if (!r || !r.ok || !r.out || !Array.isArray(r.out.items)) {
      errors.push({ step: 'J32', at: slice[0] && slice[0].at, error: (r && r.code) || 'BAD_OUT' })
      continue
    }
    for (const it of r.out.items) {
      const idx = Number(it && it.idx)
      if (!Number.isInteger(idx) || idx < 0 || idx >= slice.length) continue
      const alt = String((it && it.alt) || '').trim()
      const fore = String((it && it.foregone) || '').trim()
      if (!alt || !fore) continue
      const ep = slice[idx]
      ann.push({
        ref: 'ep:' + (i + idx) + ':' + dayOf(ep.at),
        at: ep.at,
        alt,
        foregone: fore,
        cost_to: it.cost_to ? String(it.cost_to).slice(0, 60) : null,
        trigger: ep.trigger || ep.before || null,
      })
    }
  }
  res.annotated = ann.length
  if (!ann.length) return res

  const clusters = clusterByForegone(ann)
  res.clusters = clusters.length
  if (!clusters.length) return res

  const drafts = await buildDrafts(db, aid, clusters, { at: now, ask: opt.askDraft || ((input) => call(ctx, 'J33', input)) })
  res.drafts = drafts.length
  const byKind = new Map(clusters.map((c) => [c.kind, c]))
  for (const d of drafts) {
    try {
      const row = createDraft(db, aid, {
        kind: d.kind,
        text: d.text,
        alt: d.alt,
        foregone: d.foregone,
        cost_to: d.cost_to,
        exclusion: d.exclusion,
        boundary: d.boundary,
        counterexample: d.counterexample,
        evidence: d.evidence,
        cluster: byKind.get(d.kind) || null,
        source: 'llm',
        batch_key: 'sg:draft:' + day,
      }, { at: now })
      if (row.duplicate) res.duplicates++
      else res.created++
    } catch (e) {
      errors.push({ step: 'create', text: String(d.text || '').slice(0, 40), error: String((e && e.message) || e).slice(0, 200) })
    }
  }
  return res
}

/**
 * 起一轮起草（不等人）：返回 { started, job }。
 * 正在跑（10 分钟内）就拒绝重复起；跑完/报错都会把结果写回 flags。
 */
export function startDraftRound(db, aid, opt = {}) {
  const cur = readJob(db, aid)
  if (cur && cur.status === 'running' && Date.now() - Date.parse(cur.started_at) < STALE_MS) {
    return { started: false, job: cur }
  }
  const t = opt.at || new Date().toISOString()
  const job = saveJob(db, aid, {
    status: 'running', started_at: t, ended_at: null, day: dayOf(t),
    created: 0, summary: null, error: null,
  })
  const p = runDraftRound(db, aid, { ...opt, at: t })
    .then((res) => {
      saveJob(db, aid, { ...job, status: 'done', ended_at: new Date().toISOString(), created: res.created, summary: res })
      return res
    })
    .catch((e) => {
      saveJob(db, aid, { ...job, status: 'error', ended_at: new Date().toISOString(), error: String((e && e.message) || e).slice(0, 300) })
      return null
    })
  if (opt.await) return p.then((res) => ({ started: true, job: draftJob(db, aid), result: res }))
  if (typeof p.catch === 'function') p.catch(() => {})
  return { started: true, job }
}
