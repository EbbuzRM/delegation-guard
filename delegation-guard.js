// @ts-check
import path from 'node:path'
import { appendFileSync, existsSync, mkdirSync, writeFileSync, readFileSync, statSync, renameSync, truncateSync } from 'node:fs'
import { fileURLToPath } from 'node:url'


let _projectDirectory = ''
/** Fallback for the containment check when _projectDirectory is unreliable (see validatePathZone). */
let _worktree = ''

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const runtimeLogPath = path.join(__dirname, 'delegation-guard-runtime.log')

// ============================================
// CONFIG LOADING — made resilient for ESM contexts
// ============================================
// Global cache: once loaded, it is not re-read.
// Loading is moved into the factory (where project/directory are available).
/** @type {Record<string, any> | null} */
let _cachedAgentProfiles = null
/** Path of the external config file currently in cache (for runtime change detection) */
let _cachedConfigSource = null
/** mtimeMs of the config file at caching time (for automatic invalidation) */
let _cachedConfigMtime = null
/** Timestamp of the last check of the config file on disk (for throttling) */
let _lastConfigCheckTime = 0

/**
 * Deep merge: overwrites values of `source` onto `target`.
 * - Recursive objects
 * - Arrays replaced (not concatenated) — expected behavior for allowlist, neverDo, etc.
 * - Overwritten primitives
 *
 * @param {Record<string, any>} target
 * @param {Record<string, any>} source
 * @returns {Record<string, any>} mutated target
 */
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    const sVal = source[key]
    const tVal = target[key]
    if (
      sVal && typeof sVal === 'object' && !Array.isArray(sVal) &&
      tVal && typeof tVal === 'object' && !Array.isArray(tVal)
    ) {
      deepMerge(tVal, sVal)
    } else {
      target[key] = sVal
    }
  }
  return target
}

/**
 * Tries to read guard-config.json from multiple possible locations.
 * Order: 1) path relative to project directory, 2) absolute path (__dirname).
 *
 * @param {string | undefined} projectDir - project directory (from OpenCode factory)
 * @returns {{ profiles: Record<string, any>, source: string } | null}
 */
function tryLoadGuardConfig(projectDir) {
  const candidates = [
    // 1. Relative to the project directory (most reliable in ESM)
    ...(projectDir ? [path.join(projectDir, '.opencode', 'plugins', 'guard-config.json')] : []),
    // 2. Relative to plugins if project dir is the root
    ...(projectDir ? [path.join(projectDir, 'plugins', 'guard-config.json')] : []),
    // 3. Absolute path next to the plugin itself (__dirname)
    path.join(__dirname, 'guard-config.json')
  ]

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue
      const content = readFileSync(candidate, 'utf8')
      const parsed = JSON.parse(content)
      if (parsed.agentProfiles && typeof parsed.agentProfiles === 'object') {
        return { profiles: parsed.agentProfiles, source: candidate }
      }
    } catch {
      // Continue with the next candidate
    }
  }
  return null
}

/**
 * Loads and caches agent profiles.
 * If external loading fails, uses the fallback and logs the error.
  * If external loading succeeds, does a deep merge: the MINIMAL safety-net
  * fallback is the base, explicit external values override. The full
  * policy (neverDo, keywords, allowMentions, allowlists, scopes) lives in
  * guard-config.json — the fallback only fills structural gaps when the
  * external config omits a field, and takes over entirely (fail-closed on
  * mutative capabilities) when the config is missing.
 *
 * @param {string | undefined} projectDir
 * @returns {Record<string, any>}
 */
function loadAgentProfiles(projectDir) {
  // If cache is populated, check if the config file on disk has changed.
  // Automatic invalidation based on mtime: if guard-config.json is
// modified at runtime, profiles are reloaded without restarting the process.
  if (_cachedAgentProfiles) {
    // Fallback cache (no external file): no reload needed.
    if (!_cachedConfigSource) return _cachedAgentProfiles

    // Throttling: performs disk check at most once every 5 seconds (5000ms)
    const now = Date.now()
    if (now - _lastConfigCheckTime < 5000) {
      return _cachedAgentProfiles
    }
    _lastConfigCheckTime = now

    try {
      if (existsSync(_cachedConfigSource)) {
        const mtime = statSync(_cachedConfigSource).mtimeMs
        if (mtime === _cachedConfigMtime) {
          return _cachedAgentProfiles
        }
        runtimeLog(`Guard config modified (mtime ${_cachedConfigMtime} → ${mtime}) — reloading from ${_cachedConfigSource}`)
      } else {
        // File removed: force reload (will fall back if not found elsewhere)
        runtimeLog(`Guard config removed (${_cachedConfigSource}) — reloading`)
      }
    } catch (e) {
      runtimeLog(`Cache mtime check failed: ${e.message} — keeping cache`)
      return _cachedAgentProfiles
    }
    // mtime changed (or file removed): invalidate cache and reload below
    _cachedAgentProfiles = null
    _cachedConfigSource = null
    _cachedConfigMtime = null
  }

  const fallback = createAgentProfilesFallback()
  const external = tryLoadGuardConfig(projectDir)

  if (!external) {
    console.error('[Guard] guard-config.json not found in any location — using MINIMAL safety-net fallback (bash/webfetch/sub-delegation: total deny)')
    _cachedAgentProfiles = fallback
    _cachedConfigSource = null
    _cachedConfigMtime = null
    return _cachedAgentProfiles
  }

  // Deep merge: minimal safety-net fallback as base, external config overrides
  // explicit fields. guard-config.json is the single source of truth for the
  // full policy; the fallback only fills gaps for fields the external config
  // omits (it defines no policy itself — M2 2026-09-10).
  for (const agentKey of Object.keys(fallback)) {
    if (external.profiles[agentKey]) {
      deepMerge(fallback[agentKey], external.profiles[agentKey])
    }
  }
  // Add any agents present only in external config
  for (const agentKey of Object.keys(external.profiles)) {
    if (!fallback[agentKey]) {
      fallback[agentKey] = external.profiles[agentKey]
    }
  }

  runtimeLog(`Guard config loaded from: ${external.source} (merge with fallback)`)
  _cachedAgentProfiles = fallback
  _cachedConfigSource = external.source
  try {
    _cachedConfigMtime = existsSync(external.source) ? statSync(external.source).mtimeMs : null
  } catch {
    _cachedConfigMtime = null
  }
  return _cachedAgentProfiles
}

function runtimeLog(message) {
  try {
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' })
    appendFileSync(runtimeLogPath, `[${timestamp}] ${message}\n`, 'utf8')
  } catch (e) {
    // Diagnostic logging must never affect the guard.
  }
}

// Cap the runtime log at plugin load: if it exceeds 1MB, truncate it to 1MB.
// Diagnostic hygiene only — a failure here must never break the guard.
try {
  const RUNTIME_LOG_CAP_BYTES = 1024 * 1024
  if (existsSync(runtimeLogPath) && statSync(runtimeLogPath).size > RUNTIME_LOG_CAP_BYTES) {
    truncateSync(runtimeLogPath, RUNTIME_LOG_CAP_BYTES)
  }
} catch (e) {
  // Silently fail: log capping must never affect the guard.
}

runtimeLog('DelegationGuard module loaded')

/**
 * Detects whether the lastAgent/targetAgent combination is a legitimate verifier ↔ executor cycle.
 * Used in both anti-loop (checkDelegationLoop) and the task handler sub-delegation gate.
 * @param {string} lastAgent
 * @param {string} targetAgent
 * @returns {boolean}
 */
function isVerificationCycleCall(lastAgent, targetAgent) {
  return (lastAgent === 'verifier' && targetAgent === 'executor') ||
         (lastAgent === 'executor' && targetAgent === 'verifier');
}

/**
 * @typedef {import('@opencode-ai/plugin').Plugin} Plugin
 *
 * Guard architecture (modularized):
 *  - tool.execute.before → single dispatcher, routes on input.tool
 *    ├── input.tool === "task"        → 6 inline delegation checks + check 9
 *    ├── input.tool === "bash"        → checkBashWhitelist()
 *    ├── input.tool === "webfetch"    → checkWebfetch()
 *    ├── input.tool === "edit"        → checkEditPath()
 *    └── input.tool === "write"       → checkWritePath()
 *  - event → session.created (init state), session.idle (placeholder)
 *
 * NOTE: OpenCode natively exposes only `tool.execute.before` as a hook for
 * all tools. Tool dispatching happens internally on `input.tool`.
 * Tests execute the individual check functions (named exports) without going through
 * the Plugin wrapper.
 */

// ============================================
// CONSTANTS AND UTILITIES (top-level for testability)
// ============================================

/** Max sessions to keep in memory to prevent growth without bound (Capability F) */
const MAX_SESSIONS = 100

/**
 * Tools that the Orchestrator can NEVER use directly, regardless of phase
 * or identity — must always delegate. Single shared source from check 2.5 (absolute
 * block) and check 5 (pre-delegation phase, line ~1138): previously there were two lists
 * separate (a fixed allowlist in check 5) — a dynamic MCP tool not
 * listed in either (e.g. `supabase_apply_migration`, or any
 * `mcp__*`) was blocked in pre-delegation even if legitimate, because
 * the allowlist could not know every configurable MCP tool in advance.
 * @type {string[]}
 */
const FORBIDDEN_ORCHESTRATOR_TOOLS = ['glob', 'grep', 'sequential-thinking_sequentialthinking', 'bash', 'edit', 'write']

/**
 * Native OpenCode tools (not MCP) that the dispatcher recognizes or that are
 * part of the base set regardless of the configured MCP server.
 * Used ONLY for observability 2.4 (logging of unknown MCP tools) — not a
 * security boundary, can remain imprecise without creating a bypass.
 * @type {Set<string>}
 */
const KNOWN_NATIVE_TOOLS = new Set([
  'read', 'grep', 'glob', 'ls', 'cat', 'find',
  'bash', 'edit', 'write', 'rm',
  'webfetch', 'websearch',
  'task', 'skill', 'question', 'invalid',
  'todowrite', 'todoread', 'sequential-thinking_sequentialthinking'
])

/**
 * Returns an ISO 8601 timestamp in local time (e.g. YYYY-MM-DDTHH:mm:ss.sss+HH:MM)
 * @returns {string}
 */
