/**
 * 兼容层：对外仍从 core.js 导入；实现已按域拆到 kernel + modules/*（阶段 2）。
 */
export {
  ApiError, err, nid, tx, agent, active, event, chars,
  PARAMS, paramsList, setParam, getParam, getAllParams, writeParam, writeParams,
  modelStatus, METRICS, model,
} from './kernel.js'

export {
  addMemory, listMemory, setMemoryMark, softDeleteAgent, restoreAgent,
  softDelete, restoreMemory, recall, recallWithAlgo, softRecall,
  resolveConflict, listConflicts, listActiveMemories, memoryStats, tickConflicts,
} from './modules/memory.js'

export {
  seedState, seedPersona, getPersona, personaAxes, setPersona, setPersonaAuto, shrinkPersona, listRootTaboos,
  seedRelations, listRelations, upsertRelation, deleteRelation, tickRitual,
  listValues, setValue, listPreferences, addPreference, listTaboos, addTaboo,
} from './modules/persona.js'

export {
  seedAffect, getAffect, appraise, decayAffect, listEpisodes,
  sampleAffect, affectHistory, userGuess, recordUserFeedback, latestUserEmotion,
  rebuildBaselineAhead, affectGateEvents,
} from './modules/affect.js'

export {
  seedDrive, getDrive, getTokens, getUnlocked, hasCooldown, evaluateDrive, refillTokens, consumeToken,
  debitToken, applySatisfaction,
  listPorts, setPort,
  setCooldown, listCooldowns, cooldownActive,
  budgetGet, budgetSet, budgetConsume, budgetRefund,
  executeAction, listActions,
} from './modules/drive.js'

export {
  legitimacy, runGates, createProposal, getProposal, shadowTick,
  approve, reject, recoverChangeJournal, settleObservations, expireProposals, maybeDraftTaxonomy, maybeDraft, maybeDraftWithTarget, draftFromKnowledge, draftFromObservation, TARGET_IDS, listDrafts, promoteDraft, rollbackChange,
  inbox, inboxBulk, listProposals, listChanges,
} from './modules/selfmod.js'

export {
  seedRuleBindings, gcArtifacts, listBindings, listArtifacts, getArtifact,
  pinArtifact, activateBinding, restoreV0, hardDeleteArtifact,
  resolveStructureEdges, RULE_KINDS,
} from './modules/artifacts.js'

export {
  purgeExpired, exportZip, importZip, overview,
  getCondition, setCondition,
} from './modules/ops.js'
