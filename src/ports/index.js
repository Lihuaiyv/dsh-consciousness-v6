/**
 * 模块端口聚合（INV10）：跨模块只经此处 / 各模块 query·command 导出。
 */
import * as memory from '../modules/memory.js'
import * as persona from '../modules/persona.js'
import * as affect from '../modules/affect.js'
import * as drive from '../modules/drive.js'
import * as selfmod from '../modules/selfmod.js'
import * as chat from '../modules/chat.js'

export const memoryPort = {
  query: {
    list: memory.listMemory,
    listActive: memory.listActiveMemories,
    stats: memory.memoryStats,
    conflicts: memory.listConflicts,
    recall: memory.recall,
  },
  command: {
    add: memory.addMemory,
    mark: memory.setMemoryMark,
    softDelete: memory.softDelete,
    restore: memory.restoreMemory,
    resolveConflict: memory.resolveConflict,
  },
}

export const personaPort = {
  query: {
    get: persona.getPersona,
    listRootTaboos: persona.listRootTaboos,
  },
  command: {
    set: persona.setPersona,
    seed: persona.seedPersona,
    seedAll: persona.seedState,
  },
}

export const affectPort = {
  query: {
    get: affect.getAffect,
    episodes: affect.listEpisodes,
    guess: affect.userGuess,
  },
  command: {
    appraise: affect.appraise,
    decay: affect.decayAffect,
    seed: affect.seedAffect,
    feedback: affect.recordUserFeedback,
  },
}

export const drivePort = {
  query: {
    get: drive.getDrive,
    tokens: drive.getTokens,
    unlocked: drive.getUnlocked,
    hasCooldown: drive.hasCooldown,
    ports: drive.listPorts,
    cooldowns: drive.listCooldowns,
    budget: drive.budgetGet,
    actions: drive.listActions,
  },
  command: {
    evaluate: drive.evaluateDrive,
    refill: drive.refillTokens,
    consume: drive.consumeToken,
    debit: drive.debitToken,
    satisfy: drive.applySatisfaction,
    setPort: drive.setPort,
    seed: drive.seedDrive,
    setCooldown: drive.setCooldown,
    budgetSet: drive.budgetSet,
    budgetConsume: drive.budgetConsume,
    executeAction: drive.executeAction,
  },
}

export const selfmodPort = {
  query: {
    inbox: selfmod.inbox,
    proposals: selfmod.listProposals,
    changes: selfmod.listChanges,
    getProposal: selfmod.getProposal,
  },
  command: {
    createProposal: selfmod.createProposal,
    shadowTick: selfmod.shadowTick,
    approve: selfmod.approve,
    reject: selfmod.reject,
  },
}

export const chatPort = {
  query: {
    recentUserTexts: chat.listRecentUserTexts,
  },
}

export { OWNERSHIP, SHARED, tablesForFile, isTableAllowed } from './ownership.js'