function getLocalTimestamp() {
  const d = new Date()
  const pad = (/** @type {number} */ n, /** @type {number} */ l = 2) => n.toString().padStart(l, '0')
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const offsetStr = sign + pad(Math.floor(Math.abs(offset) / 60)) + ':' + pad(Math.abs(offset) % 60)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${offsetStr}`
}

/** @type {{regex: RegExp, message: string}[]} */
const dangerousPatterns = [
  { regex: /git\s+add\s+-f/i, message: "❌ SECURITY: git add -f is not permitted." },
  { regex: /rm\s+-rf/i, message: "❌ SECURITY: rm -rf is not permitted." },
  { regex: /git\s+push.*--force/i, message: "❌ SECURITY: git push --force is not permitted." }
]

/** @type {RegExp[]} */
// System destructive patterns: del/rmdir/rd with /S /Q flags (recursive+quiet)
// Finding #5: extracted into array to cover variants (C:, C:\, C:\*, Unix path)
const destructiveSystemPatterns = [
  /^(format|diskpart)\b/i,                                  // format / diskpart
  /del\s+\/s\s+\/q\s+[a-zA-Z]:\\?(\*)?$/i,                 // del /S /Q C:, del /S /Q C:\, del /S /Q C:\*
  /del\s+\/s\s+\/q\s+\//i,                                  // del /S /Q su path Unix
  /rmdir\s+\/s\s+\/q\s+[a-zA-Z]:/i,                         // rmdir /S /Q C:
  /rd\s+\/s\s+\/q\s+[a-zA-Z]:/i                             // rd /S /Q C:
]

/**
 * Patterns to detect bash commands that MUTATE files (write/modify/delete),
 * used to block agents with bashAllowlist:["*"] but who by role should not
 * ever modify code (e.g. verifier). The `bash` tool does not go through checkNeverDo/
 * checkRouting (those only look at the delegation prompt text), so without
 * this check a "read-only" agent could bypass the fix ban by executing
 * PowerShell/Python/sed directly instead of using edit/write (tool that anyway
 * it does not possess).
 * @type {RegExp[]}
 */
const shellMutationPatterns = [
  // PowerShell — write/modify/delete file
  /\bSet-Content\b/i,
  /\bAdd-Content\b/i,
  /\bOut-File\b/i,
  /\bClear-Content\b/i,
  /\bRemove-Item\b/i,
  /\bRename-Item\b/i,
  /\bMove-Item\b/i,
  /\bNew-Item\b.*-ItemType\s+File/i,
  // Direct .NET — bypasses the named PowerShell cmdlets above (Set-Content,
  // etc.) by calling the .NET File/Directory APIs directly. Real incident
  // 2026-08-14: "debugger" (readOnlyDespiteFullBash) wrote a file via
  // [System.IO.File]::WriteAllText() — no pattern covered it, the command
  // passed as if read-only. Covers both the full type and
  // the short accelerator ([IO.File] / [IO.Directory]).
  /\[(?:System\.IO\.|IO\.)?File\]::(WriteAllText|WriteAllLines|WriteAllBytes|AppendAllText|AppendAllLines|Copy|Move|Delete|Replace|Encrypt)\s*\(/i,
  /\[(?:System\.IO\.|IO\.)?Directory\]::(CreateDirectory|Delete|Move)\s*\(/i,
  // NOTE: removed the generic redirection pattern (>/>>). Too many false positives
  // too frequent: any Python/JS script parsing HTML/XML
  // with regex contains `>` for reasons unrelated to shell (e.g. `[^>]*>` to
  // match tag closure). The named patterns below (Set-Content,
  // Add-Content, Out-File, open(...,'w'), .write(), sed -i, fs.writeFileSync)
  // cover the real exploit with precision, without this collateral cost.
  // Python — file writing
  /open\(\s*['"][^'"]*['"]\s*,\s*['"][waWA]/,
  /\.write\(/,
  /\.writelines\(/,
  // Node — file writing
  /fs\.writeFileSync/,
  /fs\.appendFileSync/,
  /fs\.unlinkSync/,
  /fs\.rmSync/,
  // Unix — modify/delete in-place
  /\bsed\s+-i\b/,
  /\btee\b/,
  /^\s*rm\s/,
  /^\s*del\s/i,
]

/**
 * Temporary/scratch folder markers. Used to exempt from the block
 * "shell mutation" for readOnlyDespiteFullBash agents when they write ONLY
 * in a temp folder (e.g. support scripts for their own analysis),
 * not in the project under review. The verifier still has full bash,
 * so writing a temp file gives it no additional power it doesn't already have —
 * it just avoids having to package everything into an uncomfortable one-liner.
 * @type {RegExp[]}
 */
const tempDirMarkers = [
  /AppData\\Local\\Temp/i,
  /\/tmp\//,
  /\$env:TEMP\b/i,
  /os\.tmpdir\(\)/,
  /\btempfile\./,
]

/**
 * Patterns to detect bash commands that EXECUTE test suites. Used to
 * block direct test execution by agents that should not
 * validate their own work (executor) — the entire executor→verifier flow
 * exists precisely so validation is done by someone else, not by the one
 * who just wrote the code. Without this check, executor (bashAllowlist:
 * ["*"]) could run npm test/pytest/jest etc. and "self-certify".
 * Does not block verifier/debugger/spiker: they have legitimate reasons (validation,
 * reproduction of a failure for diagnosis, isolated prototyping).
 * @type {RegExp[]}
 */
const testExecutionPatterns = [
  /\bnpm\s+test\b/i,
  /\bnpm\s+run\s+test\w*/i,
  /\byarn\s+test\b/i,
  /\bpnpm\s+test\b/i,
  /\bpython3?\s+-m\s+pytest\b/i,
  /\bpython3?\s+-m\s+unittest\b/i,
  /\bnpx\s+jest\b/i,
  /\bnpx\s+mocha\b/i,
  /\bgo\s+test\b/i,
  /\bdotnet\s+test\b/i,
  /\bcargo\s+test\b/i,
  // FIX (2026-08-25): jest/mocha/pytest/rspec/phpunit were "naked" patterns
  // (\bTOOL\b) — matched the tool name anywhere in the string, including
  // inside a file name (jest.setup.js, pytest.ini, phpunit.xml, mocha.opts
  // are real and common file names). Real incident: `git add ... jest.setup.js`
  // blocked as if it were a test execution. Requires command position
  // (beginning of string or after &&/;/|), but a `|` WITHOUT a space before the tool is almost
  // always a regex alternation inside a quoted string, not a real pipe
  // of shell — second real incident: `Select-String -Pattern "...|jest|..."`
  // (text search for the word "jest", not an execution) blocked for the same
  // same reason. Now the operator must be followed by AT LEAST one space
  // before the tool name — a regex alternation in quotes never has
  // spaces around `|` (would break the pattern meaning), a real invocation
  // re after &&/;/| almost always does.
  /(?:^\s*|(?:&&|;|\|)\s+)jest\b/i,
  /(?:^\s*|(?:&&|;|\|)\s+)mocha\b/i,
  /(?:^\s*|(?:&&|;|\|)\s+)pytest\b/i,
  /(?:^\s*|(?:&&|;|\|)\s+)rspec\b/i,
  /(?:^\s*|(?:&&|;|\|)\s+)phpunit\b/i,
]

/** @type {{regex: RegExp, message: string}[]} */
const sshLocalPatterns = [
  { regex: /ssh.*(?:localhost|127\.0\.0\.1|locale)/i, message: "❌ SSH: Local command does not require SSH." },
  { regex: /(?:git|npm|yarn|pnpm|bun)\s+(?:pull|push|status|add|commit|diff).*ssh/i, message: "❌ SSH: Git/npm local commands do not use SSH." }
]

/**
 * Pattern for check A (anti-exfiltration of secrets).
 * Scanned in the output of every tool executed by a non-trusted subagent.
 * Severity: critical | high | medium
 *
 * NOTE: regexes with /g flag are stateful, they must be recreated or reset
 * (String.match is used, which does not have the lastIndex issue).
 *
 * @type {{name: string, regex: RegExp, severity: 'critical'|'high'|'medium'}[]}
 */
const SECRET_PATTERNS = [
  // GitHub PAT: ghp_ + at least 30 alphanumeric characters (real format: ghp_ + 36, but we accept 30+ for robustness)
  { name: 'GitHub PAT', regex: /ghp_[a-zA-Z0-9]{30,}/g, severity: 'critical' },
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g, severity: 'critical' },
  { name: 'Private Key (RSA/EC/OPENSSH)', regex: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, severity: 'critical' },
  { name: 'URL with credentials', regex: /https?:\/\/[^\s/:]+:[^\s@]+@[^\s/]+/g, severity: 'high' },
  { name: 'Bearer token', regex: /Bearer\s+[a-zA-Z0-9_\-\.]{20,}/g, severity: 'high' },
  { name: 'Modal API key', regex: /modalresearch_[a-zA-Z0-9_\-]{20,}/g, severity: 'high' },
  { name: 'Supabase token', regex: /sbp_[a-zA-Z0-9]{40,}/g, severity: 'high' },
  { name: 'Generic API key in JSON', regex: /"(apiKey|api_key|password|secret|token)"\s*:\s*"[a-zA-Z0-9_\-]{16,}"/g, severity: 'medium' },
  { name: 'JWT token', regex: /eyJ[a-zA-Z0-9_\-]+\.eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+/g, severity: 'high' },
  { name: 'Generic private key path', regex: /\.ssh\/id_[a-zA-Z0-9]+/g, severity: 'medium' },
  // Added 2026-08-15 — reported missing coverage: OpenAI, Slack, Google.
  // Length thresholds chosen to avoid false positives on common words/identifiers
  // common that start with the same prefix (e.g. "sk-" alone is too short,
  // requires 32+ characters like a real classic OpenAI key of 48).
  { name: 'OpenAI API key', regex: /sk-[a-zA-Z0-9]{32,}/g, severity: 'critical' },
  { name: 'Slack token', regex: /xox[baprs]-[a-zA-Z0-9-]{10,}/g, severity: 'critical' },
  { name: 'Google API key', regex: /AIza[0-9A-Za-z_\-]{35}/g, severity: 'critical' }
]

/**
 * Log/lesson files auto-written by the Guard or the orchestrator.
 * Contain TEXTUAL mentions of sensitive paths as historical examples
 * (e.g. "File: .ssh folder, key id_rsa, Pattern: ssh_keys" in a past block log),
 * not real secrets. Excluded from checkSecretsInOutput to avoid false positives
 * when an agent reads them (bug 08-08: lessons.md written twice for
 * "Generic private key path" despite containing no actual key).
 * @type {string[]}
 */
const SECRET_SCAN_EXCLUDED_FILES = [
  'lessons.md',
  'delegation-guard-runtime.log',
  'guard-debug.jsonl',
  'guard-init.log',
  'incidents.md',
  // Guard's own source file (bug 2026-08-15): delegation-guard.js contains
  // TEXTUAL EXAMPLES of sensitive paths/patterns in its own comments/JSDoc (to
  // document what the patterns detect) — those examples match the patterns they
  // describe, causing the entire file to be redacted when an agent reads it
  // for diagnosis/review. Plugin-specific names, not generic (no
  // "readme.md": in any project a real README could contain a
  // real secret and should not be auto-excluded).
  'delegation-guard.js',
  'guard-config.json',
  'test-harness2.mjs'
]

function isSecretScanExcluded(filePath) {
  if (!filePath || typeof filePath !== 'string') return false
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  return SECRET_SCAN_EXCLUDED_FILES.some(name => normalized === name || normalized.endsWith('/' + name))
}

/**
 * Patterns for check C (sensitive file access).
 * Blocks read/grep/glob on files containing credentials.
 *
 * @type {{name: string, regex: RegExp, severity: 'critical'|'high'|'medium'}[]}
 */
const SENSITIVE_FILE_PATTERNS = [
  // Matches: .env, .env.local, .env.development, test.env, production.env, config.env, etc.
  // FIX (2026-08-25): excluded conventional placeholder suffixes without real secrets
  // (.env.example, .env.sample, .env.template, .env.dist, .env.defaults) —
  // reported by the user: they blocked normal reading/modification of files that
  // only document WHICH variables exist, never real values. Other suffixes
  // (.env.local, .env.production, etc.) remain blocked — they could contain
  // real values.
  { name: 'env_files', regex: /(^|\/|\\)\.env(?!\.(example|sample|template|dist|defaults)$)(\.[a-zA-Z0-9_-]+)?$|\.env$/i, severity: 'critical' },
  { name: 'ssh_keys', regex: /(^|\/|\\)\.ssh[\/\\]id_[a-zA-Z0-9_-]+$/, severity: 'critical' },
  // FIX (2026-08-15): the pattern above requires the ".ssh/" prefix — a command
  // that builds the path in pieces (e.g. PowerShell Join-Path, or a token
  // separated in a glob) can reference the file by bare name ("id_rsa") without
  // ever producing a contiguous ".ssh/id_rsa" token. Explicit whitelist of names
  // OpenSSH standard (not a generic "id_*" — "id_token" alone is a common
  // OIDC/OAuth term, blocking it would cause constant false positives).
  { name: 'ssh_key_bare_filename', regex: /(^|\/|\\)id_(rsa|dsa|ecdsa|ed25519(_sk)?|xmss)(\.pub)?([\/\\]|$)/i, severity: 'critical' },
  { name: 'ssh_private_key_path', regex: /(^|\/|\\)\.ssh[\/\\][^\/\\]+\.pem$/, severity: 'critical' },
  { name: 'aws_credentials', regex: /(^|\/|\\)\.aws[\/\\](credentials|config)$/i, severity: 'critical' },
  { name: 'gcp_credentials', regex: /(^|\/|\\)\.gcp[\/\\](credentials|application_default_credentials\.json)$/i, severity: 'critical' },
  { name: 'azure_credentials', regex: /(^|\/|\\)\.azure[\/\\][^\/\\]*credentials/i, severity: 'critical' },
  // FIX (2026-08-15): required a separator AFTER "secrets|credentials|private"
  // (folder use only) — a bare file named exactly "credentials",
  // "secrets" or "credentials.json" (no parent folder in path/pattern
  // glob) was never captured. Now matches at end of string or with
  // an extension, staying anchored to a path boundary before the name
  // (no partial match like "credentialsfile.txt" or "secretsauce.js").
  // NOTE: "private" as a folder name is common in third-party code not
  // related to secrets (e.g. React Native ships node_modules/react-native/src/private/,
  // real incident 2026-08-25) — see isNodeModulesPath() below, applied by the
  // two checks that consume this pattern to exclude node_modules/.
  { name: 'secrets_directory', regex: /(^|\/|\\)(secrets|credentials|private)(\.[a-zA-Z0-9]+)?([\/\\]|$)/i, severity: 'high' },
  { name: 'pem_certificates', regex: /\.(pem|key|p12|pfx|jks)$/i, severity: 'high' },
  { name: 'netrc', regex: /(^|\/|\\)\.netrc$/i, severity: 'high' },
  { name: 'git_credentials', regex: /(^|\/|\\)\.git-credentials$/i, severity: 'high' },
  { name: 'npmrc_with_auth', regex: /(^|\/|\\)\.npmrc$/i, severity: 'medium' },
  { name: 'docker_config', regex: /(^|\/|\\)\.docker[\/\\]config\.json$/i, severity: 'high' }
]

/**
 * true if the path (already normalized to forward-slash) traverses node_modules/.
 * Used ONLY to exclude the "secrets_directory" pattern — "private" in
 * particular is a common folder name in third-party code without
 * anything to do with secrets (e.g. node_modules/react-native/src/private/,
 * real incident 2026-08-25); node_modules is installed dependency code,
 * never the user's secrets.
 * @param {string} normalized
 * @returns {boolean}
 */
function isNodeModulesPath(normalized) {
  return /(^|\/)node_modules\//i.test(normalized)
}


/** @type {Record<string, {requiresAnyOf: string[], exceptions: string[], errorMessage: string}>} */
const workflowRules = {
  "executor": {
    requiresAnyOf: ["diagnosis", "debug", "analysis", "root cause"],
    exceptions: [
      "approved fix", "fix plan", "post-diagnosis", "after debug",
      "diagnosis complete", "after explorer",
      // References to real diagnostic output files — not generic phrases
      "error.txt", "errors.txt", "tsc output", "tsc error",
      "lint output", "lint error", "build output", "build error",
      "attached diagnosis", "diagnosis attached",
      // Routine operations — do not require diagnosis
      "ota", "update", "deploy", "publish", "release", "commit", "push"
    ],
    errorMessage: "❌ WORKFLOW: Fix requires diagnosis first. Run debugger or explorer."
  }
}

/**
 * Extracts the task delegation target agent from the hook arguments.
 * VER-LOW-02 (2026-09-11): the arming block read both sources
 * (output?.args?.subagent_type || input.args?.subagent_type) while the task
 * handler read ONLY output.args — a delegation carrying subagent_type in
 * input.args alone armed the identity bridge and then hit the handler's
 * early return with NO validation and NO rollback (TTL-bounded residue in
 * pendingAgentTypes + currentActiveAgent). Single shared extractor: both
 * sites now resolve the SAME value, so a delegation is either validated
 * and rolled back on failure, or never armed at all (both sources absent).
 * @param {object} input - hook input ({ tool, sessionID, callID, args? })
 * @param {object} output - hook output ({ args? })
 * @returns {string|undefined} the subagent_type, if any
 */
function extractTargetAgent(input, output) {
  return output?.args?.subagent_type || input?.args?.subagent_type;
}

/**
 * Detects whether the task concerns writing/updating documentation.
 * @param {string} fullText - The full prompt
 * @returns {boolean} true if the task is documentation
 */
function isDocumentationTask(text) {
  if (!text || typeof text !== 'string') return false
  const writeVerbs = /(?:replace|update|write|create|modify|edit|generate|rename|overwrite)/i
  if (!writeVerbs.test(text)) return false
  // Check 1: if the task modifies code (.py, .js, .ts, .java, .cs, etc.) → not doc
  const codeFilePattern = /[\w\-./\\:]+\.(?:py|js|ts|java|cs|cpp|c|go|rs|rb|php|swift|kt|scala|ex|exs|spec|r|m|mm|pl|pm|lua|hs|sh|bash|zsh|ps1|bat|cmd|yaml|yml|json|xml|ini|cfg|toml|env|css|scss|html|htm|vue|svelte|jsx|tsx)\b/i
  if (codeFilePattern.test(text)) return false
  // Check 1b: config dotfile without extension (.gitignore, .env, etc.) → not doc.
  // Bug 08-05: task "remove X from .gitignore" also mentioned "CLAUDE.md" as
  // textual reference (not the file to edit) → matched Check 2 and redirected
  // erroneously to doc-writer. A config dotfile in the text wins over a .md/.txt mention.
  const configDotfilePattern = /(?:^|[\s"'`/\\])\.(?:gitignore|dockerignore|eslintrc(?:\.\w+)?|prettierrc(?:\.\w+)?|editorconfig|npmrc|env(?:\.\w+)?|nvmrc|browserslistrc|babelrc|stylelintrc|huskyrc)\b/i
  if (configDotfilePattern.test(text)) return false
  // Check 2: only if not code/config, verify if it's writing doc
  const docFilePattern = /[\w\-./\\:]+\.(?:md|txt)\b/i
  return docFilePattern.test(text)
}

/** @type {(agent: string, profile: any, fullText: string, allProfiles: any) => void} */
function checkDelegationRules(agent, profile, fullText, allProfiles) {
  if (!profile) {
    throw new Error(`❌ GUARD: profile not found for agent "${agent}". Delegation/routing invalid.`)
  }
  if (!profile.delegation_rules) {
    throw new Error(`❌ GUARD: delegation_rules missing for "${agent}". Corrupted configuration.`)
  }

  // Extracts task_domain from fullText: "domain:<name>" or "task_domain:<name>"
  const domainMatch = fullText.match(/\b(?:domain|task_domain)\s*:\s*([a-z_]+)/i)
  if (!domainMatch) {
    throw new Error(
      `❌ ROUTING: Undeclared task domain. Use "domain:<name>" in the description. ` +
      `Examples: "domain:implementation", "domain:verification", "domain:testing".`
    )
  }

  // Aliases for common variants/abbreviations the model uses spontaneously
  // but that don't match the canonical domain name. Add here
  // when new mismatches emerge, instead of forcing the model to remember
  // the exact name.
  const domainAliases = {
    'architecture': 'architecture_analysis',
    'security': 'security_audit',
  }
  const rawDomain = domainMatch[1].toLowerCase()
  const declaredDomain = domainAliases[rawDomain] || rawDomain

  const rules = profile.delegation_rules

  // M2/REV-03 (2026-09-10): wildcard support — can_handle_directly ['*'] means
  // "any domain directly". Used by the minimal safety-net fallback so a
  // missing guard-config.json does not brick all delegations (fail-operational
  // for routing; every mutative permission stays fail-closed). No agent in
  // guard-config.json uses '*', so config-driven behavior is unchanged.
  if (Array.isArray(rules.can_handle_directly) && rules.can_handle_directly.includes('*')) {
    return
  }

  // If the agent can handle this domain directly → OK
  if (Array.isArray(rules.can_handle_directly) && rules.can_handle_directly.includes(declaredDomain)) {
    return
  }

  // If the agent must delegate for this domain → BLOCK with suggestion
  if (rules.must_delegate_to && rules.must_delegate_to[declaredDomain]) {
    const correctAgent = rules.must_delegate_to[declaredDomain]
    throw new Error(
      `❌ ROUTING: Domain "${declaredDomain}" requires ${correctAgent}, not ${agent}.\n` +
      `→ Add "domain:${declaredDomain}" and delegate to ${correctAgent}.`
    )
  }

  // Unrecognized domain for THIS agent — but it could be valid
  // for another (e.g. "review" is a native domain of verifier, not of
  // code-reviewer, which instead uses "code_review"). Distinguish the two cases
  // avoid showing a misleading global list that looks like "it is fine"
  // when in reality that domain is never valid for the current agent.
  const allDomains = new Set()
  const domainOwners = {}
  for (const [agentName, p] of Object.entries(allProfiles)) {
    if (p.delegation_rules) {
      if (p.delegation_rules.can_handle_directly) {
        p.delegation_rules.can_handle_directly.forEach(d => {
          allDomains.add(d)
          if (!domainOwners[d]) domainOwners[d] = []
          domainOwners[d].push(agentName)
        })
      }
      if (p.delegation_rules.must_delegate_to) Object.keys(p.delegation_rules.must_delegate_to).forEach(d => allDomains.add(d))
    }
  }

  if (domainOwners[declaredDomain]) {
    const owners = domainOwners[declaredDomain].join(', ')
    const ownDomains = [
      ...(rules.can_handle_directly || []),
      ...Object.keys(rules.must_delegate_to || {})
    ]
    throw new Error(
      `❌ ROUTING: Domain "${declaredDomain}" exists but is managed by ${owners}, not by ${agent}.\n` +
      `→ Valid domains for ${agent}: ${Array.from(new Set(ownDomains)).sort().join(', ')}`
    )
  }

  throw new Error(
    `❌ ROUTING: Domain "${declaredDomain}" unrecognized. ` +
    `Valid domains: ${Array.from(allDomains).sort().join(', ')}`
  )
}

