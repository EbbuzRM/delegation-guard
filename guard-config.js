// @ts-check
import path from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'

/** @type {{requireConductorRules: boolean, requireDiagnosisBeforeExecutor: boolean, requireVerifierAfterExecutor: boolean}} */
export const DEFAULT_WORKFLOW_POLICY = Object.freeze({
  requireConductorRules: true,
  requireDiagnosisBeforeExecutor: true,
  requireVerifierAfterExecutor: true
})

/**
 * Deep merge objects while replacing arrays. Agent allowlists and neverDo
 * entries are policy values, so concatenating them would silently widen or
 * narrow the configured policy.
 *
 * @param {Record<string, any>} target
 * @param {Record<string, any>} source
 * @returns {Record<string, any>}
 */
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    const sourceValue = source[key]
    const targetValue = target[key]
    if (
      sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue) &&
      targetValue && typeof targetValue === 'object' && !Array.isArray(targetValue)
    ) {
      deepMerge(targetValue, sourceValue)
    } else {
      target[key] = sourceValue
    }
  }
  return target
}

const PROFILE_BOOLEAN_FIELDS = [
  'allowEdit',
  'canWebfetch',
  'canPreDelegate',
  'readOnlyDespiteFullBash',
  'noTestExecution',
  'trustedForSecrets'
]
const PROFILE_ARRAY_FIELDS = [
  'bashAllowlist',
  'canDelegateTo',
  'keywords',
  'allowMentions',
  'neverDo'
]
const WRITE_SCOPES = new Set(['all', 'planning', 'sketches', 'spikes', 'readme'])

/**
 * Reject malformed policy values before they can reach runtime checks. A
 * malformed external config falls back to the restrictive safety-net rather
 * than partially widening permissions with JavaScript truthiness/coercion.
 *
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {string} agentName
 * @param {unknown} value
 * @returns {string|null}
 */
function validateProfile(agentName, value) {
  if (!isRecord(value)) return `profile "${agentName}" must be an object`

  for (const field of PROFILE_BOOLEAN_FIELDS) {
    if (field in value && typeof value[field] !== 'boolean') {
      return `profile "${agentName}" field "${field}" must be boolean`
    }
  }
  for (const field of PROFILE_ARRAY_FIELDS) {
    if (field in value && (!Array.isArray(value[field]) || value[field].some(item => typeof item !== 'string'))) {
      return `profile "${agentName}" field "${field}" must be an array of strings`
    }
  }
  if ('role' in value && typeof value.role !== 'string') {
    return `profile "${agentName}" field "role" must be a string`
  }
  if ('writeScope' in value && (typeof value.writeScope !== 'string' || !WRITE_SCOPES.has(value.writeScope))) {
    return `profile "${agentName}" field "writeScope" is invalid`
  }

  if ('delegation_rules' in value) {
    const rules = value.delegation_rules
    if (!isRecord(rules)) return `profile "${agentName}" field "delegation_rules" must be an object`
    if ('can_handle_directly' in rules && (!Array.isArray(rules.can_handle_directly) || rules.can_handle_directly.some(item => typeof item !== 'string'))) {
      return `profile "${agentName}" field "delegation_rules.can_handle_directly" must be an array of strings`
    }
    if ('must_delegate_to' in rules) {
      if (!isRecord(rules.must_delegate_to) || Object.entries(rules.must_delegate_to).some(([domain, target]) => !domain || typeof target !== 'string' || !target)) {
        return `profile "${agentName}" field "delegation_rules.must_delegate_to" must map domains to agent names`
      }
    }
  }
  return null
}

/**
 * @param {unknown} profiles
 * @returns {string|null}
 */
function validateProfiles(profiles) {
  if (!isRecord(profiles)) return 'agentProfiles must be an object'
  for (const [agentName, profile] of Object.entries(profiles)) {
    if (!agentName || agentName === '__proto__' || agentName === 'constructor' || agentName === 'prototype') {
      return `invalid agent name "${agentName}"`
    }
    const error = validateProfile(agentName, profile)
    if (error) return error
  }
  return null
}

/**
 * @param {string | undefined} projectDir
 * @param {string} pluginDirectory
 * @returns {{profiles: Record<string, any>, workflowPolicy?: Record<string, unknown>, source: string} | null}
 */
function tryLoadGuardConfig(projectDir, pluginDirectory) {
  const candidates = [
    ...(projectDir ? [path.join(projectDir, '.opencode', 'plugins', 'guard-config.json')] : []),
    ...(projectDir ? [path.join(projectDir, 'plugins', 'guard-config.json')] : []),
    path.join(pluginDirectory, 'guard-config.json')
  ]

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
      if (validateProfiles(parsed.agentProfiles) === null) {
        return { profiles: parsed.agentProfiles, workflowPolicy: parsed.workflowPolicy, source: candidate }
      }
    } catch {
      // Try the next candidate. Missing or malformed config uses the safety net.
    }
  }
  return null
}

/**
 * @param {unknown} value
 * @returns {{requireConductorRules: boolean, requireDiagnosisBeforeExecutor: boolean, requireVerifierAfterExecutor: boolean}}
 */
function normalizeWorkflowPolicy(value) {
  const policy = { ...DEFAULT_WORKFLOW_POLICY }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return policy
  const candidate = /** @type {Record<string, unknown>} */ (value)
  for (const key of Object.keys(DEFAULT_WORKFLOW_POLICY)) {
    if (typeof candidate[key] === 'boolean') policy[key] = candidate[key]
  }
  return policy
}

