/**
 * 模块关系边运行时（6 号文档 12 条）
 * 不建物理表：规格在常量；运行时产出可观测偏置与图数据。
 *
 * 性格 → 情绪 这条（E3）不再是固定增益，改由 modules/traits.js 算：
 *   强度 ×(0.85 + 0.30σ) × (1 + A)，A 只来自「被戳中的轴」；
 *   S < 门槛（0.55 − 0.25σ）时 A = 0——敏感只给幅度，不给 valence。
 */
import { stimulusStrength, traitAmp, triggerTable } from './traits.js'

/** @type {Array<{id:string,from:string,to:string,sign:number,gain:number,delay:number,condition:string,theory:string,observable:string}>} */
export const MODULE_EDGES = [
  { id: 'E1', from: 'memory', to: 'affect', sign: 1, gain: 0.08, delay: 1, condition: '负性记忆进 top-5', theory: '评估理论', observable: '召回后 irritated 上升' },
  { id: 'E2', from: 'affect', to: 'memory', sign: 1, gain: 2.0, delay: 0, condition: '高唤醒', theory: '唤醒—记忆', observable: '同批记忆保持度差' },
  { id: 'E3', from: 'persona', to: 'affect', sign: 1, gain: 0, delay: 0, condition: '性格被戳中（四轴 × 敏感度）', theory: 'Big Five / SPS / 特质激活', observable: '同事件强度更大（见 scaleAxis）' },
  { id: 'E4', from: 'affect', to: 'drive', sign: -1, gain: 0.05, delay: 1, condition: '孤独感', theory: '依恋', observable: 'D_R 缺口扩大' },
  { id: 'E5', from: 'drive', to: 'proactive', sign: 1, gain: 1.0, delay: 0, condition: 'D ≥ D0', theory: '社会交换', observable: '主动开口条数' },
  { id: 'E6', from: 'relation', to: 'persona', sign: 1, gain: 0.02, delay: 0, condition: '长期互动', theory: '符号互动', observable: '偏情感轴缓慢上移' },
  { id: 'E7', from: 'persona', to: 'relation', sign: 1, gain: 0.10, delay: 0, condition: '初次见面', theory: '依恋', observable: '初始 ρ 差异' },
  { id: 'E8', from: 'memory', to: 'persona', sign: 1, gain: 0.03, delay: 0, condition: '反复证实', theory: '布迪厄', observable: '偏好固化' },
  { id: 'E9', from: 'condition', to: 'affect', sign: -1, gain: 0.10, delay: 0, condition: 'load > 0.8', theory: '现象学', observable: '过载时 irritated' },
  { id: 'E10', from: 'relation', to: 'affect', sign: 1, gain: 0.06, delay: 0, condition: '主人 vs 陌生人', theory: '儒家 / 布伯', observable: '同一句话情绪不同' },
  { id: 'E11', from: 'affect', to: 'express', sign: 1, gain: 1.0, delay: 0, condition: '公共 / 私密', theory: '戈夫曼', observable: '句长与语气' },
  { id: 'E12', from: 'selfmod', to: 'all', sign: 0, gain: 1.0, delay: 0, condition: '七闸通过', theory: '韦伯', observable: '规则版本号' },
]

const NEG = ['讨厌', '烦', '错', '差', '生气', '危险', '删', '泄露']

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
const clamp01 = (x) => clamp(Number(x) || 0, 0, 1)

/**
 * 根据当前状态算即时偏置（供评价动力学使用）。
 * @returns {{ intensityMul:number, shadowIntensityMul:number, biasMul:number, congruenceAdd:number,
 *             labelTilt:string|null, memoryWeightMul:number, fired:string[], why:string[],
 *             axis:{S:number,T:number,A:number,trig:object,mode:string}, sigma:number }}
 */
function edgeById(edges, id) {
  return edges.find((e) => e.id === id) || MODULE_EDGES.find((e) => e.id === id)
}