function checkDelegationRulesWithRetry(agent, profile, fullText, allProfiles, state) {
  const domainMatch = fullText.match(/\b(?:domain|task_domain)\s*:\s*([a-z_]+)/i)
  const domain = domainMatch ? domainMatch[1].toLowerCase() : null
  if (!state.taskRetries) { state.taskRetries = {} }
  const retryKey = domain ? `${agent}:${domain}` : agent
  try {
    checkDelegationRules(agent, profile, fullText, allProfiles)
    delete state.taskRetries[retryKey]
  } catch (error) {
    state.taskRetries[retryKey] = (state.taskRetries[retryKey] || 0) + 1
    const retryCount = state.taskRetries[retryKey]
    if (retryCount > 3) {
      throw new Error(
        `ESCALATION: Max 3 attempts for "${agent}" (domain: ${domain || 'unknown'}). Cause: ${error.message} Manual intervention required.`
      )
    }
    throw new Error(`${error.message} RETRY: ${retryCount}/3 for ${agent} on "${domain || 'unknown'}".`)
  }
}

/** @type {(k: string) => RegExp} */
function makeFuzzyRegex(k) {
  if (k.includes(' ')) {
    return new RegExp(k.split(/\s+/).join('(?:\\s+\\w+){0,2}\\s+'), 'i')
  }
  return new RegExp(`\\b${k}\\b`, 'i')
}

/** @type {(forbidden: string, allowMentions: string[], fullText: string) => boolean} */
function isAllowedMention(forbidden, allowMentions, fullText) {
  if (!allowMentions.length) return false
  const lowerForbidden = forbidden.toLowerCase()
  const text = fullText.toLowerCase()
  const matchedAllowed = allowMentions.find(a => lowerForbidden.includes(a.toLowerCase()))
  if (!matchedAllowed) return false

  const analyticalVerbs = [
    // English — analysis and validation
    "propose", "identify", "analyze", "find", "search", "explain",
    "describe", "report", "mention", "discuss", "evaluate", "examine",
    "indicate", "suggest", "illustrate", "diagnosed", "found", "identified",
    "verify", "validate", "check", "confirm", "apply", "execute",
    // English — extended analysis and validation
    "analyze", "identify", "find", "describe", "report", "discuss",
    "evaluate", "examine", "suggest", "validate", "verify", "check",
    "review", "confirm", "apply", "execute", "run", "test", "inspect"
  ]

  const pos = text.indexOf(matchedAllowed.toLowerCase())
  if (pos === -1) return false

  const window = text.slice(Math.max(0, pos - 60), Math.min(text.length, pos + matchedAllowed.length + 60))
  return analyticalVerbs.some(v => new RegExp(`\\b${v}\\b`).test(window))
}

// ============================================
// ANTI-LOOP LOGIC (Pure Function)
// ============================================

/**
 * Checks if delegation to a targetAgent would create an infinite loop.
 * 
 * Rules:
 * 1. Self-loop: If the last element of the stack equals the target -> BLOCKS.
 * 2. Ping-pong: If the last 2 elements are [A, B] and the target is A -> BLOCKS.
 * 3. Saturation: If the same agent appears >= 3 times in the last 5 steps -> BLOCK.
 * 4. Depth: If currentStack.length >= 5 -> BLOCKS.
 * 
 * @param {string[]} currentStack - The current delegation stack (chronological order)
 * @param {string} targetAgent - The agent to delegate to
 * @returns {boolean} true if the delegation is allowed
 * @throws {Error} if a loop is detected
 */
function checkDelegationLoop(currentStack, targetAgent) {
  if (!Array.isArray(currentStack)) {
    throw new Error('Invalid stack: currentStack must be an array');
  }
  if (!targetAgent) {
    throw new Error('Invalid target: targetAgent is required');
  }

  // Rule 4: Depth (Max Depth)
  if (currentStack.length >= 5) {
    throw new Error('Delegation loop: maximum delegation depth reached (5)');
  }

  const last = currentStack[currentStack.length - 1];
  const secondLast = currentStack[currentStack.length - 2];

  // 🆕 Exception for iterative verifier↔executor workflow:
  // Iterations between verifier and executor are legitimate (fix after verification),
  // not a loop. Logic is centralized in isVerificationCycleCall().
  if (isVerificationCycleCall(last, targetAgent)) {
    return true;   // legitimate iteration, not a loop
  }

  // Rule 1: Self-loop (A -> A)
  if (last === targetAgent) {
    throw new Error(`Delegation loop: self-loop detected (${targetAgent} -> ${targetAgent})`);
  }

  // Rule 2: Ping-pong (repeated A <-> B oscillation)
  // Blocks ONLY the repeated 2-cycle (e.g. executor -> tester -> executor -> tester),
  // NOT a single legitimate iteration (e.g. executor -> tester -> executor, where
  // tester does distinct work). A 2-cycle forms when the last 4 steps
  // are [X, A, X, A]: the last agent and the one 2 positions back match (X)
  // and the target matches the agent 1 position back (A).
  //
  // Exception: The legitimate alternating cycle executor <-> verifier (e.g. fix -> verify -> fix -> verify)
  // should not be blocked as ping-pong, but only controlled by the depth/saturation limit.
  const isVerificationCycle = isVerificationCycleCall(last, targetAgent);
  if (!isVerificationCycle &&
      currentStack.length >= 3 &&
      last === currentStack[currentStack.length - 3] &&
      targetAgent === secondLast) {
    throw new Error(`Delegation loop: ping-pong detected (${targetAgent} <-> ${last})`);
  }

  // Rule 3: Saturation (backstop)
  // With a depth limit of 5 and the 2-cycle ping-pong above, an agent can appear
  // at most 3 times distributed (e.g. A -> B -> A -> C -> A) without being
  // a loop: that is a legitimate iterative flow and should NOT be blocked. The threshold is
  // therefore 4 (not 3), so the rule remains a backstop catching only cases
  // pathological (made unreachable by the depth limit without tighter loops).
  const lastFive = currentStack.slice(-5);
  const counts = {}
  for (const agent of lastFive) {
    counts[agent] = (counts[agent] || 0) + 1
    if (counts[agent] >= 4) {
      throw new Error(`Delegation loop: saturation detected (${agent} appears 4+ times in last 5 steps)`);
    }
  }

  return true;
}