/**
 * Creates a loader scoped to one plugin factory. This prevents one project's
 * profiles from leaking into another project in the same OpenCode process.
 *
 * @param {{pluginDirectory: string, onDiagnostic?: (message: string) => void}} options
 * @returns {(projectDir?: string) => {profiles: Record<string, any>, workflowPolicy: {requireConductorRules: boolean, requireDiagnosisBeforeExecutor: boolean, requireVerifierAfterExecutor: boolean}}}
 */
export function createConfigLoader({ pluginDirectory, onDiagnostic = () => {} }) {
  /** @type {{profiles: Record<string, any>, workflowPolicy: {requireConductorRules: boolean, requireDiagnosisBeforeExecutor: boolean, requireVerifierAfterExecutor: boolean}, source: string|null, mtime: number|null, lastCheck: number} | null} */
  let cache = null

  return function loadGuardConfig(projectDir) {
    if (cache) {
      if (!cache.source) return { profiles: cache.profiles, workflowPolicy: cache.workflowPolicy }
      const now = Date.now()
      if (now - cache.lastCheck < 5000) return { profiles: cache.profiles, workflowPolicy: cache.workflowPolicy }
      cache.lastCheck = now
      try {
        const currentMtime = existsSync(cache.source) ? statSync(cache.source).mtimeMs : null
        if (currentMtime === cache.mtime) return { profiles: cache.profiles, workflowPolicy: cache.workflowPolicy }
        onDiagnostic(`Guard config changed (mtime ${cache.mtime} → ${currentMtime}) — reloading from ${cache.source}`)
      } catch (error) {
        onDiagnostic(`Cache mtime check failed: ${error instanceof Error ? error.message : String(error)}`)
        return { profiles: cache.profiles, workflowPolicy: cache.workflowPolicy }
      }
      cache = null
    }

    const fallback = createAgentProfilesFallback()
    const external = tryLoadGuardConfig(projectDir, pluginDirectory)
    if (!external) {
      const fallbackConfig = {
        profiles: fallback,
        workflowPolicy: { ...DEFAULT_WORKFLOW_POLICY },
        source: null,
        mtime: null,
        lastCheck: Date.now()
      }
      cache = fallbackConfig
      return { profiles: fallbackConfig.profiles, workflowPolicy: fallbackConfig.workflowPolicy }
    }

    for (const agentKey of Object.keys(fallback)) {
      if (external.profiles[agentKey]) deepMerge(fallback[agentKey], external.profiles[agentKey])
    }
    for (const agentKey of Object.keys(external.profiles)) {
      if (!fallback[agentKey]) {
        fallback[agentKey] = deepMerge(makeSafetyNetProfile(), external.profiles[agentKey])
      }
    }

    const loaded = {
      profiles: fallback,
      workflowPolicy: normalizeWorkflowPolicy(external.workflowPolicy),
      source: external.source,
      mtime: null,
      lastCheck: Date.now()
    }
    try {
      loaded.mtime = existsSync(external.source) ? statSync(external.source).mtimeMs : null
    } catch { /* keep the loaded policy usable */ }
    onDiagnostic(`Guard config loaded from: ${external.source} (merge with fallback)`)
    cache = loaded
    return { profiles: loaded.profiles, workflowPolicy: loaded.workflowPolicy }
  }
}

const SAFETY_NET_FALLBACK_ROLE = 'safety-net fallback (guard-config.json missing)'

/** @param {Record<string, any>} [overrides] */
function makeSafetyNetProfile(overrides = {}) {
  return {
    role: SAFETY_NET_FALLBACK_ROLE,
    bashAllowlist: [],
    canWebfetch: false,
    canDelegateTo: [],
    neverDo: [],
    keywords: [],
    allowMentions: [],
    canPreDelegate: false,
    writeScope: 'all',
    delegation_rules: { can_handle_directly: ['*'] },
    ...overrides
  }
}

export function createAgentProfilesFallback() {
  return {
    'codebase-mapper': makeSafetyNetProfile({ allowEdit: false, readOnlyDespiteFullBash: true, canPreDelegate: true, writeScope: 'all' }),
    'code-reviewer': makeSafetyNetProfile({ allowEdit: false, readOnlyDespiteFullBash: true, writeScope: 'all' }),
    'debugger': makeSafetyNetProfile({ allowEdit: false, readOnlyDespiteFullBash: true, writeScope: 'all' }),
    'doc-writer': makeSafetyNetProfile({ allowEdit: true, writeScope: 'readme' }),
    'executor': makeSafetyNetProfile({ allowEdit: true, writeScope: 'all', noTestExecution: true }),
    'explorer': makeSafetyNetProfile({ allowEdit: false, readOnlyDespiteFullBash: true, canPreDelegate: true, writeScope: 'planning' }),
    'security-auditor': makeSafetyNetProfile({ allowEdit: false, readOnlyDespiteFullBash: true, writeScope: 'all' }),
    'sketcher': makeSafetyNetProfile({ allowEdit: true, writeScope: 'sketches' }),
    'spiker': makeSafetyNetProfile({ allowEdit: true, writeScope: 'spikes' }),
    'tester': makeSafetyNetProfile({ allowEdit: true, writeScope: 'all' }),
    'verifier': makeSafetyNetProfile({ allowEdit: false, readOnlyDespiteFullBash: true, writeScope: 'all' })
  }
}
