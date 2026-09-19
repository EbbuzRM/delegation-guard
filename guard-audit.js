// @ts-check
import path from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

/** @returns {string} */
function getLocalTimestamp() {
  const d = new Date()
  const pad = (/** @type {number} */ n, /** @type {number} */ length = 2) => n.toString().padStart(length, '0')
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const offsetText = sign + pad(Math.floor(Math.abs(offset) / 60)) + ':' + pad(Math.abs(offset) % 60)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${offsetText}`
}

/** @param {unknown} value */
function sanitizeForMarkdownLog(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return text.replace(/[\r\n]+/g, ' ⏎ ')
}

/**
 * @param {string} projectDirectory
 * @param {string} agent
 * @param {Record<string, any>} details
 * @param {(message: string) => void} onDiagnostic
 */
function handleDeniedEvent(projectDirectory, agent, details, onDiagnostic) {
  try {
    if (!projectDirectory) {
      onDiagnostic('handleDeniedEvent: projectDirectory not set. Skipping persistence.')
      return
    }
    if (projectDirectory.endsWith(path.sep + '.opencode') || projectDirectory.includes(path.sep + '.opencode' + path.sep)) {
      onDiagnostic(`handleDeniedEvent: projectDirectory is inside .opencode (${projectDirectory}). Skipping persistence.`)
      return
    }

    const metricsPath = path.resolve(projectDirectory, '.opencode', 'metrics_count.json')
    const incidentsPath = path.resolve(projectDirectory, '.planning', 'INCIDENTS.md')
    const lessonsPath = path.resolve(projectDirectory, '.planning', 'LESSONS.md')
    const metricsDir = path.dirname(metricsPath)
    const planningDir = path.dirname(incidentsPath)
    if (!existsSync(metricsDir)) mkdirSync(metricsDir, { recursive: true })
    if (!existsSync(planningDir)) mkdirSync(planningDir, { recursive: true })

    let metrics = { total_incidents: 0, counts: {}, lessons_written: {} }
    if (existsSync(metricsPath)) {
      try {
        metrics = JSON.parse(readFileSync(metricsPath, 'utf8'))
      } catch (error) {
        onDiagnostic(`Error reading metrics: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    metrics.total_incidents++
    const incidentId = `INC-${metrics.total_incidents.toString().padStart(4, '0')}`
    const checkName = sanitizeForMarkdownLog(details.check || 'unknown_check')
    const safeAgent = sanitizeForMarkdownLog(agent)
    const safeError = sanitizeForMarkdownLog(details.error || 'No details provided')
    const now = new Date()
    const dateText = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    appendFileSync(incidentsPath, `\n### [${incidentId}] [${checkName}] | ${dateText} | ${safeAgent} | Status: blocked | ${safeError}\n`, 'utf8')

    const lessonKey = `${agent}:${details.check || 'unknown_check'}`
    metrics.counts[lessonKey] = (metrics.counts[lessonKey] || 0) + 1
    if (metrics.counts[lessonKey] === 2 && !metrics.lessons_written[lessonKey]) {
      const synthesis = safeError.replace(/^❌ [^:]+: /, '')
      appendFileSync(lessonsPath, `- [${dateText}] ${safeAgent} attempted ${checkName} $\\rightarrow$ ${synthesis}\n`, 'utf8')
      metrics.lessons_written[lessonKey] = true
    }

    const metricsTmpPath = `${metricsPath}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(metricsTmpPath, JSON.stringify(metrics, null, 2), 'utf8')
    renameSync(metricsTmpPath, metricsPath)
  } catch (error) {
    onDiagnostic(`Denied event persistence failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Creates a project-scoped audit writer. Audit failures never change a guard
 * decision, and the returned writer captures only the supplied factory paths.
 *
 * @param {{auditLogDir: string, projectDirectory: string, onDiagnostic?: (message: string) => void}} options
 * @returns {(sessionId: string, eventType: string, agent: string|null, action: string, details?: Record<string, any>) => void}
 */
export function createAuditPersistence({ auditLogDir, projectDirectory, onDiagnostic = () => {} }) {
  return function persistAuditEvent(sessionId, eventType, agent, action, details = {}) {
    try {
      if (!existsSync(auditLogDir)) mkdirSync(auditLogDir, { recursive: true })
      const now = new Date()
      const pad = (/** @type {number} */ n) => n.toString().padStart(2, '0')
      const dateText = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
      const filepath = path.join(auditLogDir, `audit-${dateText}.jsonl`)
      appendFileSync(filepath, JSON.stringify({
        timestamp: getLocalTimestamp(),
        sessionId: sessionId || 'unknown',
        eventType,
        agent: agent || null,
        action,
        details
      }) + '\n', 'utf8')
      if (eventType === 'denied') handleDeniedEvent(projectDirectory, agent || 'unknown', details, onDiagnostic)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      onDiagnostic(`AUDIT-ERROR ${message}`)
      console.error('[GUARD-AUDIT-ERROR]', message)
    }
  }
}