// ============================================
// PLUGIN DELEGATION GUARD
// ============================================
/** @type {Plugin} */
export const DelegationGuard = async ({ project, client, $, directory, worktree }) => {
  _projectDirectory = directory || '';
  _worktree = worktree || '';
  try {
    runtimeLog(`DelegationGuard factory called: project=${project ? 'yes' : 'no'}, client=${client ? 'yes' : 'no'}, directory=${directory || ''}, worktree=${worktree || ''}`)
  // INIT LOG: Confirm the plugin is loaded
  const initLogPath = path.join(__dirname, '.planning', 'guard-init.log')
  try {
    if (!existsSync(path.dirname(initLogPath))) {
      mkdirSync(path.dirname(initLogPath), { recursive: true })
    }
    const timeStr = getLocalTimestamp()
    const projInfo = project ? (project.id || `no-id, keys: ${Object.keys(project).join(', ')}`) : 'undefined'
    appendFileSync(initLogPath, `[${timeStr}] DelegationGuard LOADED for project: ${projInfo}\n`, 'utf8')
  } catch (e) {
    runtimeLog(`guard-init.log write failed: ${e.message}`)
  }

  // ============================================
  // SESSION STATE — In-memory storage (local to the plugin)
  // ============================================
  // NOTE: These data are now local to the plugin closure instead of global.
  // Pattern aligned with OpenCode (Effect Context/Service). Avoids pollution of the
  // global scope and conflicts between plugin instances.

  const sessionState = new Map();
  const subagentRegistry = new Map(); // child sessionID -> agent
  const pendingAgentTypes = new Map(); // agentType -> delegation timestamp

  // Pending agent types: delegated via task but not yet "crystallized"
  // (i.e. their subagent hasn't yet made its first tool call). While one type
  // remains pending, currentActiveAgent is ambiguous for that type.
  // If the Orchestrator delegates a DIFFERENT type while a previous one is still
  // pending, the documented race condition (both crystallize with
  // the last value) is concrete — we block to force serialization.
  // Same-type (Swarm Mode) remains allowed: the Map uses the agent name as
  // key, so multiple parallel executors do not count as a conflict.
  const PENDING_TTL_MS = 15000; // 15s: lowered from 60s (fix 2026-07-23) because an LLM outage left pending stuck uselessly

  // Identity bridge: BY DESIGN upstream, hook tool.execute.* does not expose
  // the agent field (packages/plugin/src/index.ts) — it is NOT a bug in
  // OpenCode. Identity is resolved via the sessionID→agent registry built
  // from the event session.created (empirically reliable: 6/6 child sessions
  // registered before their first tool call, 0ms race). Captured at task
  // delegation, used for crystallization on the subagent's first tool call.
  let currentActiveAgent = null;
  // REV-02 (2026-09-11): rootSessions tracks EVERY root session (orchestrator).
  // The legacy single slot below was overwritten unconditionally at every
  // session.created root and by any unregistered session calling task —
  // with two roots in the same plugin instance (e.g. TUI /new), the FIRST
  // lost orchestrator status: check 2.5 stopped covering it AND the
  // anti-crystallization guard stopped protecting it, so it crystallized the
  // bridge residue (e.g. executor after a successful delegation) gaining
  // permanent write/bash PASS-THROUGH with the delegated agent's profile.
  // Every root now joins the Set and keeps its status; the slot is kept
  // (set only if empty, never stolen) purely for the pre-existing consumers
  // that compare against it (LRU skip, anti-crystallization guard).
  const rootSessions = new Set();
  let orchestratorSessionID = null;
  let currentActiveAgentTimestamp = 0;  // timestamp of last set, 0 = never set
  // VER-LOW-01 (2026-09-11): callID of the task call that LAST CHANGED the
  // value of currentActiveAgent (null = no owner). The task-handler rollback
  // must not clobber the bridge of a legitimate sibling: under a same-type
  // swarm (executor×2) a blocked delegation matches the bare
  // `currentActiveAgent === targetAgent` check even though the bridge was
  // armed by a DIFFERENT (still in-flight) call — the ownership guard below
  // rolls back only the call that actually changed the value.
  let bridgeArmedByCallID = null;
  const CURRENT_ACTIVE_AGENT_TTL_MS = 300000; // 5 min: freshness window for currentActiveAgent (fix 2026-07-23)

  /**
   * Reads currentActiveAgent with freshness check.
   * If the last set is older than 5 minutes, returns null and auto-cleans.
   * Prevents cross-conversation identity leakage (fix 2026-07-20, recovered in the 07-23 refactoring).
   */
  function getCurrentActiveAgent() {
    if (!currentActiveAgent || currentActiveAgentTimestamp === 0) return null;
    if (Date.now() - currentActiveAgentTimestamp > CURRENT_ACTIVE_AGENT_TTL_MS) {
      pendingAgentTypes.delete(currentActiveAgent);
      currentActiveAgent = null;
      currentActiveAgentTimestamp = 0;
      bridgeArmedByCallID = null;  // owner reset with the value it armed (VER-LOW-01)
      return null;
    }
    return currentActiveAgent;
  }

  function cleanupStalePending() {
    const now = Date.now();
    for (const [agentType, ts] of pendingAgentTypes.entries()) {
      if (now - ts > PENDING_TTL_MS) pendingAgentTypes.delete(agentType);
    }
  }

  // NOTE: global delegation sequence intentionally removed. Each session keeps
  // its own delegationSequence in sessionState to avoid race conditions when
  // the Orchestrator spawns parallel subagents.

  // ============================================
  // AGENT PROFILES — resilient loading with cache
  // ============================================
  /**
   * @typedef {{
   *   role: string,
   *   keywords: string[],
   *   allowMentions: string[],
   *   neverDo: string[],
   *   canPreDelegate: boolean,
   *   bashAllowlist?: string[],
   *   canWebfetch?: boolean,
   *   canDelegateTo?: string[],
   *   writeScope?: 'all' | 'planning' | 'sketches' | 'spikes' | 'readme'
   * }} AgentProfile
   * @type {Record<string, AgentProfile>}
   */
  const agentProfiles = loadAgentProfiles(directory)

  // ============================================
  // HELPERS
  // ============================================
  /**
   * Standardizes the audit of security blocks.
   * @param {string} sessionID 
   * @param {string} agent 
   * @param {string} checkName
   * @param {Function} checkFn 
   * @param {Record<string, any>} [details] 
   */
  function auditedCheck(sessionID, agent, checkName, checkFn, details = {}) {
    try {
      checkFn();
    } catch (error) {
      runtimeLog(`blocked: sessionID=${sessionID}, agent=${agent || 'unknown'}, check=${checkName}, reason=${error.message}`)
      persistAuditEvent(sessionID, 'denied', agent || 'unknown', 'blocked', {
        check: checkName,
        error: error.message,
        ...details
      });
      // TUI notification — non-blocking, must never interrupt the throw
      try {
        client.tui.showToast({
          body: {
            message: `🛡️ GUARD [${checkName}] → ${agent || 'unknown'}: ${error.message.split('\n')[0]}`,
            variant: 'error'
          }
        })
      } catch (_) { /* TUI not available, silent */ }
      throw error;
    }
  }

  /**
   * Checks the session message history if Skill('conductor-rules')
   * has already been loaded in the past.
   *
   * Serves to cover the case in which the plugin process was restarted
   * (e.g. OpenCode close/reopen): the in-memory `sessionState` Map goes back to
   * empty, but if the resumed session has the same sessionID and the rules are already
   * in the history/context, the gate must not re-request its loading.
   * @param {string} sessionID
   * @returns {Promise<boolean>}
   */
  async function wasConductorRulesLoadedInHistory(sessionID) {
    try {
      const res = await client.session.messages({ path: { id: sessionID } });
      const messages = res?.data || [];
      for (const msg of messages) {
        for (const part of msg.parts || []) {
          if (part.type === 'tool' && part.tool === 'skill' && part.state?.input?.name === 'conductor-rules') {
            return true;
          }
        }
      }
    } catch (e) {
      runtimeLog(`wasConductorRulesLoadedInHistory failed: ${e.message}`);
    }
    return false;
  }

  // ============================================
  // MAIN HOOK — MODULAR DISPATCHER
  // ============================================
  // OpenCode natively exposes only `tool.execute.before` as a hook for all
  // tools. Tool dispatching happens here on `input.tool`.
  //
  // Convention for subagent_type (see CUSTOMIZE_OPENCODE_SKILL):
  //  - For tool "task": input.args.subagent_type (caller) + output.args.subagent_type (target)
  //  - For other tools: subagent_type recovered from input.args or the state Map
  //  - For tool "edit"/"write": filePath in output.args.filePath
  //  - For tool "bash": command in input.args.command (or output.args.command)
  //  - For tool "webfetch": url in input.args.url, prompt in input.args.prompt
  return {
    "tool.execute.before": async (input, output) => {
      const sessionID = input.sessionID || 'default';

      // 0. DEBUG LOGGING (opt-in: OPENCODE_GUARD_DEBUG=1)
      // Full-input logging is verbose and unbounded — gated behind an explicit
      // env flag. No test or check depends on this log.
      if (process.env.OPENCODE_GUARD_DEBUG === '1') {
        try {
          const debugLog = {
            timestamp: getLocalTimestamp(),
            tool: input.tool,
            sessionID: sessionID,
            input: input, // Logging all input to see if OpenCode changes anything
            outputArgs: output?.args
          };
          const debugPath = path.join(__dirname, 'delegation-guard', 'guard-debug.jsonl');
          if (!existsSync(path.dirname(debugPath))) mkdirSync(path.dirname(debugPath), { recursive: true });
          appendFileSync(debugPath, JSON.stringify(debugLog) + '\n', 'utf8');
        } catch (e) { /* Silently fail */ }
      }

      // 1. State Recovery (In-Memory Map)
      // FIX (2026-08-15): it was pure FIFO (evict in insertion order), not LRU —
      // with 100 accumulated sessions, the FIRST created would be evicted even if
      // the Orchestrator was still active (long session, few direct tool calls
      // because it delegates almost everything), losing conductorRulesLoaded/lastAgent
      // blocking the next delegation. Now: (a) every access re-inserts the
      // key at the end of the Map — insertion order becomes real LRU order,
      // so eviction hits the INACTIVE session for longest, not the oldest
      // old one; (b) the Orchestrator is NEVER evicted, regardless of its
      // — it's the only session whose state loss blocks the entire
      // delegation flow.
      let state = sessionState.get(sessionID);
      if (state) {
        sessionState.delete(sessionID);
        sessionState.set(sessionID, state);
      } else {
        if (sessionState.size >= MAX_SESSIONS) {
          let evicted = false;
          for (const key of sessionState.keys()) {
            // REV-02: never evict ANY root session (Set), not only the one
            // currently holding the legacy single slot.
            if (key === orchestratorSessionID || rootSessions.has(key)) continue;
            sessionState.delete(key);
            runtimeLog(`MAX_SESSIONS: evicted LRU session ${key}`);
            evicted = true;
            break;
          }
          if (!evicted) {
            // Only the Orchestrator in the Map (edge case) — no other session to evict.
            runtimeLog(`MAX_SESSIONS: no avoidable session (only Orchestrator present).`);
          }
        }
        state = createSessionState();
        sessionState.set(sessionID, state);
      }

      // 2. IDENTITY RESOLUTION (The Survival Hierarchy)
      // Priority:
      //   1. Subagent registry sessionID→agent (from event session.created) —
      //      PRIMARY: empirically reliable (6/6 runs), always arrives before
      //      the child's first tool call
      //   2. Persistence (state.lastAgent) — identity crystallization for the session
      //   3. currentActiveAgent (bridge fallback — agent field absent by design
      //      in tool.execute.*; covers --continue and event loss)
      //
      // NOTE: input.agent and args.subagent_type are NOT guaranteed fields from the API
      // official OpenCode (see packages/plugin/src/index.ts). If present, they are
      // a bonus, but we do not rely on them for identity resolution.
      const registryAgent = subagentRegistry.get(sessionID);
      const caller = registryAgent || state.lastAgent || getCurrentActiveAgent();
      const subagentType = caller;

      // Identity crystallization — NEVER on the Orchestrator session.
      // Previously there was no such guard: if the Orchestrator made a tool call
      // non-task (e.g. todowrite) after having set currentActiveAgent via a
      // previous delegation, this block could "crystallize" by mistake the
      // Orchestrator session with the identity of the last delegated target
      // — root cause of the Swarm Mode race condition of 2026-07-19 (see also
      // the removal of state.lastAgent writes in the task dispatcher).
      // REV-02: the guard covers EVERY root session (rootSessions Set), not
      // only the one currently holding the legacy single slot.
      if (!state.lastAgent && input.tool !== 'task' && !rootSessions.has(sessionID) && sessionID !== orchestratorSessionID) {
        const agentToLock = registryAgent || getCurrentActiveAgent();
        if (agentToLock) {
          state.lastAgent = agentToLock;
          sessionState.set(sessionID, state);
          runtimeLog(`[LOCK] sessionID=${sessionID} agent=${state.lastAgent} source=${registryAgent ? 'registry' : 'currentActive'}`);
          // The type is now resolved for this session — remove it from pending.
          // From here on this session uses state.lastAgent, not currentActiveAgent anymore.
          pendingAgentTypes.delete(agentToLock);
        }
      }

      // isOrchestrator: true if the current sessionID is a root session.
      // REV-02: EVERY root is an Orchestrator (rootSessions Set) — with a
      // single slot, the second root stole the status from the first. The
      // slot comparison stays as a fallback for roots created before the Set
      // existed (same-instance upgrades); the heuristic below covers the
      // very first tool call before any registration.
      const isOrchestrator = rootSessions.has(sessionID)
        ? true
        : (orchestratorSessionID
            ? (sessionID === orchestratorSessionID)
            : (!caller && !state.lastAgent));
      // Note: if there is no known agent, the actor is the Orchestrator or an unknown identity

      // 2.4. OBSERVABILITY OF UNKNOWN MCP TOOLS (2026-08-25)
      // FINDING: the dispatcher explicitly handles only the listed native tools
      // below — any MCP tool (dynamic name, e.g. "supabase_apply_migration",
      // "github_*", etc.) goes through NO permission check (bashAllowlist,
      // readOnlyDespiteFullBash, allowEdit, writeScope do not apply). A
      // "tester" agent (bashAllowlist: []) or "verifier"/"debugger"
      // (readOnlyDespiteFullBash: true) could directly call an MCP tool
      // destructive without any interception.
      // Explicit user decision (2026-08-25): logging only for now, no
      // blocking — real usage scope visibility needed before choosing
      // an enforcement policy (per-agent allowlist vs. inherited restriction
      // from bashAllowlist/readOnlyDespiteFullBash). NOT a security boundary:
      // the list below can remain imprecise without creating a bypass, it's only
      // a heuristic "looks like an OpenCode native tool or not".
      if (!KNOWN_NATIVE_TOOLS.has(input.tool)) {
        runtimeLog(`🔍 MCP TOOL OBSERVED (not enforced): tool="${input.tool}", sessionID=${sessionID}, agent=${subagentType || (isOrchestrator ? 'orchestrator' : 'unknown')}`);
        persistAuditEvent(sessionID, 'mcp_tool_usage', subagentType || (isOrchestrator ? 'orchestrator' : 'unknown'), 'observed', {
          tool: input.tool
        });
      }

      // 2.5. ABSOLUTE CHECK: The Orchestrator must not use tools directly
      if (isOrchestrator) {
        // FIX (2026-07-23): bash/edit/write were missing from this list. The Orchestrator
        // could execute them directly because no check blocked them here, and further down
        // permission was decided by subagentType — which for the Orchestrator falls back to
        // fallback (currentActiveAgent), inheriting bash/write permissions of the LAST
        // delegated agent (e.g. executor, bashAllowlist:["*"]) instead of being blocked
        // as it should always be for the Orchestrator.
        if (FORBIDDEN_ORCHESTRATOR_TOOLS.includes(input.tool)) {
          auditedCheck(sessionID, 'orchestrator', 'orchestrator_direct_tool', () => {
            throw new Error(`Delegate instead of using ${input.tool} directly.`);
          }, { tool: input.tool });
        }
      }

      // 2.6. GATE: conductor-rules must be loaded before the first delegation.
      // Once per session (state.conductorRulesLoaded persists in sessionState) —
      // does not reload on every prompt, blocks only the first `task` until the Orchestrator
      // has called Skill('conductor-rules').
      // Fix 2026-08-11: sessionState is an in-memory Map (closes with the plugin
      // process) — if OpenCode is closed and reopened on the SAME session, the flag
      // is lost even if the rules are already in context/history. wasConductorRulesLoadedInHistory
      // checks the message history before blocking, to avoid requiring an unnecessary reload.
      if (isOrchestrator) {
        if (input.tool === 'skill' && output?.args?.name === 'conductor-rules') {
          state.conductorRulesLoaded = true;
          sessionState.set(sessionID, state);
        } else if (input.tool === 'task' && !state.conductorRulesLoaded) {
          if (await wasConductorRulesLoadedInHistory(sessionID)) {
            state.conductorRulesLoaded = true;
            sessionState.set(sessionID, state);
          } else {
            auditedCheck(sessionID, 'orchestrator', 'conductor_rules_gate', () => {
              throw new Error(`❌ ORCHESTRATOR: you must first load Skill('conductor-rules') before delegating.`);
            }, { tool: input.tool });
          }
        }
      }

      // 2.7. CAPTURE TARGET AGENT (Identity Propagation)
      // BY DESIGN upstream, tool.execute.* does not propagate the subagent
      // identity (no agent field — see packages/plugin/src/index.ts). The
      // sessionID→agent registry (event session.created) is the primary
      // identity source; this bridge is the fallback.
      // This bridge must be written ONLY after the conductor-rules gate:
      // a blocked task must not leave pending/identity residue that
      // contaminate the next retry.
      if (input.tool === 'task') {
        const targetAgent = extractTargetAgent(input, output);
        if (targetAgent) {
          cleanupStalePending();

          // Blocks parallel delegations of DIFFERENT TYPES while one type
          // is still pending. Same-type (Swarm Mode) remains allowed.
          const otherPendingTypes = [...pendingAgentTypes.keys()].filter(t => t !== targetAgent);
          if (otherPendingTypes.length > 0) {
            auditedCheck(sessionID, targetAgent, 'parallel_identity_conflict', () => {
              throw new Error(
                `❌ PARALLEL CONFLICT: delegated to "${targetAgent}" is blocked — "${otherPendingTypes.join(', ')}" ` +
                `is still in progress (unresolved) and OpenCode does not guarantee subagent identity in parallel ` +
                `across different types (upstream design: hook tool.execute.* does not expose agent identity).\n` +
                `→ Wait for "${otherPendingTypes.join(', ')}" to complete at least one tool call, then retry.\n` +
                `→ Parallel delegations of the SAME agent (Swarm Mode) remain allowed.`
              )
            }, { targetAgent, otherPendingTypes })
          }

          pendingAgentTypes.set(targetAgent, Date.now());
          // VER-LOW-01: ownership is taken ONLY when this call CHANGES the
          // bridge value. A same-type swarm delegation (executor×2) re-arms
          // the same value: the second call must NOT steal ownership of the
          // bridge legitimately armed by the first in-flight call, or a
          // routing block on the second would clobber the first's bridge in
          // the task-handler catch (ownership guard there matches
          // bridgeArmedByCallID === input.callID).
          if (currentActiveAgent !== targetAgent) {
            bridgeArmedByCallID = input.callID;
          }
          currentActiveAgent = targetAgent;
          currentActiveAgentTimestamp = Date.now();

          // Updates Orchestrator reference for non-crystallized sessions
          // and not already confirmed as children by the registry.
          // REV-02: an unregistered session calling task joins rootSessions
          // PERMANENTLY (before, it stole the single slot from the previous
          // holder) — its direct tools stay blocked by check 2.5, fail-closed.
          const callerState = sessionState.get(sessionID);
          const isKnownChildSession = subagentRegistry.has(sessionID);
          if ((!callerState || !callerState.lastAgent) && !isKnownChildSession) {
            rootSessions.add(sessionID);
            if (!orchestratorSessionID) orchestratorSessionID = sessionID;
          }
        }
      }

      // 3. ABSOLUTE PRIORITY: SENSITIVE FILE CHECK (Always active)
      if (['read', 'grep', 'glob'].includes(input.tool)) {
        const filePath = output?.args?.filePath || output?.args?.pattern || input.args?.filePath || input.args?.pattern || input.args?.path || '';
        if (filePath) {
          auditedCheck(sessionID, subagentType || 'unknown', 'sensitive_file',
            () => checkSensitiveFileAccess(subagentType || 'unknown', filePath, input.tool),
            { filePath, tool: input.tool });
        }
      }

      // 4. GRAY ZONE (Unknown Identity)
      if (!subagentType) {
        const safeReadTools = ['read', 'grep', 'glob', 'ls', 'cat', 'find'];
        if (safeReadTools.includes(input.tool)) {
          runtimeLog(`⚠️ GRAY ZONE: read-only tool "${input.tool}" allowed (unknown identity, safe). SessionID: ${sessionID}`);
          return; // Allowed in safe mode
        }

        // M1/REV-05 (2026-09-10): mutative tools (bash/edit/write/rm) at
        // unknown identity are NOT allowed through — each is blocked fail-closed
        // downstream in the dispatcher (bash_block / edit_block / write_block /
        // tool_phase). This log is observability only: it records the attempt
        // before the respective dispatcher branch throws.
        const mutativeTools = ['bash', 'edit', 'write', 'rm']
        if (mutativeTools.includes(input.tool)) {
          runtimeLog(`⚠️ GRAY ZONE: mutative tool "${input.tool}" attempted with unknown identity — will be blocked downstream. SessionID: ${sessionID}`);
        }
      }

      // 5. PRE-DELEGATION PHASE MANAGEMENT
      // Only the Orchestrator is subject to the phase check — subagents must not
      // be blocked by the Orchestrator session's phase.
      if (state.phase === 'pre-delegation' && isOrchestrator) {
        // If the current tool is 'task' towards a non-pre-delegation agent,
        // we reset the phase BEFORE the check — otherwise the task gets blocked
        // before being able to reset the phase inside the task handler.
        if (input.tool === 'task') {
          const nextAgent = output?.args?.subagent_type
          if (nextAgent && !agentProfiles[nextAgent]?.canPreDelegate) {
            state.phase = 'delegated'
            state.lastAgent = null  // FIX: Reset the identity of the pre-delegation agent
            sessionState.set(sessionID, state)
          }
        } else {
          // FIX (2026-08-25): was a fixed allowlist — any dynamic MCP tool
          // not enumerated (e.g. supabase_apply_migration, or any mcp__*) was
          // blocked in pre-delegation even if legitimate, because the allowlist
          // cannot know every configurable MCP tool in advance. read is
          // the only exception; grep/glob/bash/edit/write/sequential-thinking/
           // tools in the denylist are already blocked for
          // the Orchestrator unconditionally by check 2.5 above (which runs
          // BEFORE this, so we never revisit them here) — using the same
          // shared list (FORBIDDEN_ORCHESTRATOR_TOOLS) as a DENYLIST instead of
          // rewriting a separate allowlist, any other tool passes, including
          // an MCP tool never seen before (webfetch/websearch/question included,
          // 2026-07-27/2026-08-14 — the Orchestrator can use them directly).
          if (!FORBIDDEN_ORCHESTRATOR_TOOLS.includes(input.tool)) return
          auditedCheck(sessionID, subagentType || 'orchestrator', 'tool_phase', () => {
            throw new Error(`❌ ORCHESTRATOR: ${input.tool} is forbidden in phase pre-delegation.`)
          }, { tool: input.tool })
        }
      }

      // 6. DISPATCHER SPECIFICO
      const profile = subagentType ? agentProfiles[subagentType] : null;

      if (input.tool === 'bash') {
        const command = input.args?.command || output?.args?.command || '';
        // If the identity is the orchestrator (root), block bash
        if (!subagentType || subagentType === 'orchestrator') {
          auditedCheck(sessionID, 'orchestrator', 'bash_block', () => {
            throw new Error(`❌ BASH: The Orchestrator cannot use the shell. Delegate to a subagent.`);
          }, { command });
          return;
        }
        // ABSOLUTE PRIORITY: sensitive files also via shell (Get-Content, cat,
        // type, grep on .env, SSH keys, etc.). RE-ADDED 2026-07-28 after
        // it had completely disappeared from the file (not just the bashAllowlist exception,
        // the entire block itself) — third time it regressed, verified with
        // isolated test. SENSITIVE_FILE_PATTERNS patterns are anchored with $
        // (exact end of string) — they don't match a path embedded between quotes
        // inside a longer command, so we extract path-like tokens first.
        const pathTokens = [
          ...[...command.matchAll(/"([^"]+)"/g)].map(m => m[1]),
          ...[...command.matchAll(/'([^']+)'/g)].map(m => m[1]),
          ...command.split(/\s+/).filter(t => /[\\/]|^\./.test(t)),
        ]
        auditedCheck(sessionID, subagentType, 'sensitive_file_bash', () => {
          for (const token of pathTokens) {
            const normalizedToken = token.replace(/\\/g, '/')
            for (const pattern of SENSITIVE_FILE_PATTERNS) {
              if (pattern.name === 'secrets_directory' && isNodeModulesPath(normalizedToken)) continue
              pattern.regex.lastIndex = 0
              if (pattern.regex.test(normalizedToken)) {
                throw new Error(
                  `❌ SENSITIVE FILE (bash): bash command accessing a sensitive file blocked for "${subagentType}". ` +
                  `Pattern: ${pattern.name}, Severity: ${pattern.severity}, Path: ${token}. Command: ${command.substring(0, 150)}`
                )
              }
            }
          }
        }, { command: command.substring(0, 150) })
        if (profile) {
          auditedCheck(sessionID, subagentType, 'bash_whitelist', () => checkBashWhitelist(subagentType, profile, command), { command });
        } else {
          throw new Error(`❌ BASH: Profile not found for ${subagentType}.`);
        }
        return;
      }

      // Check 8: WEBFETCH guard
      if (input.tool === 'webfetch') {
        const url = input.args?.url || output?.args?.url || ''
        const prompt = output?.args?.prompt || ''
        const beforeAuditLen = state.webfetchAudit.length

        // Maintain Schema Check: must start with http:// or https://
        // Single schema check point — checkWebfetch no longer duplicates it (M3 dedup, REV-02)
        if (!/^https?:\/\//i.test(url)) {
          auditedCheck(sessionID, subagentType || 'unknown', 'webfetch_schema', () => {
            throw new Error(`❌ WEBFETCH: URL scheme not allowed for "${subagentType || 'unknown'}": ${url}. Only http/https allowed.`);
          }, { url });
        }

        if (isOrchestrator) {
          // Allow Orchestrator immediately
          state.webfetchAudit.push({ agent: 'orchestrator', url, prompt: prompt?.substring(0, 100), timestamp: Date.now(), allowed: true, reason: 'orchestrator' });
        } else if (!subagentType || subagentType === 'orchestrator') {
          // REV-05 (2026-09-10): unknown identity was previously a 'grey_zone'
          // ALLOW entry with no check at all — webfetch is now fail-closed,
          // specular to the M1 write fix. Profiled agents keep their own
          // branch below; a subagentType with no profile (unregistered agent)
          // also lands in checkWebfetch, which throws fail-closed on the
          // null-profile guard.
          auditedCheck(sessionID, 'unknown', 'webfetch_block', () => {
            throw new Error(`❌ WEBFETCH: unknown identity — webfetch forbidden until the session is registered as a subagent. Delegate instead.`)
          }, { url, prompt });
        } else {
          // Preserve Profile Logic for known subagents
          auditedCheck(sessionID, subagentType, 'webfetch', () => {
            checkWebfetch(subagentType, profile, url, prompt, state.webfetchAudit);
          }, { url, prompt });
        }

        // No error → persist any allowed entries
        const newEntries = state.webfetchAudit.slice(beforeAuditLen)
        for (const entry of newEntries) {
          persistAuditEvent(sessionID, 'webfetch', subagentType || 'unknown', entry.allowed ? 'allowed' : 'blocked', {
            url,
            reason: entry.reason,
            prompt: entry.prompt
          })
        }
        return
      }

      // Check 10: EDIT path
      if (input.tool === 'edit') {
        const filePath = output?.args?.filePath || input.args?.filePath || ''
        const editAgent = subagentType || 'unknown'
        
        // Check 10a: EDIT permission — verify that the agent can modify the file
        if (profile && profile.allowEdit === false) {
          auditedCheck(sessionID, editAgent, 'edit_denied', () => {
            throw new Error(`❌ EDIT: ${editAgent} does not have edit permissions (allowEdit: false). Delegate to executor.`)
          }, { filePath, agent: editAgent })
          return
        }
        if (isOrchestrator || !subagentType || subagentType === 'orchestrator') {
          auditedCheck(sessionID, 'orchestrator', 'edit_block', () => {
            throw new Error(`❌ EDIT: The Orchestrator cannot modify files. Delegate to a subagent.`)
          }, { filePath })
          return
        }
        
        auditedCheck(sessionID, editAgent, 'edit_path', () => {
          checkEditPath(editAgent, filePath)
        }, { filePath })
        return
      }

      // Check 10+11: WRITE path
      if (input.tool === 'write') {
        const filePath = output?.args?.filePath || input.args?.filePath || ''
        const exists = input.args?.exists === true || output?.args?.exists === true
        const writeAgent = subagentType || 'unknown'
        // M1 (2026-09-10, REV-01): the only real mutative hole at unknown
        // identity — write fell through to checkWritePath("unknown", ...) and
        // passed. bash/edit/rm were already blocked downstream; now write is
        // fail-closed too, specular to the edit pattern below. For a true
        // Orchestrator session check 2.5 (orchestrator_direct_tool) already
        // blocks write BEFORE this line, so the throw below is effectively for
        // the unknown-identity case — kept as-is (harmless redundancy).
        // VER-M1-01: audit label unified to 'unknown' (was 'orchestrator') —
        // matches the webfetch_block label for unknown identity; the audit
        // agent argument is observability only, the thrown message is unchanged.
        // REV-01 (2026-09-11): this fail-closed throw only holds if a BLOCKED
        // delegation leaves no identity residue — the task-handler catch below
        // must roll back currentActiveAgent (not just pendingAgentTypes), or an
        // unregistered session resolves the rejected target and skips this throw.
        if (isOrchestrator || !subagentType || subagentType === 'orchestrator') {
          auditedCheck(sessionID, 'unknown', 'write_block', () => {
            throw new Error(`❌ WRITE: unknown identity — the session is not registered as a subagent. Delegate instead.`)
          }, { filePath })
          return
        }
        auditedCheck(sessionID, writeAgent, 'write_path', () => {
          checkWritePath(writeAgent, filePath, exists, state.scopeViolationTargets)
        }, { filePath, exists })
        return
      }

      // If we are in idle or delegated phase, block mutative or dangerous tools.
      if (['edit', 'bash', 'write', 'rm'].includes(input.tool)) {
        auditedCheck(sessionID, subagentType || 'orchestrator', 'tool_phase', () => {
          throw new Error(
            `❌ ORCHESTRATOR: ${input.tool} is forbidden in phase ${state.phase}.\n` +
            `→ Rule 3b: no manual debugging/exploration.\n` +
            `→ If you need context, do pre-delegation to explorer.\n` +
            `→ If you need to implement, delegate to executor.`
          )
        }, { tool: input.tool, phase: state.phase })
      }

      // ---- TASK DELEGATION (case B) ----
      if (input.tool === 'task') {
        // VER-LOW-02: SAME extractor as the arming block above (shared
        // helper) — a delegation with subagent_type only in input.args now
        // enters the full validation flow instead of early-returning with
        // the bridge armed and no rollback path. The early return below
        // fires only when BOTH sources lack subagent_type, in which case the
        // arming block never armed anything (its own `if (targetAgent)`).
        const targetAgent = extractTargetAgent(input, output)
        runtimeLog(`TASK HANDLER START: tool=${input.tool}, targetAgent=${targetAgent}`)
        try {
          const prompt = output?.args?.prompt ?? ""
          const description = output?.args?.description ?? ""
          const fullText = `${description} ${prompt}`

          if (!targetAgent) {
            // subagent_type completely absent: OpenCode itself rejects the tool call
            // at schema level (SchemaError "Missing key at subagent_type") before
            // that the task gets processed — no blocking necessary here.
            return
          }
          if (!agentProfiles[targetAgent]) {
            // FIX (2026-08-15): real incident — delegating to "general" (native
            // generic OpenCode agent, absent from guard-config.json)
            // passed with a plain silent `return`, SKIPPING all checks
            // below (routing, delegation_rules, neverdo, anti_loop, workflow) —
            // the task ran with ZERO Guard enforcement. Unlike
            // the "subagent_type absent" case above, here the value is valid for the
            // OpenCode schema (so the delegation IS executed) but does not
            // correspond to any configured agent — must be blocked, not
            // left to pass silently.
            // NOTE (REV-04): no pendingAgentTypes.delete here — this throw is
            // caught by the task-handler catch below, which performs the full
            // symmetric rollback (pending + identity bridge). A delete here
            // would be redundant.
            auditedCheck(sessionID, targetAgent, 'unknown_agent', () => {
              throw new Error(
                `❌ ROUTING: subagent_type "${targetAgent}" does not exist in guard-config.json — delegation forbidden.\n` +
                `→ Valid agents: ${Object.keys(agentProfiles).sort().join(', ')}`
              )
            }, { targetAgent })
          }
          const targetProfile = agentProfiles[targetAgent]

          // Reset pre-delegation phase at the start of each new delegation.
          // we reset it
          // immediately — the pre-delegation agent has already done its job.
          if (state.phase === 'pre-delegation' && !agentProfiles[targetAgent]?.canPreDelegate) {
            state.phase = 'delegated'
            sessionState.set(sessionID, state)
          }

          // Routing documentation (kept)
          auditedCheck(sessionID, targetAgent, 'routing', () => checkRouting(targetAgent, targetProfile, fullText, agentProfiles), { agent: targetAgent, fullTextPreview: fullText.substring(0, 100) })

          // Delegation rules (new mandatory check)
          auditedCheck(sessionID, targetAgent, 'delegation_rules', () => checkDelegationRulesWithRetry(targetAgent, targetProfile, fullText, agentProfiles, state), { agent: targetAgent, fullTextPreview: fullText.substring(0, 100) })

          // 🆕 NEW: NeverDo enforcement
          auditedCheck(sessionID, targetAgent, 'neverdo', () => 
            checkNeverDo(targetAgent, targetProfile, fullText), 
            { agent: targetAgent, fullTextPreview: fullText.substring(0, 100) }
          );

          // Check E: ANTI-LOOP Guard
          if (targetAgent && !isOrchestrator) {
            auditedCheck(sessionID, targetAgent, 'anti_loop', () => checkDelegationLoop(state.delegationStack, targetAgent), { stack: state.delegationStack })
          }

          if (state.phase === 'pre-delegation') {
            state.phase = 'delegated'
          }

          // Check 9: SUB-DELEGATION
          // NOTE: moved BEFORE the early return of canPreDelegate (see below).
          // Before, a canPreDelegate target (explorer, codebase-mapper) exited the
          // function before reaching this point, bypassing the sub-delegation gate.
          const isVerificationCycle = isVerificationCycleCall(state.lastAgent, targetAgent);
          if (!isOrchestrator && state.lastAgent && state.lastAgent !== targetAgent && !isVerificationCycle) {
            const callerProfile = agentProfiles[state.lastAgent]
            auditedCheck(sessionID, targetAgent, 'sub_delegation', () =>
              checkTaskSubDelegation(state.lastAgent, callerProfile, targetAgent, agentProfiles)
            )
          }

          // CHECK 2: Dangerous actions
          auditedCheck(sessionID, targetAgent, 'dangerous', () => checkDangerousActions(fullText), { fullTextPreview: fullText.substring(0, 100) })
          // CHECK 3: SSH Local Guard
          auditedCheck(sessionID, targetAgent, 'ssh_local', () => checkSshLocal(fullText), { fullTextPreview: fullText.substring(0, 100) })
          // CHECK 4: Skill Injection — REMOVED
          // Skills must be loaded by the subagent internally, not by the Orchestrator in the prompt.
          // CHECK 5: Workflow Sequence
          // Also includes the identity of the CALLER (subagentType): if a diagnosis-only agent
          // (verifier, debugger, explorer, etc. — readOnlyDespiteFullBash) delegates
          // DIRECTLY to executor (allowed by canDelegateTo, e.g. verifier→executor after
          // failed verification), its personal delegation sequence is empty — but it ITSELF
          // is the diagnosis already done. Without this, executor was blocked for error
          // asking for a diagnosis that had already been performed by the caller.
          const workflowSequenceWithCaller = !isOrchestrator && subagentType
            ? [...(state.delegationSequence || []), subagentType]
            : (state.delegationSequence || [])
          auditedCheck(sessionID, targetAgent, 'workflow', () => checkWorkflowSequence(targetAgent, fullText, workflowSequenceWithCaller, agentProfiles), { agent: targetAgent, fullTextPreview: fullText.substring(0, 100) })

          runtimeLog(`WORKFLOW CHECK: sessionID=${sessionID} delegationSequence=${JSON.stringify(state.delegationSequence)}, targetAgent=${targetAgent}`)

          // CHECK: Verifier required after executor
          // Allows other executors in parallel (Swarm Mode) but blocks any
          // other agent until the verifier arrives — EXCEPT analysis-only agents
          // analysis/diagnosis (readOnlyDespiteFullBash: true — debugger, explorer,
          // codebase-mapper, code-reviewer, security-auditor), which do not produce
          // code changes and can legitimately work on an unrelated problem
          // while a previous fix waits for verification.
          // Derived from the flag instead of a separate fixed list: a fixed list
          // (diagnosisOnlyAgents) had forgotten code-reviewer/security-auditor
          // — the same flag already used for the mutation-check, single source
          // of truth instead of two lists that can get out of sync.
          const lastDelegated = (state.delegationSequence || [])[(state.delegationSequence || []).length - 1]
          if (lastDelegated === 'executor' &&
              targetAgent !== 'verifier' &&
              targetAgent !== 'executor' &&
              targetAgent !== 'doc-writer' &&
              !agentProfiles[targetAgent]?.readOnlyDespiteFullBash) {
            throw new Error(
              `❌ WORKFLOW: executor has modified code. The next agent must be verifier.\n` +
              `→ Required agent: verifier\n` +
              `→ Attempted agent: ${targetAgent}`
            )
          }

          runtimeLog(`WORKFLOW CHECK PASSED: targetAgent=${targetAgent}`)

          // Pre-delegation detection — AFTER all security checks above.
          // Before this, the early return happened BEFORE sub-delegation,
          // dangerous, ssh_local, workflow sequence and executor→verifier,
          // letting callers bypass all of them by simply delegating to a
          // canPreDelegate agent (explorer, codebase-mapper) instead of the
          // "real" target. Now those agents go through the same checks
          // of anyone else — the only exception (executor→verifier) is now
          // explicit and deliberate (see readOnlyDespiteFullBash above), not an
          // accidental side-effect of pre-delegation phase management.
          if (targetAgent && agentProfiles[targetAgent]?.canPreDelegate) {
            state.phase = 'pre-delegation'
            // REMOVED: state.lastAgent = targetAgent
            // Write the CALLER's identity here (state.lastAgent) with the
            // TARGET of the delegation confused "who is this session" with "to the
            // just delegated" — under Swarm Mode (parallel delegations from the
            // same Orchestrator session, including canPreDelegate) this
            // produced a race condition: the last canPreDelegate delegation
            // processed "won" and contaminated state.lastAgent for the
            // executor calls made afterwards, erroneously triggering
            // the sub-delegation gate (isOrchestrator remained true, but the
            // check state.lastAgent). The caller's identity must go
            // set ONLY during crystallization (above), never from here.
            sessionState.set(sessionID, state)
            return
          }

          // Update state after all checks passed
          // REMOVED: state.lastAgent = targetAgent (same reason as above)

          // Update anti-loop stack
          if (isOrchestrator) {
            state.delegationStack = [targetAgent]
          } else {
            state.delegationStack.push(targetAgent)
          }

          runtimeLog(`PUSHING TO SESSION SEQUENCE: ${targetAgent}`)

          state.delegationSequence = state.delegationSequence || []
          state.delegationSequence.push(targetAgent)
          // Limita la sequenza a 20 step (evita crescita infinita)
          if (state.delegationSequence.length > 20) {
            state.delegationSequence.shift(); // removes the oldest
          }
          sessionState.set(sessionID, state);
          persistAuditEvent(sessionID, 'delegation', targetAgent, 'executed', {
            fullTextPreview: fullText.substring(0, 200)
          })
        } catch (taskError) {
          // Rollback: the subagent will never be created (the check failed before
          // creation), so neither pendingAgentTypes NOR the identity bridge may keep
          // the rejected target. Leaving currentActiveAgent armed grants the rejected
          // agent's profile to the NEXT unregistered session (write/bash/edit pass:
          // validatePathZone does not consult agentProfiles) and crystallizes it
          // permanently into state.lastAgent (identity lock block) — fail-closed
          // inverted to fail-open by the block itself.
          //
          // VER-LOW-01 (2026-09-11): the bridge rollback is guarded by
          // OWNERSHIP, not just by value. Under a same-type swarm (executor×2,
          // legitimate fan-out — the parallel_identity_conflict gate filters
          // t !== targetAgent and lets same-type through) a blocked delegation
          // has `currentActiveAgent === targetAgent` true even when the bridge
          // was armed by a DIFFERENT in-flight sibling call: rolling back on
          // the value alone would clobber the legitimate sibling's bridge
          // (degrading it to unknown identity). The double guard
          // `currentActiveAgent === targetAgent && bridgeArmedByCallID === input.callID`
          // rolls back ONLY the call that took ownership (the call that last
          // CHANGED the bridge value — see the arming block). A blocked
          // delegation that never changed the value leaves the sibling's
          // bridge intact; a blocked delegation that DID arm (single
          // delegation, or first-of-swarm) rolls back fully (pins 29.3/29.4).
          //
          // pendingAgentTypes.delete stays UNCONDITIONAL (documented minor
          // side-effect): it only disarms the defensive
          // parallel_identity_conflict gate for the sibling type — never
          // observed necessary (registry is the primary identity source,
          // P2.7-8/P2.9) and re-armed by the next delegation of that type.
          if (targetAgent) {
            pendingAgentTypes.delete(targetAgent);
            if (currentActiveAgent === targetAgent && bridgeArmedByCallID === input.callID) {
              currentActiveAgent = null;
              currentActiveAgentTimestamp = 0;
              bridgeArmedByCallID = null;
            }
            runtimeLog(`[ROLLBACK] cleared pending+bridge for "${targetAgent}" after task check failure: ${taskError.message}`);
          }
          throw taskError;  // Re-throw to maintain the blocking behavior
        }
      }
    },


    // ============================================
    // HOOK tool.execute.after — Check A (anti-secret exfiltration audit)
    // ============================================
    // The `after` hook in OpenCode CANNOT block the action (already executed),
    // so detection is post-hoc. Since `tool.execute.before` is not
    // reliable in this environment, here we turn detection into an
    // explicit security incident: persisted audit + TUI toast + runtime log.
    // checkSecretsInOutput pushes the entry in state.secretDetectionAudit before
    // throwing, so the audit log already has the detail; here we make it visible.
    "tool.execute.after": async (input, output) => {
      try {
        const sessionID = input.sessionID || 'default'
        const state = sessionState.get(sessionID);
        if (!state || !state.lastAgent) return

        const profile = agentProfiles[state.lastAgent]
        if (!profile) return

        const auditLog = state.secretDetectionAudit || (state.secretDetectionAudit = [])
        const filePath = output?.args?.filePath || output?.args?.pattern || input.args?.filePath || input.args?.pattern || input.args?.path || ''
        checkSecretsInOutput(output?.output || output?.metadata || output, state.lastAgent, profile, auditLog, filePath)
      } catch (e) {
        // Hook after cannot block originally, but by modifying the output object by reference
        // we can actively redact secrets before they return to OpenCode.
        if (output && typeof output === 'object') {
          const redactMsg = `[REDACTED BY DELEGATION GUARD - SECURITY VIOLATION: SECRET DETECTED]`
          if (output.output !== undefined) output.output = redactMsg
          if (output.metadata !== undefined) output.metadata = redactMsg
          for (const key of Object.keys(output)) {
            if (key !== 'id' && key !== 'tool' && key !== 'sessionID') {
              if (typeof output[key] === 'string') {
                output[key] = redactMsg
              } else if (typeof output[key] === 'object' && output[key] !== null) {
                output[key] = { error: redactMsg }
              }
            }
          }
        }

        const sessionID = input.sessionID || 'default'
        const agent = sessionState.get(sessionID)?.lastAgent || 'unknown'
        runtimeLog(`🚨 SECRET DETECTED (post-exec): sessionID=${sessionID}, agent=${agent}, reason=${e.message}`)
        persistAuditEvent(sessionID, 'denied', agent, 'blocked', {
          check: 'secret_detection_after',
          error: e.message
        })
        try {
          client.tui.showToast({
            body: {
              message: `🚨 GUARD [secret]: ${agent}: ${e.message.split('\n')[0]}`,
              variant: 'error'
            }
          })
        } catch (_) { /* TUI not available, silent */ }
        console.error('[delegation-guard] Secret detection:', e.message)
      }
    },


    // ============================================
    // EVENT HOOK — session lifecycle
    //
    // IMPORTANT: there is no dedicated "session.created" hook in the official API
    // OpenCode (@opencode-ai/plugin). All session events (session.created,
    // session.deleted, etc.) arrive only through the generic "event" hook.
    //
    // Real schema (from packages/schema/src/v1/session.ts):
    //   event.type = "session.created"
    //   event.properties = { sessionID, info: { id, parentID?, agent?, ... } }
    //
    // parentID and agent are optional — null/undefined for root sessions.
    "event": async ({ event }) => {
      // Populate subagent registry when OpenCode creates a child session.
      if (event?.type === 'session.created') {
        const sessionID = event.properties?.sessionID
        const info = event.properties?.info

        if (sessionID && info) {
          // Child session (has parentID) → subagent to register
          if (info.parentID && info.agent) {
            subagentRegistry.set(sessionID, info.agent)
            runtimeLog(`[REGISTRY] session.created child=${sessionID} agent=${info.agent} parent=${info.parentID}`)
            // FAST-RELEASE (redesign 2026-08-05): the registry has already resolved identity
            // for this session — no need to wait for slow crystallization
            // (first real tool call) to unlock Option A for this type.
            if (pendingAgentTypes.has(info.agent)) {
              pendingAgentTypes.delete(info.agent)
              runtimeLog(`[FAST-RELEASE] pendingAgentTypes cleared for "${info.agent}" via session.created (child=${sessionID})`)
            }
          }
          // Root session (no parentID) → probably the Orchestrator
          else if (info.agent) {
            runtimeLog(`[REGISTRY] session.created root=${sessionID} agent=${info.agent} (orchestrator)`)
            // REV-02: every root joins the Set; the single slot is set only
            // if empty — a second root must NOT steal orchestrator status
            // from the first.
            rootSessions.add(sessionID);
            if (!orchestratorSessionID) orchestratorSessionID = sessionID;
          }
          // Session without agent → gray zone
          else {
            runtimeLog(`[REGISTRY] session.created sessionID=${sessionID} without an agent (gray zone)`)
          }
        }
      }

      // Cleanup per-session delegation sequence only on true session end.
      // REMOVED 'session.idle' from trigger (2026-07-18): probably triggers
      // every time the Orchestrator waits for a delegated subagent
      // (i.e. after EVERY delegation, not only at end of conversation) — this
      // zeroed delegationSequence right after, for example, a delegation to
      // explorer, making the "requires diagnosis first" check for executor
      // subsequent dependent on luck (only if the prompt happened to contain
      // a keyword, not if the real sequence justified it).
      // The array already has a cap of 20 with FIFO eviction (see below), so
      // memory hygiene cleanup is guaranteed without needing this reset.
      if (event?.type === 'session.deleted') {
        const sessionID = event?.sessionID
        if (sessionID) {
          subagentRegistry.delete(sessionID);
          // REV-02: prune the root session from the Set (TUI /new, session
          // close). NOTE: session.deleted is never emitted in headless run
          // mode (see SESSIONS.md P2.10) — in-memory Set is process-bound
          // anyway, so un-pruned entries die with the plugin instance.
          rootSessions.delete(sessionID);
          if (orchestratorSessionID === sessionID) orchestratorSessionID = null;
          const state = sessionState.get(sessionID)
          if (state) {
            state.delegationSequence = []
            sessionState.set(sessionID, state)
            runtimeLog(`🧹 CLEANUP: delegationSequence reset for session ${sessionID}`)
          }
        }
      }
    // No-op: session state is now managed by SessionStatePersistence plugin
    }
  }
  } catch (err) {
    const errLogMsg = `❌ PLUGIN STARTUP CRASH: ${err.message}\nStack:\n${err.stack}`
    runtimeLog(errLogMsg)
    try {
      const initLogPath = path.join(__dirname, '.planning', 'guard-init.log')
      if (!existsSync(path.dirname(initLogPath))) {
        mkdirSync(path.dirname(initLogPath), { recursive: true })
      }
      appendFileSync(initLogPath, `[${getLocalTimestamp()}] ${errLogMsg}\n`, 'utf8')
    } catch (_) {}
    throw err
  }
}