export function computeEdgeBias(input = {}) {
  const edges = Array.isArray(input.edges) && input.edges.length ? input.edges : MODULE_EDGES
  const fired = []
  const why = []
  let edgeMul = 1
  let congruenceAdd = 0
  let labelTilt = null

  const mode = ['off', 'shadow', 'on'].includes(input.mode) ? input.mode : 'on'
  const sigma = clamp01(input.sigma ?? 0.5)
  const axes = input.axes && typeof input.axes === 'object' ? input.axes : {}
  const appraisal = input.appraisal && typeof input.appraisal === 'object' ? input.appraisal : {}
  const ownerClose = Number(input.ownerCloseness ?? 0.5)
  const ownerTrust = clamp01(input.ownerTrust ?? 0.5)

  // E10：亲近度偏置只给正向事件（越近，好话越受用）。
  // 负向事件交给 ρ 去解释（C2），否则「亲密的人骂我」会既加又被扣，方向互相抵消。
  // 已经判成「没碰到它」的消息（none）不加：那是任务话，不是好话。
  if (ownerClose >= 0.5 && appraisal.none !== true && Number(appraisal.goal_congruence ?? 0) >= 0) {
    congruenceAdd += Number(edgeById(edges, 'E10')?.gain || 0) * (ownerClose - 0.3)
    fired.push('E10')
  }

  // C2（9 号 §6）：同一句批评，信任低 → 伤得更重；信任高 → 当作「不是冲我」。
  // ρ=0.5 时中性（×1.0）；ρ→0 封顶 ×1.3，ρ→1 保底 ×0.7。
  let harmMul = 1
  if (Number(appraisal.goal_congruence ?? 0) < 0) {
    harmMul = clamp(1.3 - 0.6 * ownerTrust, 0.7, 1.3)
    if (Math.abs(harmMul - 1) > 0.01) {
      why.push('ρ=' + ownerTrust.toFixed(2) + ' → 负向伤害 ×' + harmMul.toFixed(2))
      fired.push('E10')
    }
  }

  const load = Number(input.load ?? 0)
  // 工况系数：累 / 忙 / 状态差时，情绪和记忆被放大多少。
  // 2.5 是中性刻度（默认）：过载时 +0.10、记忆 ×1.10，和改之前一模一样；
  // 往上调更容易被状态带跑，往下调则更稳。
  const condCoef = Math.max(0.5, Math.min(10, Number(input.conditionCoef ?? 2.5)))
  const condScale = condCoef / 2.5
  if (load > 0.8) {
    edgeMul += Number(edgeById(edges, 'E9')?.gain || 0) * condScale
    labelTilt = 'irritated'
    fired.push('E9')
  }

  const pack = Array.isArray(input.packTexts) ? input.packTexts : []
  const negHit = pack.slice(0, 5).some((t) => NEG.some((w) => String(t).includes(w)))
  if (negHit) {
    edgeMul += Number(edgeById(edges, 'E1')?.gain || 0)
    if (!labelTilt) labelTilt = 'irritated'
    fired.push('E1')
  }

  const arousal = Number(input.arousal ?? 0)
  if (arousal > 0.5) fired.push('E2') // 记忆权重偏置由调用方读 memoryWeightMul

  // ---- 五轴：σ 底噪 + 被戳中轴的表达度 ----
  const S = input.stimulus != null ? clamp01(input.stimulus) : stimulusStrength(appraisal, ownerClose)
  const trig = input.triggers && typeof input.triggers === 'object' ? input.triggers : triggerTable(input.text)
  const amp = traitAmp(axes, trig, S)
  const base = 0.85 + 0.30 * sigma
  let axisMul = base
  if (amp.A !== 0) {
    axisMul = base * (1 + amp.A)
    fired.push('E3')
    for (const k of amp.why) why.push('戳中 ' + k.toUpperCase() + '，A=' + amp.A.toFixed(3))
  }
  if (S < amp.threshold) why.push('S=' + S.toFixed(2) + ' < T=' + amp.threshold.toFixed(2) + '，不放大')
  else why.push('σ=' + sigma.toFixed(2) + ' → 底噪 ×' + base.toFixed(2))

  const fullMul = edgeMul * axisMul
  const outMul = mode === 'on' ? fullMul : edgeMul
  const biasMul = mode === 'on' ? Math.tanh(1.2 * amp.A) : 0

  return {
    intensityMul: clamp(outMul, 0.5, 1.8),
    shadowIntensityMul: clamp(fullMul, 0.5, 1.8),
    biasMul: clamp(biasMul, -0.99, 0.99),
    congruenceAdd: clamp(congruenceAdd, -0.3, 0.3),
    harmMul,
    memoryWeightMul: arousal > 0.5 ? 1 + Number(edgeById(edges, 'E2')?.gain || 0) * 0.05 * condScale : 1,
    labelTilt,
    fired,
    why,
    axis: { S: +S.toFixed(3), T: +amp.threshold.toFixed(3), A: +(mode === 'on' ? amp.A : 0), rawA: +amp.A.toFixed(3), trig, mode },
    sigma,
  }
}

/** 前端关系图 / 技术视图用；edges 缺省时回落模板常量（仅无绑定时） */
export function edgeGraph(relations = [], edges = MODULE_EDGES) {
  const src = Array.isArray(edges) && edges.length ? edges : MODULE_EDGES
  const nodes = [
    { id: 'memory', label: '记忆' },
    { id: 'persona', label: '鱼格' },
    { id: 'affect', label: '情绪' },
    { id: 'drive', label: '驱力' },
    { id: 'proactive', label: '主动开口' },
    { id: 'relation', label: '关系' },
    { id: 'condition', label: '工况' },
    { id: 'selfmod', label: '自修改' },
    { id: 'express', label: '表达' },
    { id: 'all', label: '全部' },
  ]
  return {
    nodes,
    edges: src.map((e) => ({
      id: e.id, from: e.from, to: e.to, sign: e.sign, gain: e.gain,
      delay: e.delay, condition: e.condition, theory: e.theory, observable: e.observable,
    })),
    relations: relations.map((r) => ({
      id: r.id, name: r.name, kind: r.kind, root: !!r.root,
      closeness: Number(r.closeness), trust: Number(r.trust), dependence: Number(r.dependence),
    })),
  }
}
