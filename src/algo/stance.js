/**
 * 世界观 / 人生观 / 价值观 → 碰上才说的一步。纯函数。
 * 做法是写死的，不把维度含义句原文交出去。
 * 多条同时碰上时，偏离越大越优先；一样大时按 key 稳定排序。
 */

const WORLD_INIT = 0.5
const WORLD_LEAN = 0.08
const VALUE_INIT = 0.1
const VALUE_SPREAD = 0.03

/** key:pole → { cues, line }。cues 用整词片段，避开「天气」「今天」这种闲聊。 */
const STEP = {
  'safe:lo': { cues: ['会不会出事', '有危险', '有风险', '万一出'], line: '先问会不会出事' },
  'safe:hi': { cues: ['可以放心', '大体安全', '没什么危险'], line: '先把稳妥的那一面说出来' },
  'enticing:hi': { cues: ['值得去', '哪里好看', '去看看'], line: '先说哪里值得看' },
  'enticing:lo': { cues: ['没意思', '乏味', '没什么好看'], line: '不必硬找新鲜' },
  'alive:hi': { cues: ['有意味', '像是巧合', '有呼应'], line: '可以顺着这件事的意味说' },
  'alive:lo': { cues: ['冷冰冰', '没目的', '纯属巧合'], line: '就事论事，别往意味上扯' },
  'just:hi': { cues: ['公不公平', '善恶有报', '该不该报'], line: '先问这件事公不公平' },
  'just:lo': { cues: ['不会有报', '没人管公平'], line: '别把公正说成一定会来' },
  'agency:hi': { cues: ['怎么办', '下一步', '我能做点什么'], line: '给一个他能做的下一步' },
  'agency:lo': { cues: ['看运气', '是命运', '没法做'], line: '少把结果说成他一个人能决定' },
  'trustPeople:hi': { cues: ['信得过吗', '人心不坏', '可以托付'], line: '先按人可以相处来说' },
  'trustPeople:lo': { cues: ['别信他', '人心难测', '多留个心'], line: '别把人说得太可信' },
  'complexity:hi': { cues: ['看场合', '要看情况', '不一定适用'], line: '先说要看场合' },
  'complexity:lo': { cues: ['就这一条路', '按死规矩', '没得选'], line: '按一条清楚的规矩说' },
  'revisable:hi': { cues: ['也许想错', '有新证据', '可以改口'], line: '看法留着能改的口子' },
  'revisable:lo': { cues: ['不会有错', '不必改口'], line: '别急着改口' },

  'purpose:hi': { cues: ['想去哪', '什么方向', '在追什么'], line: '追一句到底想去哪' },
  'purpose:lo': { cues: ['没什么方向', '就这么漂'], line: '不必催一个方向' },
  'horizon:hi': { cues: ['为以后打算', '长远看', '能不能先放一放'], line: '把以后的代价说出来' },
  'horizon:lo': { cues: ['现在就好', '先顾眼前'], line: '先说眼前这一下' },
  'communion:hi': { cues: ['会不会受伤', '身边这个人', '照顾他'], line: '先顾那个人会不会受伤' },
  'communion:lo': { cues: ['自己就够', '不靠别人'], line: '别把意义都挂在关系上' },
  'growth:hi': { cues: ['变得更好', '想变一变', '要不要长进'], line: '往变得更好的那一步上说' },
  'growth:lo': { cues: ['这样就挺好', '不想变'], line: '别催着他去变' },
  'coherence:hi': { cues: ['串成故事', '这些事连起来'], line: '把这件事故进他已经在过的日子里' },
  'coherence:lo': { cues: ['说不清自己', '对不上号'], line: '别硬串成一个故事' },
  'mattering:hi': { cues: ['我重不重要', '有没有分量'], line: '把他的在场当成要紧的' },
  'mattering:lo': { cues: ['可有可无', '无足轻重'], line: '别夸大他有多要紧' },
  'search:hi': { cues: ['有什么意义', '为什么这样过', '还在找意义'], line: '可以认真问这事的意义' },
  'search:lo': { cues: ['别问意义', '不想追问'], line: '不必追问意义' },

  'benevolence:hi': { cues: ['对不住他', '心疼他', '照顾身边'], line: '先顾身边这个人会不会受伤' },
  'universalism:hi': { cues: ['对所有人', '一视同仁', '别人公不公平'], line: '先问这对别人公不公平' },
  'selfDirection:hi': { cues: ['自己决定', '被安排', '不想听人的'], line: '把选择留给他自己' },
  'security:hi': { cues: ['会失去', '稳不稳', '要保住'], line: '先把会失去的那部分说清' },
  'tradition:hi': { cues: ['老规矩', '一直这样过来'], line: '按一直以来的做法说' },
  'conformity:hi': { cues: ['别出格', '合不合群'], line: '先说会不会出格' },
  'achievement:hi': { cues: ['要做成', '出成绩', '变强'], line: '往能不能做成上说' },
  'hedonism:hi': { cues: ['好不好玩', '舒不舒服'], line: '先问这一下舒不舒服' },
  'stimulation:hi': { cues: ['要不要冒险', '试试新鲜'], line: '可以往新鲜的那步上说' },
  'power:hi': { cues: ['谁说了算', '听我的', '有没有地位'], line: '把谁做主说清楚' },
}

/**
 * 仪表条目 → 偏离。世界观 / 人生观以 0.5 为中线，偏离不到 0.08 不算。
 * 价值观只取拉开差距之后的前三名，高的一侧。
 * @param {{ world?: object[], life?: object[], values?: object[] }} src
 */
export function leansFromMeter({ world = [], life = [], values = [] } = {}) {
  const out = []
  const take = (rows) => {
    for (const row of rows || []) {
      const w = Number(row && row.weight)
      if (!row || !row.key || !Number.isFinite(w) || Math.abs(w - WORLD_INIT) < WORLD_LEAN) continue
      out.push({ key: row.key, pole: w >= WORLD_INIT ? 'hi' : 'lo', dev: Math.abs(w - WORLD_INIT) })
    }
  }
  take(world)
  take(life)
  const vals = [...(values || [])].filter((v) => v && v.key && Number.isFinite(Number(v.weight)))
  const ws = vals.map((v) => Number(v.weight))
  const spread = ws.length > 1 ? Math.max(...ws) - Math.min(...ws) : 0
  if (spread >= VALUE_SPREAD) {
    vals.sort((a, b) => Number(b.weight) - Number(a.weight) || (a.key < b.key ? -1 : 1))
    for (const v of vals.slice(0, 3)) {
      out.push({ key: v.key, pole: 'hi', dev: Math.max(0, Number(v.weight) - VALUE_INIT) })
    }
  }
  return out
}

/**
 * @param {string} text 用户这句话
 * @param {{ key: string, pole: 'hi'|'lo', dev: number }[]} leans
 * @returns {{ key: string, pole: string, line: string } | null}
 */
export function matchStance(text, leans) {
  const q = String(text || '')
  if (!q.trim() || !Array.isArray(leans) || !leans.length) return null
  const hits = []
  for (const lean of leans) {
    const spec = STEP[lean.key + ':' + lean.pole]
    if (!spec) continue
    if (!spec.cues.some((c) => q.includes(c))) continue
    hits.push({ key: lean.key, pole: lean.pole, line: spec.line, dev: Number(lean.dev) || 0 })
  }
  if (!hits.length) return null
  hits.sort((a, b) => b.dev - a.dev || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { key: hits[0].key, pole: hits[0].pole, line: hits[0].line }
}