// ============================================
// EXPORT — single public interface
// ============================================
// Internal check functions (read, edit, write, bash, etc.) are private
// to the module: they live inside the closure and are not exported. The only export
// public is `DelegationGuard`, which OpenCode calls as a plugin hook.
//
// FUTURE: If pure TDD is needed (node --test without instantiating OpenCode),
// extract check functions as pure named exports (same logic,
// no closure dependencies) to import in test files.
//
// Context convention for subagent_type (see CUSTOMIZE_OPENCODE_SKILL):
//  - OpenCode passes args.subagent_type to the "task" tool
//  - For other tools (bash, edit, write, webfetch), subagent_type is
//    injected from context in args or recovered from the session state Map
//  - getSessionState(sessionID) → returns the current state of the session

// ============================================
// CHECK B — Audit log persistence to disk
// ============================================
// Writes audit events in JSONL format (one JSON event per line) in
// `audit-YYYY-MM-DD.jsonl` inside the configured directory. Production default:
// `.planning/audit` (relative to `__dirname`).
//
// Event schema:
//   { timestamp, sessionId, eventType, agent, action, details }
//
// - `eventType`: 'secret' | 'sensitive' | 'webfetch' | 'delegation' | 'denied'
// - `action`:    'redacted' | 'allowed' | 'blocked' | 'executed'
// - `details`:   optional, type-specific
//
// Resilience: write errors do NOT propagate (they log to console.error
// with prefix `[GUARD-AUDIT-ERROR]`). The guard must never block on
// I/O problems on the audit log.

