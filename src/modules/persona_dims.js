/**
 * 三观维度的名字、含义句、初值和地板。词表推导删掉之后，页面和折算仍从这里取名字。
 * 这里没有经历、没有计算。
 */
export const VALUE_DIMS = [
  ['benevolence', '仁善', '照顾身边的人'],
  ['universalism', '普世', '公平、对所有人'],
  ['selfDirection', '自主', '自己决定，不想被安排'],
  ['security', '安全', '稳定、不失去'],
  ['tradition', '传统', '老规矩、一直这样'],
  ['conformity', '从众', '守规矩、别出格'],
  ['achievement', '成就', '做成事、变强'],
  ['hedonism', '享乐', '舒服、好玩'],
  ['stimulation', '刺激', '新鲜、冒险'],
  ['power', '权力', '说了算、有地位'],
]

export const VALUE_PAIRS = [
  ['benevolence', 'power'],
  ['tradition', 'selfDirection'],
  ['security', 'stimulation'],
]

export const VALUE_INIT = 0.1
export const VALUE_FLOOR = 0.02

export const WORLD_DIMS = [
  ['safe', '安全世界', '世界大体安全、善意', '世界危险、处处要防'],
  ['enticing', '丰饶迷人', '处处有可探、值得看', '世界乏味、少有新意'],
  ['alive', '有机有意', '事件像有呼应与意味', '世界像冷机器、无目的'],
  ['just', '公正可期', '善恶大体有报', '公正靠不住'],
  ['agency', '人能作为', '努力与选择管用', '多半是运气/命运'],
  ['trustPeople', '人性可托', '多数人可相处、可信', '对人多疑、讽世'],
  ['complexity', '情境复杂', '事无定法、要看场合', '规矩死板、一条路'],
  ['revisable', '知可修订', '看法能被证据改', '成见难动、不易认错'],
]

export const WORLD_PAIRS = [
  ['just', 'complexity'],
  ['agency', 'alive'],
  ['trustPeople', 'safe'],
]

export const WORLD_INIT = 0.5
export const WORLD_FLOOR = 0.08
export const WORLD_CEIL = 0.92

export const LIFE_DIMS = [
  ['coherence', '人生连贯', '经历能串成故事', '片段、说不清自己'],
  ['purpose', '有所朝向', '有在追的方向', '漂着、缺少方向'],
  ['mattering', '事关重要', '觉得自己的在场要紧', '可有可无、无足轻重'],
  ['search', '求索意义', '还在认真找/加深意义', '不太追问意义'],
  ['growth', '向善生长', '看重成为更好的自己', '安于现状、少求变'],
  ['communion', '与他者成全', '意义在关系与照料里', '更自足、少靠关系定调'],
  ['horizon', '朝向远景', '为以后打算、能推迟满足', '更活在当下即时'],
]

export const LIFE_PAIRS = [
  ['search', 'coherence'],
  ['purpose', 'search'],
  ['growth', 'horizon'],
]

export const LIFE_INIT = 0.5
export const LIFE_FLOOR = 0.08
export const LIFE_CEIL = 0.92
