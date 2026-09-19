// @ts-check

/**
 * Creates isolated state for one OpenCode session. The caller owns the
 * resulting object; this module keeps the state schema separate from hooks.
 *
 * @returns {{ phase: 'idle'|'pre-delegation'|'delegated', lastAgent: string|null, webfetchAudit: any[], secretDetectionAudit: any[], delegationStack: string[], delegationSequence: string[], taskRetries: Record<string, number>, conductorRulesLoaded: boolean, scopeViolationTargets: Record<string, number> }}
 */
export function createSessionState() {
  return {
    phase: /** @type {'idle'} */ ('idle'),
    lastAgent: null,
    webfetchAudit: /** @type {any[]} */ ([]),
    secretDetectionAudit: /** @type {any[]} */ ([]),
    delegationStack: /** @type {string[]} */ ([]),
    delegationSequence: /** @type {string[]} */ ([]),
    taskRetries: /** @type {Record<string, number>} */ ({}),
    conductorRulesLoaded: false,
    scopeViolationTargets: /** @type {Record<string, number>} */ ({})
  }
}