/** @type {string} */
let currentAuditLogDir = path.join(__dirname, '.planning', 'audit')

/**
 * Manages the persistence of incidents and lessons learned when an event is 'denied'.
 * @param {string} agent 
 * @param {Record<string, any>} details 
 */
/**
 * Sanitizes text before interpolating it
 * (both markdown files in append). Without this, an attacker-controlled
 * value (e.g. subagent_type in a ROUTING error, or a bash command
 * truncated in a SHELL MUTATION error) containing `\n### [INC-9999] ...`
 * can inject a fake entry in the audit trail — CR/LF is the only way to
 * start a new markdown line, so removing them neutralizes
 * the injection regardless of the content of the rest of the string.
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeForMarkdownLog(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return text.replace(/[\r\n]+/g, ' ⏎ ')
}

function handleDeniedEvent(agent, details) {
  try {
    if (!_projectDirectory) {
      runtimeLog(`handleDeniedEvent: _projectDirectory not set. Skipping persistence.`);
      return;
    }
    if (_projectDirectory.endsWith(path.sep + '.opencode') || _projectDirectory.includes(path.sep + '.opencode' + path.sep)) {
        runtimeLog(`handleDeniedEvent: _projectDirectory is inside .opencode (${_projectDirectory}). Skipping persistence.`);
        return;
    }
    const metricsPath = path.resolve(_projectDirectory, '.opencode', 'metrics_count.json');
    const incidentsPath = path.resolve(_projectDirectory, '.planning', 'INCIDENTS.md');
    // FIX (2026-09-11, LESSONS containment): lessons used to be written to
    // ~/.config/opencode/LESSONS.md — OUTSIDE the project containment, so
    // denied phrases from one project leaked into a cross-project file.
    // Now co-located with INCIDENTS.md in the project's .planning/ dir
    // (same _projectDirectory mechanism, same append semantics). The old
    // homedir file, if present, is user data and is NOT touched/migrated.
    const lessonsPath = path.resolve(_projectDirectory, '.planning', 'LESSONS.md');
    const metricsDir = path.dirname(metricsPath);
    const planningDir = path.dirname(incidentsPath);
    const lessonsDir = path.dirname(lessonsPath);

    if (!existsSync(metricsDir)) mkdirSync(metricsDir, { recursive: true });
    if (!existsSync(planningDir)) mkdirSync(planningDir, { recursive: true });
    if (!existsSync(lessonsDir)) mkdirSync(lessonsDir, { recursive: true });

    let metrics = { total_incidents: 0, counts: {}, lessons_written: {} };
    if (existsSync(metricsPath)) {
      try {
        metrics = JSON.parse(readFileSync(metricsPath, 'utf8'));
      } catch (e) {
        runtimeLog(`Error reading metrics: ${e.message}`);
      }
    }

    metrics.total_incidents++;
    const incidentId = `INC-${metrics.total_incidents.toString().padStart(4, '0')}`;
    // Sanitized: agent, checkName, and details.error can contain text
    // attacker-controlled (e.g. arbitrary subagent_type, bash command
    // truncated) — without this a CR/LF inside them can forge a
    // fake entry in the audit log (see sanitizeForMarkdownLog).
    const checkName = sanitizeForMarkdownLog(details.check || 'unknown_check');
    const safeAgent = sanitizeForMarkdownLog(agent);
    const safeError = sanitizeForMarkdownLog(details.error || 'No details provided');
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const incidentEntry = `\n### [${incidentId}] [${checkName}] | ${dateStr} | ${safeAgent} | Status: blocked | ${safeError}\n`;

    appendFileSync(incidentsPath, incidentEntry, 'utf8');

    const lessonKey = `${agent}:${details.check || 'unknown_check'}`;
    metrics.counts[lessonKey] = (metrics.counts[lessonKey] || 0) + 1;

    if (metrics.counts[lessonKey] === 2 && !metrics.lessons_written[lessonKey]) {
      const synthesis = safeError.replace(/^❌ [^:]+: /, '');
      const lessonEntry = `- [${dateStr}] ${safeAgent} attempted ${checkName} $\rightarrow$ ${synthesis}\n`;
      appendFileSync(lessonsPath, lessonEntry, 'utf8');
      metrics.lessons_written[lessonKey] = true;
    }

    // Atomic write (temp file + rename) instead of direct writeFileSync.
    // Does not eliminate the read-modify-write race if OpenCode were to execute the
    // plugin in separate concurrent processes on the same project (not
    // verifiable from here) — but avoids a concurrent reader seeing a JSON
    // partially written/corrupted during a non-atomic rename.
    const metricsTmpPath = `${metricsPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(metricsTmpPath, JSON.stringify(metrics, null, 2), 'utf8');
    renameSync(metricsTmpPath, metricsPath);
  } catch (e) {
    runtimeLog(`Denied event persistence failed: ${e.message}`);
  }
}

/**
 * Appends an audit event to the file `audit-YYYY-MM-DD.jsonl`.
 * - Creates the directory if it doesn't exist (`mkdirSync` recursive).
 * - Encoding UTF-8, line separator `\n`.
 * - Write errors are logged in `console.error` and NOT propagated.
 *
 * @param {string} sessionId - OpenCode session ID
 * @param {string} eventType - Event type ('secret'|'sensitive'|'webfetch'|'delegation'|'denied')
 * @param {string|null} agent - Agent that generated the event (or null)
 * @param {string} action - Action ('redacted'|'allowed'|'blocked'|'executed')
 * @param {Record<string, any>} [details] - Optional type-specific details
 */
