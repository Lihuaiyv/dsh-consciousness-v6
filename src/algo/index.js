/**
 * 算法包入口：登记内置实现，并提供统一 run。
 */

import { register, run as registryRun, has, get, list } from './registry.js'
import { resolveVersion, setBinding, getBinding, listBindings, clearBindings, attachDb, hydrateAll } from './active.js'
import { decayV1, decayV1b } from './decay.js'
import { deficitV1, deficitV1b, deficitV1c, deficitV1d, deficitV2, deficitV3 } from './deficit.js'
import { recallV2, recallV2b } from './recall.js'
import { appraiseV1, appraiseV1b } from './appraise.js'
import { affectDynV1, affectDynV1b } from './affect_dyn.js'
import { relationDynV1, relationDynV1b } from './reldyn.js'

let bootstrapped = false

export function bootstrapAlgos() {
  if (bootstrapped) return list()
  register(decayV1)
  register(decayV1b)
  register(deficitV1)
  register(deficitV1b)
  register(deficitV1c)
  register(deficitV1d)
  register(deficitV2)
  register(deficitV3)
  register(recallV2)
  register(recallV2b)
  register(appraiseV1)
  register(appraiseV1b)
  register(affectDynV1)
  register(affectDynV1b)
  register(relationDynV1)
  register(relationDynV1b)
  bootstrapped = true
  return list()
}

bootstrapAlgos()

/**
 * 按实例绑定（或 fallback 版本）跑算法。
 */
export function runBound(name, aid, ctx, input, fallbackVersion = 'v2') {
  const ver = resolveVersion(aid, name, fallbackVersion)
  return registryRun(name, ver, ctx, input)
}

export {
  register, registryRun as run, has, get, list,
  resolveVersion, setBinding, getBinding, listBindings, clearBindings,
  attachDb, hydrateAll,
}