function persistAuditEvent(sessionId, eventType, agent, action, details = {}) {
  try {
    if (!existsSync(currentAuditLogDir)) {
      mkdirSync(currentAuditLogDir, { recursive: true })
    }
    const now = new Date()
    const pad = (/** @type {number} */ n) => n.toString().padStart(2, '0')

    const dateStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}` // YYYY-MM-DD local
    const filename = `audit-${dateStr}.jsonl`
    const filepath = path.join(currentAuditLogDir, filename)
    const event = {
      timestamp: getLocalTimestamp(),
      sessionId: sessionId || 'unknown',
      eventType,
      agent: agent || null,
      action,
      details
    }
    appendFileSync(filepath, JSON.stringify(event) + '\n', 'utf8')

    if (eventType === 'denied') {
      handleDeniedEvent(agent || 'unknown', details);
    }
  } catch (e) {
    // Write errors must NOT block the guard.
    console.error('[GUARD-AUDIT-ERROR]', e instanceof Error ? e.message : String(e))
  }
}

/**
 * Creates an initial session state.
 * M4 (2026-09-10): the two legacy context/history fields removed — dead state
 * (never read nor written anywhere else), pinned by M4 analysis.
 * @returns {{ phase: 'idle'|'pre-delegation'|'delegated', lastAgent: string|null, webfetchAudit: any[], secretDetectionAudit: any[], delegationSequence: string[] }}
 */
function createSessionState() {
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

/**
 * Normalizes a filePath for the forbidden zone check.
 * - Handles path traversal (../)
 * - Converts Windows backslashes (\) to forward slash (/)
 * - Removes ./ (dot-slash) prefix
 * - Removes leading / (absolute POSIX paths) to treat as relative
 * - Uses path.posix.normalize to collapse redundant separators
 *
 * Exported to allow direct TDD on the normalization logic.
 *
 * @param {string} filePath - Path to normalize (Windows or POSIX)
 * @returns {string} Normalized POSIX-like path, without traversal/./prefix
 */
function normalizePathForCheck(filePath) {
  if (!filePath) return ''
  if (typeof filePath !== 'string') return ''
  // 1) Convert Windows backslashes to forward slash
  const forwardSlash = filePath.replace(/\\/g, '/')
  // 2) Remove ./ (dot-slash) prefix
  const noDotPrefix = forwardSlash.replace(/^\.\//, '')
  // 3) Resolve traversal ../ (one or more in head)
  const noTraversal = noDotPrefix.replace(/^(\.\.\/)+/, '')
  // 4) Normalize with path.posix.normalize (collapses separators, handles remnants)
  // 5) Remove leading / (absolute POSIX path → relative for check)
  return path.posix.normalize(noTraversal).replace(/^\/+/, '')
}

/**
 * M2 (2026-09-10): the fallback is a MINIMAL SAFETY-NET, no longer a full
 * embedded copy of the policy. The old 325-line copy had real drift vs
 * guard-config.json (e.g. bashAllowlist for codebase-mapper). The single
 * source of truth for the full policy is now guard-config.json, which also
 * carries neverDo/keywords/allowMentions (migrated verbatim from the old
 * fallback in the same change).
 *
 * This fallback activates ONLY when guard-config.json is missing/unreadable
 * and must be:
 *   - FAIL-CLOSED on every mutative capability: bashAllowlist [] (total bash
 *     deny for ALL agents), canWebfetch false, canDelegateTo [] (sub-delegation
 *     backstop denies all — native task:deny already blocks children anyway)
 *   - FAIL-OPERATIONAL for delegation routing: delegation_rules with
 *     can_handle_directly ['*'] (wildcard, supported in checkDelegationRules)
 *     so a missing config does not brick every delegation, while all
 *     config-independent checks (sensitive files, dangerous actions, path
 *     zones, workflow, secrets) stay fully active
 *   - REV-03: neverDo [] — empty array passes checkNeverDo with no matching;
 *     the neverDo POLICY lives exclusively in guard-config.json
 *   - SEMANTICS-PRESERVING on the per-agent security fields: allowEdit,
 *     readOnlyDespiteFullBash, writeScope, noTestExecution and canPreDelegate
 *     keep the values they had in the previous fallback, so read-only roles
 *     stay read-only and executor keeps its edit/no-test semantics even
 *     without config.
 */
const SAFETY_NET_FALLBACK_ROLE = 'safety-net fallback (guard-config.json missing)'
/** @type {(overrides?: Record<string, any>) => any} */
const makeSafetyNetProfile = (overrides = {}) => ({
  role: SAFETY_NET_FALLBACK_ROLE,
  bashAllowlist: [],      // fail-closed: no bash at all without config
  canWebfetch: false,
  canDelegateTo: [],      // fail-closed: sub-delegation backstop denies all
  neverDo: [],            // REV-03: policy lives in guard-config.json only
  keywords: [],
  allowMentions: [],
  canPreDelegate: false,
  writeScope: 'all',
  delegation_rules: { can_handle_directly: ['*'] }, // REV-03: routing stays operational
  ...overrides,
})

/** @type {() => any} */
const createAgentProfilesFallback = () => ({
  // allowEdit / readOnlyDespiteFullBash / writeScope / canPreDelegate /
  // noTestExecution below = values preserved from the pre-M2 fallback.
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
  'verifier': makeSafetyNetProfile({ allowEdit: false, readOnlyDespiteFullBash: true, writeScope: 'all' }),
})

// ============================================
// CHECK FUNCTIONS — PRIVATE TO CLOSURE
// ============================================
// Check functions are private to the plugin closure.
// Only `DelegationGuard` is exported as a factory.
// Tests verify behavior via public API (DelegationGuard()).

/**
 * Pre-compiles the regex of forbidden patterns to avoid runtime overhead.
 * @param {any} profile
 */
function compileNeverDoRegex(profile) {
  if (!profile || !Array.isArray(profile.neverDo)) return
  profile.neverDoRegex = profile.neverDo.map(forbidden => {
    const pattern = forbidden.toLowerCase().includes(' ')
      ? forbidden.toLowerCase().split(/\s+/).map(w => `\\b${w}\\b`).join('\\s+(?:\\w+\\s+){0,3}')
      : `\\b${forbidden.toLowerCase()}\\b`
    return new RegExp(pattern, 'i')
  })
}

/** @type {(agent: string, profile: any, fullText: string) => void} */
function checkNeverDo(agent, profile, fullText) {
  // Guard null-profile: fail-closed with descriptive message (Finding #4)
  if (!profile) {
    throw new Error(`❌ GUARD: profile not found for agent "${agent}". Delegation/routing invalid.`)
  }
  if (!Array.isArray(profile.neverDo)) {
    throw new Error(`❌ GUARD: neverDo missing for "${agent}". Corrupted configuration.`)
  }

  // Pre-compile regex on the fly if not already present in profile
  if (!profile.neverDoRegex) {
    compileNeverDoRegex(profile)
  }

  for (let i = 0; i < profile.neverDoRegex.length; i++) {
    if (profile.neverDoRegex[i].test(fullText)) {
      const forbidden = profile.neverDo[i]
      if (isAllowedMention(forbidden, profile.allowMentions, fullText)) continue;
      throw new Error(
        `❌ RULE: ${agent} cannot do "${forbidden}".\n` +
        `→ Role: ${profile.role}\n` +
        `→ Use the appropriate agent.`
      )
    }
  }
}

/** @type {(fullText: string) => void} */
function checkDangerousActions(fullText) {
  for (const { regex, message } of dangerousPatterns) {
    if (regex.test(fullText)) throw new Error(message)
  }
}

/** @type {(fullText: string) => void} */
function checkSshLocal(fullText) {
  for (const { regex, message } of sshLocalPatterns) {
    if (regex.test(fullText)) throw new Error(message)
  }
}


/** @type {(agent: string, fullText: string, delegationSequence?: string[], allProfiles?: any) => void} */
function checkWorkflowSequence(agent, fullText, delegationSequence, allProfiles) {
  if (!agent || typeof agent !== 'string') {
    throw new Error(`❌ GUARD: invalid agent in checkWorkflowSequence. Delegation/routing invalid.`)
  }
  const workflowRule = workflowRules[agent]
  if (!workflowRule) return
  const hasException = workflowRule.exceptions.some(ex => fullText.toLowerCase().includes(ex.toLowerCase()))
  if (hasException) return

  // Checks if the prerequisite has already been satisfied in the real delegation sequence.
  // Prerequisite = any readOnlyDespiteFullBash agent (debugger, explorer,
  // codebase-mapper, verifier, code-reviewer, security-auditor) — they are all agents
  // of pure analysis/validation whose findings count as already-done diagnosis.
  // Derived from the flag instead of a separate fixed list (see note in dispatcher
  // main: a duplicated fixed list had forgotten code-reviewer/security-auditor).
  const sequenceAgents = delegationSequence || []
  const prereqAgents = allProfiles
    ? Object.keys(allProfiles).filter(name => allProfiles[name]?.readOnlyDespiteFullBash)
    : ['debugger', 'explorer', 'codebase-mapper', 'verifier'] // fallback if allProfiles is not passed
  const hasPrereqInSequence = sequenceAgents.some(a => prereqAgents.includes(a))
  if (hasPrereqInSequence) return

  const hasPrereq = workflowRule.requiresAnyOf.some(k => makeFuzzyRegex(k).test(fullText))
  if (/\bfix\b/.test(fullText) && !hasPrereq) {
    throw new Error(workflowRule.errorMessage)
  }
}

/** @type {(agent: string, profile: any, fullText: string, allProfiles: any) => void} */
function checkRouting(agent, profile, fullText, allProfiles) {
  // Guard null-profile (Finding #4)
  if (!profile) {
    throw new Error(`❌ GUARD: profile not found for agent "${agent}". Delegation/routing invalid.`)
  }

  // Documentation check: if the target is not doc-writer and the task is documentation, blocks.
  const docBlockingAgents = ['executor', 'debugger', 'spiker', 'sketcher']
  if (docBlockingAgents.includes(agent) && isDocumentationTask(fullText)) {
    throw new Error(
      `❌ ROUTING: Documentation task detected. Use doc-writer instead of ${agent}.\n` +
      `→ Prompt: "${fullText.substring(0, 100)}..."`
    )
  }
}

/** @type {(agent: string, profile: any, command: string) => void} */
function checkBashWhitelist(agent, profile, command) {
  // Guard null-profile: fail-closed with descriptive message (Finding #4)
  if (!profile) {
    throw new Error(`❌ GUARD: profile not found for agent "${agent}". Delegation/routing invalid.`)
  }
  if (!Array.isArray(profile.bashAllowlist)) {
    throw new Error(`❌ GUARD: bashAllowlist missing for "${agent}". Corrupted configuration.`)
  }
  if (/rm\s+-rf\s+(\/|~|\/c\/|c:\\)/i.test(command)) {
    throw new Error("❌ SECURITY: rm -rf on root/user/Windows paths is blocked.")
  }
  if (/git\s+push.*--force.*(?=\s+(main|master|develop|release\/))/i.test(command)) {
    throw new Error("❌ SECURITY: git push --force on protected branches (main/master/develop/release/*) is blocked.")
  }
  if (/git\s+add\s+-f\s+(\/|[a-zA-Z]:[\\\/])/.test(command)) {
    throw new Error("❌ SECURITY: git add -f with absolute path is blocked.")
  }
  if (destructiveSystemPatterns.some(p => p.test(command.trim()))) {
    throw new Error("❌ SECURITY: Destructive system command is blocked.")
  }

  // Agents like the verifier have bashAllowlist:["*"] to run tests/lint,
  // but by role must never mutate files. checkNeverDo/checkRouting look at
  // only the delegation prompt text, not the bash command content —
  // without this check the "fix" ban would be bypassable by executing
  // PowerShell/Python/sed directly.
  if (profile.readOnlyDespiteFullBash) {
    const mutationMatch = shellMutationPatterns.find(p => p.test(command))
    const isTempScratch = tempDirMarkers.some(p => p.test(command))
    if (mutationMatch && !isTempScratch) {
      throw new Error(
        `❌ SHELL MUTATION: "${agent}" has a validation-only role — bash command that modifies files blocked.\n` +
        `Command: ${command.substring(0, 150)}\n` +
        `→ If you need a correction, delegate to executor.`
      )
    }
  }

  // The executor implements, doesn't certify its own work: test execution
  // test execution is the job of the verifier (or tester to write them). Without this
  // check, executor with bashAllowlist:["*"] could launch the test suite
  // by itself and declare itself done, bypassing the independent validation that
  // the executor→verifier flow is designed to ensure.
  if (profile.noTestExecution) {
    const testMatch = testExecutionPatterns.find(p => p.test(command))
    if (testMatch) {
      throw new Error(
        `❌ TEST EXECUTION: "${agent}" cannot execute tests — validation is the job of the verifier.\n` +
        `Command: ${command.substring(0, 150)}\n` +
        `→ Complete the implementation and delegate to verifier for test execution.`
      )
    }
  }

  const allowlist = profile.bashAllowlist ?? []
  if (allowlist.length === 0) {
    throw new Error(`❌ BASH: ${profile.role} (${agent}) cannot execute bash (total deny).`)
  }
  if (allowlist[0] === '*') return

  const trimmed = command.trim()
  const matches = allowlist.some(pattern => {
    const regexStr = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
    return new RegExp(regexStr, 'i').test(trimmed)
  })
  if (!matches) {
    throw new Error(
      `❌ BASH: command not in allowlist for ${agent}.\n` +
      `→ Allowed commands: ${allowlist.join(', ')}\n` +
      `→ Executed: ${trimmed.substring(0, 60)}`
    )
  }
}

/** @type {(agent: string, profile: any, url: string, prompt: string, auditLog?: any[]) => void} */
function checkWebfetch(agent, profile, url, prompt, auditLog) {
  // Guard null-profile: fail-closed with descriptive message (Finding #4)
  if (!profile) {
    throw new Error(`❌ GUARD: profile not found for agent "${agent}". Delegation/routing invalid.`)
  }
  // M3 dedup (REV-02, 2026-09-10): the URL schema check (http/https only)
  // used to live here AND in the dispatcher. The dispatcher check runs FIRST
  // for every identity branch (orchestrator/unknown/profile) — the only
  // call site of this function — so the duplicate here was unreachable
  // dead logic. Removed along with its 'invalid_url_schema' audit entry,
  // which was write-only (pushed right before a throw; the dispatcher only
  // persists audit entries when no error was raised).
  const hasExplicitRequest = !!(prompt && /explicit user webfetch request/i.test(prompt))
  const willAllow = profile.canWebfetch === true || hasExplicitRequest
  if (Array.isArray(auditLog)) {
    auditLog.push({
      agent,
      url,
      prompt: prompt?.substring(0, 100),
      timestamp: Date.now(),
      allowed: willAllow,
      reason: willAllow
        ? (profile.canWebfetch === true ? 'canWebfetch=true' : 'explicit_user_request')
        : 'no_explicit_request'
    })
  }
  if (profile.canWebfetch === true) return
  if (hasExplicitRequest) return
  throw new Error(
    `❌ WEBFETCH: ${agent} not authorized to fetch external resources.\n` +
    `→ Profile: ${profile.role}\n` +
    `→ URL: ${url}\n` +
    `→ Add "explicit webfetch user request" to the prompt to allow.`
  )
}

/** @type {(caller: string, callerProfile: any, target: string, allProfiles: any) => void} */
function checkTaskSubDelegation(caller, callerProfile, target, allProfiles) {
  // Guard null-profile: fail-closed with descriptive message (Finding #4)
  if (!callerProfile) {
    throw new Error(`❌ GUARD: profile not found for caller "${caller}". Delegation/routing invalid.`)
  }
  if (!allProfiles[target]) {
    throw new Error(`❌ SUB-DELEGATION: target "${target}" is not a known agent.`)
  }
  const allowed = callerProfile.canDelegateTo ?? []
  if (allowed.length === 0) {
    throw new Error(`❌ SUB-DELEGATION: ${caller} cannot delegate (canDelegateTo is empty).`)
  }
  if (allowed[0] === '*') return
  if (!allowed.includes(target)) {
    throw new Error(
      `❌ SUB-DELEGATION: ${caller} cannot delegate to ${target}.\n` +
      `→ Can delegate to: ${allowed.join(', ')}`
    )
  }
}

// ============================================
// CHECK A — Anti-exfiltration of secrets (post-tool output)
// ============================================

/**
 * Check A — Scans tool output for secrets/credentials patterns.
 * If a SECRET is FOUND → throw with a redacted message + audit log.
 *
 * Trusted agents (explicit `trustedForSecrets: true` in guard-config.json,
 * e.g. executor, spiker) are skipped because they legitimately manage
 * secrets (commit, env setup, etc.). REV-09 (2026-09-10): trust is NEVER
 * derived from other capabilities (previously canDelegateTo:["*"] implied
 * the skip — a permissive custom agent would have inherited the exemption
 * without being really trusted); it is an explicit per-agent config flag,
 * and the M2 safety-net fallback does NOT set it (no trusted agent without
 * config).
 *
 * PURE function, reusable in any context (even tool.execute.before
 * for preliminary check). In the `tool.execute.after` hook it is called in
 * try/catch because the after hook cannot block in OpenCode.
 *
 * @param {unknown} output - Output of the tool (string, object, or any serializable type)
 * @param {string} subagent - Name of the subagent
 * @param {any} profile - Agent profile (optional, but mandatory for fail-closed)
 * @param {any[]} [auditLog] - Optional array to push detection records into
 * @param {string} [filePath] - Path of the file read (if applicable), for exclusion of log/lessons of the Guard
 * @throws {Error} if profile is missing or if a secret is found
 */
function checkSecretsInOutput(output, subagent, profile, auditLog, filePath) {
  if (!output) return
  if (!profile) {
    throw new Error(`❌ GUARD: profile missing for checkSecretsInOutput (subagent: ${subagent})`)
  }
  // Trusted agents → skip. REV-09 (2026-09-10): trust is EXPLICIT per-agent
  // config (`trustedForSecrets: true` in guard-config.json), never derived
  // from other capabilities. The old derivation from canDelegateTo:["*"]
  // granted the exemption to any permissive custom agent without a real
  // trust decision. The M2 fallback never sets the flag → fail-closed.
  if (profile.trustedForSecrets === true) return
  // Guard log/lesson files → skip (path mentions, not real secrets)
  if (isSecretScanExcluded(filePath)) return

  const text = typeof output === 'string' ? output : JSON.stringify(output)
  if (!text) return

  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex (regexes with /g flag are stateful)
    pattern.regex.lastIndex = 0
    const matches = text.match(pattern.regex)
    if (matches && matches.length > 0) {
      if (Array.isArray(auditLog)) {
        auditLog.push({
          subagent,
          pattern: pattern.name,
          severity: pattern.severity,
          matchCount: matches.length,
          timestamp: Date.now()
        })
      }
      throw new Error(
        `❌ "EXFILTRATION: detected ${pattern.name} (${matches.length} occurrences) in output for agent "${subagent}". ` +
        `Redacted output for safety.`
      )
    }
  }
}

/**
 * Check C — Blocks access to sensitive files
 * via read/grep/glob. Fail-closed by default.
 *
 * Exception: agents with `bashAllowlist: ["*"]` (full bash, e.g. executor)
 * can access these files if explicitly necessary.
 *
 * PURE function, normalizes Windows backslash to forward slash for consistent matching.
 *
 * REV-05 (2026-09-11): the `profile` parameter has been removed — the body
 * never read it, and its presence invited per-profile exceptions back
 * (removed three times, see the comment below). Sensitive-file enforcement
 * is agent-blind by design: NO profile can opt out.
 *
 * @param {string} agent - Agent name (e.g. 'debugger')
 * @param {string|null|undefined} filePath - Path of the file or pattern to check
 * @param {string} toolName - Tool attempting access ('read', 'grep', 'glob')
 * @throws {Error} if the file matches a SENSITIVE_FILE_PATTERNS
 */
function checkSensitiveFileAccess(agent, filePath, toolName) {
  if (!filePath || typeof filePath !== 'string') return

  // NO exception for bashAllowlist:["*"]. This exception had already been
  // removed twice (original design + 07-23 refactor) and for the third time
  // came back (probably due to a misaligned file checkpoint after
  // the container reset on 2026-07-28) — confirmed with an isolated test that
  // showed an 'executor' agent completely bypassing the block on .env.
  // Sensitive files must not be readable/writable by ANY agent,
  // regardless of its bash permissions. If this line reappears AGAIN,
  // the problem is in the file synchronization process, not in the code.

  // Normalize Windows backslash → forward slash
  const normalized = filePath.replace(/\\/g, '/')

  for (const pattern of SENSITIVE_FILE_PATTERNS) {
    if (pattern.name === 'secrets_directory' && isNodeModulesPath(normalized)) continue
    // Reset lastIndex (regex with /i and /g flags are stateful)
    pattern.regex.lastIndex = 0
    if (pattern.regex.test(normalized)) {
      throw new Error(
        `❌ SENSITIVE FILE: sensitive file access blocked for agent "${agent || 'unknown'}". ` +
        `Tool: ${toolName}, File: ${filePath}, Pattern: ${pattern.name}, Severity: ${pattern.severity}`
      )
    }
  }
}

/**
 * Internal helper (not exported) — Common validation of the path zone for edit/write.
 * DRY: used by checkEditPath and checkWritePath to avoid duplication.
 *
 * Pipeline of checks (fail-closed, throw on first error):
 *   1. Guard null-agent (Finding #4)
 *   2. Path normalization (Windows backslash, ./ prefix, ../ traversal)
 *   3. Explicit path traversal check
 *   4. Forbidden zone check (node_modules, .git, dist, build)
 *   5. Project containment check (skip if _projectDirectory is unreliable)
 *
 * @param {string} agent - Agent name (e.g. 'executor')
 * @param {string} filePath - Path to validate
 * @param {'edit'|'write'} opType - Operation type (for error message)
 */
function validatePathZone(agent, filePath, opType) {
  if (!agent || typeof agent !== 'string') {
    throw new Error(`❌ GUARD: invalid agent in check${opType === 'edit' ? 'Edit' : 'Write'}Path. Delegation/routing invalid.`)
  }
  // Guard on filePath (Bug #1): without this, `filePath=null` gets normalized
  // to '' by normalizePathForCheck and all subsequent checks pass (fail-OPEN).
  if (!filePath || typeof filePath !== 'string') {
    throw new Error(`❌ GUARD: invalid filePath for agent "${agent}" in ${opType}. Received: ${JSON.stringify(filePath)}`)
  }
  const normalized = normalizePathForCheck(filePath)
  if (normalized.startsWith('..') || /^\.\.(\/|\\)/.test(filePath || '')) {
    throw new Error(`❌ PATH TRAVERSAL: ${filePath} is not permitted.`)
  }
  if (/^(node_modules|\.git|dist|build)\//i.test(normalized)) {
    throw new Error(`❌ PATH: ${opType} on ${filePath} is blocked (forbidden zone).`)
  }
  // FIX (2026-08-15): the Guard's audit trail (.planning/audit/*.jsonl,
  // .planning/INCIDENTS.md, .opencode/metrics_count.json) was not in any
  // forbidden zone — any agent with edit/write in the project (e.g. executor,
  // writeScope 'all') could modify or delete its own audit trail.
  // NOTE: .planning/ as a whole remains writable (explorer has
  // writeScope 'planning' by design), only audit/ and INCIDENTS.md are protected.
  if (/^\.planning\/audit\//i.test(normalized) ||
      /^\.planning\/incidents\.md$/i.test(normalized) ||
      /^\.opencode\/metrics_count\.json$/i.test(normalized)) {
    throw new Error(`❌ PATH: ${opType} on ${filePath} is blocked — Guard audit trail, not modifiable by any agent.`)
  }
  // Project containment check. OpenCode sometimes passes directory=plugins\
  // as project directory (see session on 2026-07-12) — _projectDirectory in that
  // case is not reliable as a containment root.
  //
  // FIX (2026-08-15): the old code SKIPPED containment entirely
  // when _projectDirectory was unreliable — no other check here stops an
  // absolute path outside the project (the "PATH TRAVERSAL" check above only catches
  // initial "../", not an absolute path elsewhere), so in that scenario
  // edit/write on ANY file on the filesystem passed without any block.
  // Now, if _projectDirectory is unreliable, we use `worktree` (passed from
  // the OpenCode factory, typically the real git worktree root) as the root
  // of fallback before giving up entirely.
  const projectRoot = isReliableProjectRoot(_projectDirectory)
    ? _projectDirectory
    : (isReliableProjectRoot(_worktree) ? _worktree : '')
  if (projectRoot) {
    const resolvedPath = path.resolve(filePath);
    const resolvedProject = path.resolve(projectRoot);
    if (!resolvedPath.startsWith(resolvedProject + path.sep) &&
        resolvedPath !== resolvedProject) {
      throw new Error(
        `❌ PATH OUT OF PROJECT: ${filePath} is outside the project directory.\n` +
        `→ Project: ${resolvedProject}\n` +
        `→ Resolved path: ${resolvedPath}\n` +
        `→ Use a relative path inside the project.`
      );
    }
  }
}

/**
 * A project root candidate is "reliable" if it is not empty and does not point
 * into `.opencode` or `plugins` — the same two contexts where OpenCode is
 * known to pass the wrong directory (see comment in validatePathZone).
 * @param {string} dir
 * @returns {boolean}
 */
function isReliableProjectRoot(dir) {
  if (!dir) return false
  return !dir.endsWith(path.sep + '.opencode') &&
    !dir.includes(path.sep + '.opencode' + path.sep) &&
    !dir.endsWith(path.sep + 'plugins') &&
    !dir.includes(path.sep + 'plugins' + path.sep)
}

/**
 * Check 10 — Edit path enforcement.
 * Normalizes the path (handles Windows backslash, ./ prefix, ../ traversal)
 * BEFORE checking forbidden zones. Fail-closed on explicit path traversal.
 *
 * @param {string} agent - Agent name (e.g. 'executor')
 * @param {string} filePath - Path of the file to edit
 */
function checkEditPath(agent, filePath) {
  // FIX (2026-07-25): the sensitive pattern scan was entirely missing for edit —
  // only read/grep/glob had it (line ~932). An agent with allowEdit:true
  // could overwrite .env/SSH keys/credentials without any block, as long as
  // the path was inside the project (validatePathZone doesn't care, it checks
  // only project boundaries, not the sensitive content of the path).
  checkSensitiveFileAccess(agent, filePath, 'edit')
  validatePathZone(agent, filePath, 'edit')
}

/** Agents with writeScope restricted to throwaway folders, and their pattern/label. */
const RESTRICTED_WRITE_SCOPE_AGENTS = {
  sketcher: { pattern: /^(sketches|mockups|prototypes)\//i, label: 'sketches/, mockups/, prototypes/' },
  spiker: { pattern: /^(spikes|experiments|prototypes|tmp|sandbox)\//i, label: 'spikes/, experiments/, prototypes/, tmp/, sandbox/' }
}

/**
 * Tracks repeated attempts by a restricted-writeScope agent to write
 * OUTSIDE its own scope, on the SAME normalized path. On the 2nd repetition
 * of the same target, replaces the generic SCOPE error with a routing error
 * stronger — signal that it is not a real throwaway/prototype (an error
 * isolated/typo never repeats the same exact path twice), but of an attempt
 * insisting on passing real work through a permissive agent.
 *
 * Validated via simulation on realistic scenarios before implementation
 * (self-correction, isolated typos on different paths, long sessions with multiple spikes
 * separate, evasion via "facade success" between two attempts) — 0 false
 * positives/negatives except for one ambiguous case by design (same exact typo repeated
 * 2 times), acceptable because the cost of a false positive is only a message of
 * redirect, not a permanent block.
 *
 * @param {string} agent
 * @param {string} filePath
 * @param {Record<string, number>} scopeViolationTargets - state.scopeViolationTargets of the session
 * @param {string} baseMessage - original error message (1st attempt)
 * @throws {Error} always — base message on 1st attempt, escalation from 2nd
 */
function throwOrEscalateScopeViolation(agent, filePath, scopeViolationTargets, baseMessage) {
  const key = agent + '::' + normalizePathForCheck(filePath)
  const count = (scopeViolationTargets[key] || 0) + 1
  scopeViolationTargets[key] = count
  if (count >= 2) {
    throw new Error(
      `❌ ROUTING: ${agent} has already attempted ${count} times to write "${filePath}" (outside their own writeScope).\n` +
      `→ Is not a throwaway/prototype — redelegate to executor with domain:implementation.`
    )
  }
  throw new Error(baseMessage)
}

/**
 * Check 10+11 — Write path enforcement.
 * Normalizes the path (handles Windows backslash, ./ prefix, ../ traversal)
 * BEFORE checking forbidden zones. Fail-closed on explicit path traversal.
 *
 * @param {string} agent - subagent_type (e.g. 'executor')
 * @param {string} filePath - path of the target file
 * @param {boolean} exists - true if the file already exists, false if it's new
 * @param {Record<string, number>} [scopeViolationTargets] - state.scopeViolationTargets of the session (only for agents with restricted writeScope)
 * @throws {Error} if write to an existing file is not allowed
 */
function checkWritePath(agent, filePath, exists, scopeViolationTargets) {
  // FIX (2026-07-25): same hole as checkEditPath — missing pattern scan
  // for sensitive files on write.
  checkSensitiveFileAccess(agent, filePath, 'write')

  const restriction = RESTRICTED_WRITE_SCOPE_AGENTS[agent]

  try {
    validatePathZone(agent, filePath, 'write')
  } catch (err) {
    if (restriction && scopeViolationTargets) {
      throwOrEscalateScopeViolation(agent, filePath, scopeViolationTargets, err.message)
    }
    throw err
  }

  if (exists && !/\.(log|tmp|bak)$/i.test(filePath)) {
    throw new Error(
      `❌ WRITE: write to existing file (${filePath}) blocked — use "edit" for existing files.\n` +
      `→ Exceptions: *.log, *.tmp, *.bak`
    )
  }

  if (restriction) {
    // Bug #2 fix: normalize path (removes ./, \ → /) and use /i flag for case-insensitive
    const normalizedScope = normalizePathForCheck(filePath)
    if (!restriction.pattern.test(normalizedScope)) {
      const baseMessage = `❌ SCOPE: ${agent} can only write to ${restriction.label}.\n→ Path: ${filePath}`
      if (scopeViolationTargets) {
        throwOrEscalateScopeViolation(agent, filePath, scopeViolationTargets, baseMessage)
      }
      throw new Error(baseMessage)
    }
  }
}
