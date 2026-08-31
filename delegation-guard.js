// @ts-check
import path from 'node:path'
import os from 'node:os'
import { appendFileSync, existsSync, mkdirSync, writeFileSync, readFileSync, statSync, renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'


let _projectDirectory = ''
/** Fallback per il containment check quando _projectDirectory è inaffidabile (vedi validatePathZone). */
let _worktree = ''

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const runtimeLogPath = path.join(__dirname, 'delegation-guard-runtime.log')

// ============================================
// CONFIG LOADING — reso resiliente per contesti ESM
// ============================================
// Cache globale: una volta caricato, non viene riletto.
// Il caricamento è spostato nella factory (dove project/directory sono disponibili).
/** @type {Record<string, any> | null} */
let _cachedAgentProfiles = null
/** Path del file di config esterno attualmente in cache (per rilevamento modifiche runtime) */
let _cachedConfigSource = null
/** mtimeMs del file di config al momento del caching (per invalidazione automatica) */
let _cachedConfigMtime = null
/** Timestamp dell'ultimo controllo del file di config su disco (per throttling) */
let _lastConfigCheckTime = 0

/**
 * Merge profondo: sovrascrive i valori di `source` su `target`.
 * - Oggetti ricorsivi
 * - Array sostituiti (non concatenati) — comportamento atteso per allowlist, neverDo, ecc.
 * - Primitivi sovrascritti
 *
 * @param {Record<string, any>} target
 * @param {Record<string, any>} source
 * @returns {Record<string, any>} target mutato
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
 * Prova a leggere guard-config.json da più posizioni possibili.
 * Ordine: 1) path relativo a project directory, 2) path assoluto (__dirname).
 *
 * @param {string | undefined} projectDir - directory del progetto (da OpenCode factory)
 * @returns {{ profiles: Record<string, any>, source: string } | null}
 */
function tryLoadGuardConfig(projectDir) {
  const candidates = [
    // 1. Relativo alla project directory (il più affidabile in ESM)
    ...(projectDir ? [path.join(projectDir, '.opencode', 'plugins', 'guard-config.json')] : []),
    // 2. Relativo a plugins se project dir è la root
    ...(projectDir ? [path.join(projectDir, 'plugins', 'guard-config.json')] : []),
    // 3. Assoluto accanto al plugin stesso (__dirname)
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
      // Continua con il prossimo candidato
    }
  }
  return null
}

/**
 * Carica e cache i profili agente.
 * Se il caricamento esterno fallisce, usa il fallback e logga l'errore.
 * Se il caricamento esterno ha successo, fa merge profondo del fallback
 * (preservando neverDo, keywords, allowMentions del fallback)
 * poi sovrascrive con i valori esterni espliciti.
 *
 * @param {string | undefined} projectDir
 * @returns {Record<string, any>}
 */
function loadAgentProfiles(projectDir) {
  // Se la cache è popolata, verifica se il file di config su disco è cambiato.
  // Invalidazione automatica basata su mtime: se guard-config.json viene
  // modificato a runtime, i profili vengono ricaricati senza riavviare il processo.
  if (_cachedAgentProfiles) {
    // Cache da fallback (nessun file esterno): nessun reload necessario.
    if (!_cachedConfigSource) return _cachedAgentProfiles

    // Throttling: effettua il controllo su disco al massimo una volta ogni 5 secondi (5000ms)
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
        runtimeLog(`Guard config modificato (mtime ${_cachedConfigMtime} → ${mtime}) — ricarico da ${_cachedConfigSource}`)
      } else {
        // File rimosso: forza reload (tornerà al fallback se non trovato altrove)
        runtimeLog(`Guard config rimosso (${_cachedConfigSource}) — ricarico`)
      }
    } catch (e) {
      runtimeLog(`Cache mtime check failed: ${e.message} — mantengo cache`)
      return _cachedAgentProfiles
    }
    // mtime cambiato (o file rimosso): invalida la cache e ricarica sotto
    _cachedAgentProfiles = null
    _cachedConfigSource = null
    _cachedConfigMtime = null
  }

  const fallback = createAgentProfilesFallback()
  const external = tryLoadGuardConfig(projectDir)

  if (!external) {
    console.error('[Guard] guard-config.json non trovato in nessuna posizione — usando fallback hardcoded')
    _cachedAgentProfiles = fallback
    _cachedConfigSource = null
    _cachedConfigMtime = null
    return _cachedAgentProfiles
  }

  // Merge profondo: fallback come base, esterno sovrascrive i campi espliciti.
  // Questo preserva neverDo/keywords/allowMentions del fallback quando
  // il config esterno non li definisce (es. codebase-mapper nel config esterno).
  for (const agentKey of Object.keys(fallback)) {
    if (external.profiles[agentKey]) {
      deepMerge(fallback[agentKey], external.profiles[agentKey])
    }
  }
  // Aggiungi eventuali agenti presenti solo nell'esterno
  for (const agentKey of Object.keys(external.profiles)) {
    if (!fallback[agentKey]) {
      fallback[agentKey] = external.profiles[agentKey]
    }
  }

  runtimeLog(`Guard config caricato da: ${external.source} (merge con fallback)`)
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
    const timestamp = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' })
    appendFileSync(runtimeLogPath, `[${timestamp}] ${message}\n`, 'utf8')
  } catch (e) {
    // Diagnostic logging must never affect the guard.
  }
}

runtimeLog('DelegationGuard module loaded')

/**
 * Rileva se la combinazione lastAgent/targetAgent è un ciclo verifier ↔ executor legittimo.
 * Usato sia nell'anti-loop (checkDelegationLoop) che nel gate sub-delegation del task handler.
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
 * Architettura del guard (modularizzata):
 *  - tool.execute.before → dispatcher unico, instrada su input.tool
 *    ├── input.tool === "task"        → 6 check delega inline + check 9
 *    ├── input.tool === "bash"        → checkBashWhitelist()
 *    ├── input.tool === "webfetch"    → checkWebfetch()
 *    ├── input.tool === "edit"        → checkEditPath()
 *    └── input.tool === "write"       → checkWritePath()
 *  - event → session.created (init state), session.idle (placeholder)
 *
 * NOTA: OpenCode espone nativamente solo `tool.execute.before` come hook per
 * tutti i tool. Il "dispatching per tool" avviene internamente su `input.tool`.
 * I test eseguono le singole funzioni di check (named exports) senza passare
 * per il wrapper Plugin.
 */

// ============================================
// COSTANTI E UTILITIES (top-level per testabilità)
// ============================================

/** Max sessions to keep in memory to prevent growth without bound (Capability F) */
const MAX_SESSIONS = 100

/**
 * Tool che l'Orchestratore non può MAI usare direttamente, a prescindere da fase
 * o identità — deve sempre delegare. Fonte unica condivisa da check 2.5 (blocco
 * assoluto) e check 5 (fase pre-delegation, riga ~1138): prima erano due liste
 * separate (una allowlist fissa nel check 5) — un tool MCP dinamico non
 * enumerato in nessuna delle due (es. `supabase_apply_migration`, o qualsiasi
 * `mcp__*`) veniva bloccato in fase pre-delegation anche se legittimo, perché
 * l'allowlist non poteva conoscere in anticipo ogni tool MCP configurabile.
 * @type {string[]}
 */
const FORBIDDEN_ORCHESTRATOR_TOOLS = ['glob', 'grep', 'read', 'sequential-thinking_sequentialthinking', 'bash', 'edit', 'write']

/**
 * Tool nativi di OpenCode (non MCP) che il dispatcher riconosce o che sono
 * comunque parte del set base indipendentemente dal server MCP configurato.
 * Usata SOLO per l'osservabilità 2.4 (log dei tool MCP sconosciuti) — non è un
 * confine di sicurezza, può restare imprecisa senza creare un bypass.
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
 * Ritorna un timestamp ISO 8601 in tempo locale (es. YYYY-MM-DDTHH:mm:ss.sss+HH:MM)
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
  { regex: /git\s+add\s+-f/i, message: "❌ SICUREZZA: git add -f non è consentito." },
  { regex: /rm\s+-rf/i, message: "❌ SICUREZZA: rm -rf non è consentito." },
  { regex: /git\s+push.*--force/i, message: "❌ SICUREZZA: git push --force non è consentito." }
]

/** @type {RegExp[]} */
// Pattern distruttivi di sistema: del/rmdir/rd con flag /S /Q (ricorsivo+quiet)
// Finding #5: estratto in array per coprire varianti (C:, C:\, C:\*, path Unix)
const destructiveSystemPatterns = [
  /^(format|diskpart)\b/i,                                  // format / diskpart
  /del\s+\/s\s+\/q\s+[a-zA-Z]:\\?(\*)?$/i,                 // del /S /Q C:, del /S /Q C:\, del /S /Q C:\*
  /del\s+\/s\s+\/q\s+\//i,                                  // del /S /Q su path Unix
  /rmdir\s+\/s\s+\/q\s+[a-zA-Z]:/i,                         // rmdir /S /Q C:
  /rd\s+\/s\s+\/q\s+[a-zA-Z]:/i                             // rd /S /Q C:
]

/**
 * Pattern per rilevare comandi bash che MUTANO file (scrittura/modifica/cancellazione),
 * usati per bloccare agenti con bashAllowlist:["*"] ma che per ruolo non devono
 * mai modificare codice (es. verifier). Il tool `bash` non passa da checkNeverDo/
 * checkRouting (quelli guardano solo il testo del prompt di delega), quindi senza
 * questo check un agente "read-only" potrebbe aggirare il divieto di fix eseguendo
 * PowerShell/Python/sed direttamente invece di usare edit/write (tool che comunque
 * non possiede).
 * @type {RegExp[]}
 */
const shellMutationPatterns = [
  // PowerShell — scrittura/modifica/cancellazione file
  /\bSet-Content\b/i,
  /\bAdd-Content\b/i,
  /\bOut-File\b/i,
  /\bClear-Content\b/i,
  /\bRemove-Item\b/i,
  /\bRename-Item\b/i,
  /\bMove-Item\b/i,
  /\bNew-Item\b.*-ItemType\s+File/i,
  // .NET diretto — bypassa i cmdlet PowerShell "nominati" sopra (Set-Content,
  // ecc.) chiamando le API .NET File/Directory direttamente. Incidente reale
  // 2026-08-14: "debugger" (readOnlyDespiteFullBash) ha scritto un file via
  // [System.IO.File]::WriteAllText() — nessun pattern lo copriva, comando
  // passato come se fosse read-only. Copre sia il tipo completo che
  // l'accelerator corto ([IO.File] / [IO.Directory]).
  /\[(?:System\.IO\.|IO\.)?File\]::(WriteAllText|WriteAllLines|WriteAllBytes|AppendAllText|AppendAllLines|Copy|Move|Delete|Replace|Encrypt)\s*\(/i,
  /\[(?:System\.IO\.|IO\.)?Directory\]::(CreateDirectory|Delete|Move)\s*\(/i,
  // NOTA: rimosso il pattern generico di redirection (>/>>). Falsi positivi
  // troppo frequenti: qualsiasi script Python/JS che fa parsing di HTML/XML
  // con regex contiene `>` per motivi estranei alla shell (es. `[^>]*>` per
  // matchare la chiusura di un tag). I pattern nominati sotto (Set-Content,
  // Add-Content, Out-File, open(...,'w'), .write(), sed -i, fs.writeFileSync)
  // coprono già l'exploit reale con precisione, senza questo costo collaterale.
  // Python — scrittura file
  /open\(\s*['"][^'"]*['"]\s*,\s*['"][waWA]/,
  /\.write\(/,
  /\.writelines\(/,
  // Node — scrittura file
  /fs\.writeFileSync/,
  /fs\.appendFileSync/,
  /fs\.unlinkSync/,
  /fs\.rmSync/,
  // Unix — modifica/cancellazione in-place
  /\bsed\s+-i\b/,
  /\btee\b/,
  /^\s*rm\s/,
  /^\s*del\s/i,
]

/**
 * Marcatori di cartelle temporanee/scratch. Usati per esentare dal blocco
 * "shell mutation" gli agenti readOnlyDespiteFullBash quando scrivono SOLO
 * in una cartella temp (es. script di supporto per la propria analisi),
 * non nel progetto sotto revisione. Il verifier ha comunque bash pieno,
 * quindi scrivere un file temp non gli dà nessun potere che non abbia già —
 * gli evita solo di dover impacchettare tutto in un one-liner scomodo.
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
 * Pattern per rilevare comandi bash che ESEGUONO suite di test. Usati per
 * bloccare l'esecuzione diretta di test da parte di agenti che non devono
 * validare il proprio lavoro (executor) — l'intero flusso executor→verifier
 * esiste apposta perché la validazione sia fatta da qualcun altro, non da chi
 * ha appena scritto il codice. Senza questo check, executor (bashAllowlist:
 * ["*"]) poteva lanciare npm test/pytest/jest ecc. e "certificarsi da solo".
 * Non blocca verifier/debugger/spiker: hanno motivi legittimi (validazione,
 * riproduzione di un fallimento per diagnosi, prototipazione isolata).
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
  // FIX (2026-08-25): jest/mocha/pytest/rspec/phpunit erano pattern "nudi"
  // (\bTOOL\b) — matchavano il nome del tool ovunque nella stringa, incluso
  // dentro un nome file (jest.setup.js, pytest.ini, phpunit.xml, mocha.opts
  // sono nomi di file reali e comuni). Incidente reale: `git add ... jest.setup.js`
  // bloccato come se fosse un'esecuzione di test. Richiesta posizione di comando
  // (inizio stringa o dopo &&/;/|), ma un `|` SENZA spazio prima del tool è quasi
  // sempre alternanza regex dentro una stringa tra virgolette, non un vero pipe
  // di shell — secondo incidente reale: `Select-String -Pattern "...|jest|..."`
  // (ricerca testuale della parola "jest", non un'esecuzione) ribloccato per lo
  // stesso motivo. Ora l'operatore deve essere seguito da ALMENO uno spazio
  // prima del nome del tool — un'alternanza regex tra virgolette non ha mai
  // spazi attorno ai `|` (romperebbe il significato del pattern), un'invocazione
  // reale dopo &&/;/| quasi sempre sì.
  /(?:^\s*|(?:&&|;|\|)\s+)jest\b/i,
  /(?:^\s*|(?:&&|;|\|)\s+)mocha\b/i,
  /(?:^\s*|(?:&&|;|\|)\s+)pytest\b/i,
  /(?:^\s*|(?:&&|;|\|)\s+)rspec\b/i,
  /(?:^\s*|(?:&&|;|\|)\s+)phpunit\b/i,
]

/** @type {{regex: RegExp, message: string}[]} */
const sshLocalPatterns = [
  { regex: /ssh.*(?:localhost|127\.0\.0\.1|locale)/i, message: "❌ SSH: Comando locale non richiede SSH." },
  { regex: /(?:git|npm|yarn|pnpm|bun)\s+(?:pull|push|status|add|commit|diff).*ssh/i, message: "❌ SSH: Git/npm comandi locali non usano SSH." }
]

/**
 * Pattern per il check A (anti-esfiltrazione secrets).
 * Scandagliati nell'output di ogni tool eseguito da un subagent non-trusted.
 * Severity: critical | high | medium
 *
 * NOTA: regex con flag /g → stateful, devono essere ricreati o resettati
 * (viene usato String.match che non ha il problema lastIndex).
 *
 * @type {{name: string, regex: RegExp, severity: 'critical'|'high'|'medium'}[]}
 */
const SECRET_PATTERNS = [
  // GitHub PAT: ghp_ + almeno 30 caratteri alfanumerici (formato reale: ghp_ + 36, ma accettiamo 30+ per robustezza)
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
  // Aggiunti 2026-08-15 — coverage mancante segnalata: OpenAI, Slack, Google.
  // Soglie di lunghezza scelte per evitare falsi positivi su parole/identificatori
  // comuni che iniziano con lo stesso prefisso (es. "sk-" da solo è troppo corto,
  // richiede 32+ caratteri come una vera chiave OpenAI classica da 48).
  { name: 'OpenAI API key', regex: /sk-[a-zA-Z0-9]{32,}/g, severity: 'critical' },
  { name: 'Slack token', regex: /xox[baprs]-[a-zA-Z0-9-]{10,}/g, severity: 'critical' },
  { name: 'Google API key', regex: /AIza[0-9A-Za-z_\-]{35}/g, severity: 'critical' }
]

/**
 * File di log/lezioni auto-scritti dal Guard o dall'orchestratore.
 * Contengono MENZIONI testuali di path sensibili come esempio storico
 * (es. "File: cartella .ssh, chiave id_rsa, Pattern: ssh_keys" in un log di blocco passato),
 * non secret reali. Esclusi da checkSecretsInOutput per evitare falsi positivi
 * quando un agente li rilegge (bug 08-08: lessons.md redatto 2 volte per
 * "Generic private key path" pur non contenendo alcuna chiave).
 * @type {string[]}
 */
const SECRET_SCAN_EXCLUDED_FILES = [
  'lessons.md',
  'delegation-guard-runtime.log',
  'guard-debug.jsonl',
  'guard-init.log',
  'incidents.md',
  // File sorgente del Guard stesso (bug 2026-08-15): delegation-guard.js contiene
  // ESEMPI TESTUALI di path/pattern sensibili nei propri commenti/JSDoc (per
  // documentare cosa i pattern rilevano) — quegli esempi matchano i pattern che
  // descrivono, causando la redazione dell'intero file quando un agente lo legge
  // per diagnosi/review. Nomi specifici del plugin, non generici (niente
  // "readme.md": in un progetto qualsiasi un README reale potrebbe contenere un
  // secret vero e non va escluso automaticamente).
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
 * Pattern per il check C (sensitive file access).
 * Blocca read/grep/glob su file che contengono credenziali.
 *
 * @type {{name: string, regex: RegExp, severity: 'critical'|'high'|'medium'}[]}
 */
const SENSITIVE_FILE_PATTERNS = [
  // Matcha: .env, .env.local, .env.development, test.env, production.env, config.env, ecc.
  // FIX (2026-08-25): esclusi i suffissi placeholder convenzionali senza secret
  // reali (.env.example, .env.sample, .env.template, .env.dist, .env.defaults) —
  // segnalato dall'utente: bloccavano la normale lettura/modifica di file che
  // documentano solo QUALI variabili esistono, mai valori reali. Altri suffissi
  // (.env.local, .env.production, ecc.) restano bloccati — potrebbero contenere
  // valori reali.
  { name: 'env_files', regex: /(^|\/|\\)\.env(?!\.(example|sample|template|dist|defaults)$)(\.[a-zA-Z0-9_-]+)?$|\.env$/i, severity: 'critical' },
  { name: 'ssh_keys', regex: /(^|\/|\\)\.ssh[\/\\]id_[a-zA-Z0-9_-]+$/, severity: 'critical' },
  // FIX (2026-08-15): il pattern sopra richiede il prefisso ".ssh/" — un comando
  // che costruisce il path in pezzi (es. PowerShell Join-Path, o un token
  // separato in un glob) può riferirsi al file per nome bare ("id_rsa") senza
  // mai produrre un token contiguo ".ssh/id_rsa". Whitelist esplicita dei nomi
  // OpenSSH standard (non un generico "id_*" — "id_token" da solo è un termine
  // OIDC/OAuth comunissimo, bloccarlo genererebbe falsi positivi costanti).
  { name: 'ssh_key_bare_filename', regex: /(^|\/|\\)id_(rsa|dsa|ecdsa|ed25519(_sk)?|xmss)(\.pub)?([\/\\]|$)/i, severity: 'critical' },
  { name: 'ssh_private_key_path', regex: /(^|\/|\\)\.ssh[\/\\][^\/\\]+\.pem$/, severity: 'critical' },
  { name: 'aws_credentials', regex: /(^|\/|\\)\.aws[\/\\](credentials|config)$/i, severity: 'critical' },
  { name: 'gcp_credentials', regex: /(^|\/|\\)\.gcp[\/\\](credentials|application_default_credentials\.json)$/i, severity: 'critical' },
  { name: 'azure_credentials', regex: /(^|\/|\\)\.azure[\/\\][^\/\\]*credentials/i, severity: 'critical' },
  // FIX (2026-08-15): richiedeva un separatore DOPO "secrets|credentials|private"
  // (solo uso come cartella) — un file bare chiamato esattamente "credentials",
  // "secrets" o "credentials.json" (nessuna cartella genitrice nel path/pattern
  // glob) non veniva mai catturato. Ora matcha anche a fine stringa o con
  // un'estensione, restando ancorato a un confine di path prima del nome
  // (niente match parziale tipo "credentialsfile.txt" o "secretsauce.js").
  // NOTA: "private" come nome di cartella è comune in codice di terze parti non
  // legato a secret (es. React Native ships node_modules/react-native/src/private/,
  // incidente reale 2026-08-25) — vedi isNodeModulesPath() sotto, applicata dai
  // due punti che consumano questo pattern per escludere node_modules/.
  { name: 'secrets_directory', regex: /(^|\/|\\)(secrets|credentials|private)(\.[a-zA-Z0-9]+)?([\/\\]|$)/i, severity: 'high' },
  { name: 'pem_certificates', regex: /\.(pem|key|p12|pfx|jks)$/i, severity: 'high' },
  { name: 'netrc', regex: /(^|\/|\\)\.netrc$/i, severity: 'high' },
  { name: 'git_credentials', regex: /(^|\/|\\)\.git-credentials$/i, severity: 'high' },
  { name: 'npmrc_with_auth', regex: /(^|\/|\\)\.npmrc$/i, severity: 'medium' },
  { name: 'docker_config', regex: /(^|\/|\\)\.docker[\/\\]config\.json$/i, severity: 'high' }
]

/**
 * true se il path (già normalizzato a forward-slash) attraversa node_modules/.
 * Usato SOLO per escludere il pattern "secrets_directory" — "private" in
 * particolare è un nome di cartella comune nel codice di terze parti senza
 * nulla a che fare coi secret (es. node_modules/react-native/src/private/,
 * incidente reale 2026-08-25); node_modules è codice di dipendenze installate,
 * mai i secret dell'utente.
 * @param {string} normalized
 * @returns {boolean}
 */
function isNodeModulesPath(normalized) {
  return /(^|\/)node_modules\//i.test(normalized)
}


/** @type {Record<string, {requiresAnyOf: string[], exceptions: string[], errorMessage: string}>} */
const workflowRules = {
  "executor": {
    requiresAnyOf: ["diagnosi", "debug", "analisi", "causa root", "root cause"],
    exceptions: [
      "fix approvato", "piano di fix", "post-diagnosi", "dopo debug",
      "diagnosi completata", "dopo explorer",
      // Riferimenti a file di output diagnostici reali — non frasi generiche
      "error.txt", "errors.txt", "tsc output", "tsc error",
      "lint output", "lint error", "build output", "build error",
      "attached diagnosis", "diagnosis attached",
      // Operazioni di routine — non richiedono diagnosi
      "ota", "update", "deploy", "publish", "release", "commit", "push"
    ],
    errorMessage: "❌ WORKFLOW: Fix richiede diagnosi prima. Esegui debugger o explorer."
  }
}

/**
 * Rileva se il task riguarda la scrittura/aggiornamento di documentazione.
 * @param {string} fullText - Il prompt completo
 * @returns {boolean} true se è un task di documentazione
 */
function isDocumentationTask(text) {
  if (!text || typeof text !== 'string') return false
  const writeVerbs = /(?:aggiorna|scrivi|modifica|crea|genera|edita|aggiung|rinomina|sovrascriv|replace|update|write|create|modify|edit|generate|rename|overwrite)/i
  if (!writeVerbs.test(text)) return false
  // Check 1: se il task modifica codice (.py, .js, .ts, .java, .cs, ecc.) → non è doc
  const codeFilePattern = /[\w\-./\\:]+\.(?:py|js|ts|java|cs|cpp|c|go|rs|rb|php|swift|kt|scala|ex|exs|spec|r|m|mm|pl|pm|lua|hs|sh|bash|zsh|ps1|bat|cmd|yaml|yml|json|xml|ini|cfg|toml|env|css|scss|html|htm|vue|svelte|jsx|tsx)\b/i
  if (codeFilePattern.test(text)) return false
  // Check 1b: dotfile di config senza estensione (.gitignore, .env, ecc.) → non è doc.
  // Bug 08-05: task "rimuovi X da .gitignore" menzionava anche "CLAUDE.md" come
  // riferimento testuale (non il file da editare) → matchava Check 2 e rediriggeva
  // erroneamente a doc-writer. Un dotfile di config nel testo vince su una menzione .md/.txt.
  const configDotfilePattern = /(?:^|[\s"'`/\\])\.(?:gitignore|dockerignore|eslintrc(?:\.\w+)?|prettierrc(?:\.\w+)?|editorconfig|npmrc|env(?:\.\w+)?|nvmrc|browserslistrc|babelrc|stylelintrc|huskyrc)\b/i
  if (configDotfilePattern.test(text)) return false
  // Check 2: solo se non è codice/config, verifica se sta scrivendo doc
  const docFilePattern = /[\w\-./\\:]+\.(?:md|txt)\b/i
  return docFilePattern.test(text)
}

/** @type {(agent: string, profile: any, fullText: string, allProfiles: any) => void} */
function checkDelegationRules(agent, profile, fullText, allProfiles) {
  if (!profile) {
    throw new Error(`❌ GUARD: profilo non trovato per agente "${agent}". Delega/routing non valido.`)
  }
  if (!profile.delegation_rules) {
    throw new Error(`❌ GUARD: delegation_rules mancanti per "${agent}". Configurazione corrotta.`)
  }

  // Estrae task_domain dal fullText: "domain:<nome>" o "task_domain:<nome>"
  const domainMatch = fullText.match(/\b(?:domain|task_domain)\s*:\s*([a-z_]+)/i)
  if (!domainMatch) {
    throw new Error(
      `❌ ROUTING: Dominio del task non dichiarato. Usa "domain:<nome>" nella descrizione. ` +
      `Esempi: "domain:implementation", "domain:verification", "domain:testing".`
    )
  }

  // Alias per varianti/abbreviazioni comuni che il modello usa spontaneamente
  // ma che non corrispondono al nome canonico del dominio. Aggiungere qui
  // quando emergono nuovi mismatch, invece di forzare il modello a ricordare
  // il nome esatto.
  const domainAliases = {
    'architecture': 'architecture_analysis',
    'security': 'security_audit',
  }
  const rawDomain = domainMatch[1].toLowerCase()
  const declaredDomain = domainAliases[rawDomain] || rawDomain

  const rules = profile.delegation_rules

  // Se l'agente può gestire direttamente questo dominio → OK
  if (Array.isArray(rules.can_handle_directly) && rules.can_handle_directly.includes(declaredDomain)) {
    return
  }

  // Se l'agente deve delegare per questo dominio → BLOCCA con suggerimento
  if (rules.must_delegate_to && rules.must_delegate_to[declaredDomain]) {
    const correctAgent = rules.must_delegate_to[declaredDomain]
    throw new Error(
      `❌ ROUTING: Dominio "${declaredDomain}" richiede ${correctAgent}, non ${agent}.\n` +
      `→ Aggiungi "domain:${declaredDomain}" e delega a ${correctAgent}.`
    )
  }

  // Dominio non riconosciuto per QUESTO agente — potrebbe però essere valido
  // per un altro (es. "review" è un dominio nativo di verifier, non di
  // code-reviewer, che usa invece "code_review"). Distinguere i due casi
  // evita di mostrare una lista globale fuorviante che sembra dire "va bene"
  // quando in realtà quel dominio non è mai valido per l'agente corrente.
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
      `❌ ROUTING: Dominio "${declaredDomain}" esiste ma è gestito da ${owners}, non da ${agent}.\n` +
      `→ Domini validi per ${agent}: ${Array.from(new Set(ownDomains)).sort().join(', ')}`
    )
  }

  throw new Error(
    `❌ ROUTING: Dominio "${declaredDomain}" non riconosciuto. ` +
    `Domini validi: ${Array.from(allDomains).sort().join(', ')}`
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
        `ESCALATION: Max 3 tentativi per "${agent}" (dominio: ${domain || 'sconosciuto'}). Causa: ${error.message} Intervento manuale richiesto.`
      )
    }
    throw new Error(`${error.message} RETRY: ${retryCount}/3 per ${agent} su "${domain || 'sconosciuto'}".`)
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
    // Italiano — analisi e validazione
    "proponi", "identifica", "analizza", "trova", "cerca", "spiega",
    "descrivi", "reporta", "menziona", "discuti", "valuta", "esamina",
    "indica", "suggerisci", "illustra", "diagnosticato", "trovato", "identificato",
    "verifica", "valida", "controlla", "conferma", "applica", "esegui",
    // Inglese — analysis and validation
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
 * Verifica se la delega a un targetAgent creerebbe un loop infinito.
 * 
 * Regole:
 * 1. Self-loop: Se l'ultimo elemento dello stack è uguale al target -> BLOCCA.
 * 2. Ping-pong: Se gli ultimi 2 elementi sono [A, B] e il target è A -> BLOCCA.
 * 3. Saturazione: Se lo stesso agente appare >= 3 volte negli ultimi 5 step -> BLOCCA.
 * 4. Profondità: Se currentStack.length >= 5 -> BLOCCA.
 * 
 * @param {string[]} currentStack - Lo stack corrente delle deleghe (ordine cronologico)
 * @param {string} targetAgent - L'agente a cui si intende delegare
 * @returns {boolean} true se la delega è consentita
 * @throws {Error} se viene rilevato un loop
 */
function checkDelegationLoop(currentStack, targetAgent) {
  if (!Array.isArray(currentStack)) {
    throw new Error('Invalid stack: currentStack must be an array');
  }
  if (!targetAgent) {
    throw new Error('Invalid target: targetAgent is required');
  }

  // Rule 4: Profondità (Max Depth)
  if (currentStack.length >= 5) {
    throw new Error('Delegation loop: maximum delegation depth reached (5)');
  }

  const last = currentStack[currentStack.length - 1];
  const secondLast = currentStack[currentStack.length - 2];

  // 🆕 Eccezione per il flusso di lavoro iterativo verifier↔executor:
  // Le iterazioni tra verifier ed executor sono legittime (fix dopo verifica),
  // non un loop. La logica è centralizzata in isVerificationCycleCall().
  if (isVerificationCycleCall(last, targetAgent)) {
    return true;   // iterazione legittima, non un loop
  }

  // Rule 1: Self-loop (A -> A)
  if (last === targetAgent) {
    throw new Error(`Delegation loop: self-loop detected (${targetAgent} -> ${targetAgent})`);
  }

  // Rule 2: Ping-pong (oscillazione A <-> B ripetuta)
  // Blocca SOLO il 2-ciclo ripetuto (es. executor -> tester -> executor -> tester),
  // NON la singola iterazione legittima (es. executor -> tester -> executor, dove
  // tester esegue lavoro distinto). Un 2-ciclo si forma quando gli ultimi 4 step
  // sono [X, A, X, A]: l'ultimo agente e quello di 2 posizioni prima coincidono (X)
  // e il target coincide con l'agente di 1 posizione prima (A).
  //
  // Eccezione: Il ciclo alternato legittimo executor <-> verifier (es. fix -> verifica -> fix -> verifica)
  // non deve essere bloccato come ping-pong, ma controllato solo dal limite di profondità/saturazione generale.
  const isVerificationCycle = isVerificationCycleCall(last, targetAgent);
  if (!isVerificationCycle &&
      currentStack.length >= 3 &&
      last === currentStack[currentStack.length - 3] &&
      targetAgent === secondLast) {
    throw new Error(`Delegation loop: ping-pong detected (${targetAgent} <-> ${last})`);
  }

  // Rule 3: Saturazione (backstop)
  // Con limite di profondità 5 e il ping-pong 2-ciclo sopra, un agente può apparire
  // al massimo 3 volte in modo distribuito (es. A -> B -> A -> C -> A) senza essere
  // un loop: quello è un flusso iterativo legittimo e NON va bloccato. La soglia è
  // quindi 4 (non 3), così la regola resta un backstop che intercetta solo casi
  // patologici (resi di fatto irraggiungibili dal limite di profondità senza loop più stretti).
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
  // INIT LOG: Conferma che il plugin viene caricato
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
  // SESSION STATE — In-memory storage (locale al plugin)
  // ============================================
  // NOTA: Questi dati sono ora locali al closure del plugin invece che global.
  // Pattern allineato a OpenCode (Effect Context/Service). Evita pollution del
  // global scope e conflitti tra istanze del plugin.

  const sessionState = new Map();
  const subagentRegistry = new Map(); // child sessionID -> agent
  const pendingAgentTypes = new Map(); // agentType -> timestamp delega

  // Pending agent types: agenti delegati via task ma non ancora "cristallizzati"
  // (cioè il loro subagent non ha ancora fatto la prima tool call). Finché un
  // tipo resta pending, il currentActiveAgent è ambiguo per quel tipo.
  // Se l'Orchestratore delega un tipo DIVERSO mentre uno precedente è ancora
  // pending, la race condition documentata (entrambi crystallizzano con
  // l'ultimo valore) è concreta — blocchiamo per forzare la serializzazione.
  // Same-type (Swarm Mode) resta permesso: la Map usa il nome agente come
  // chiave, quindi più executor in parallelo non contano come conflitto.
  const PENDING_TTL_MS = 15000; // 15s: abbassato da 60s (fix 2026-07-23) perché un LLM outage lasciava pending bloccato inutilmente

  // Identity bridge: workaround per OpenCode bug #5894 (tool.execute.before non
  // propaga identità subagent). Catturato al task delegation, usato per
  // cristallizzazione al primo tool call del subagent.
  let currentActiveAgent = null;
  let orchestratorSessionID = null;
  let currentActiveAgentTimestamp = 0;  // timestamp dell'ultimo set, 0 = mai settato
  const CURRENT_ACTIVE_AGENT_TTL_MS = 300000; // 5 minuti: finestra di freshness per currentActiveAgent (fix 2026-07-23)

  /**
   * Legge currentActiveAgent con controllo freshness.
   * Se l'ultimo set è più vecchio di 5 minuti, ritorna null e auto-pulisce.
   * Previene cross-conversation identity leakage (fix 2026-07-20, recuperato nel refactoring del 23/07).
   */
  function getCurrentActiveAgent() {
    if (!currentActiveAgent || currentActiveAgentTimestamp === 0) return null;
    if (Date.now() - currentActiveAgentTimestamp > CURRENT_ACTIVE_AGENT_TTL_MS) {
      pendingAgentTypes.delete(currentActiveAgent);
      currentActiveAgent = null;
      currentActiveAgentTimestamp = 0;
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
  // AGENT PROFILES — caricamento resiliente con cache
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
   * Standardizza l'audit dei blocchi di sicurezza.
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
      // Notifica TUI — non-blocking, non deve mai interrompere il throw
      try {
        client.tui.showToast({
          body: {
            message: `🛡️ GUARD [${checkName}] → ${agent || 'unknown'}: ${error.message.split('\n')[0]}`,
            variant: 'error'
          }
        })
      } catch (_) { /* TUI non disponibile, silenzioso */ }
      throw error;
    }
  }

  /**
   * Verifica nello storico messaggi della sessione se Skill('conductor-rules')
   * è già stata caricata in precedenza.
   *
   * Serve a coprire il caso in cui il processo del plugin sia stato riavviato
   * (es. chiusura/riapertura di OpenCode): la Map in-memory `sessionState` torna
   * vuota, ma se la sessione ripresa ha lo stesso sessionID e le regole sono già
   * nello storico/contesto, il gate non deve richiederne il ricaricamento.
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
  // HOOK PRINCIPALE — DISPATCHER MODULARE
  // ============================================
  // OpenCode espone nativamente solo `tool.execute.before` come hook per tutti
  // i tool. Il dispatching per tool avviene qui su `input.tool`.
  //
  // Convenzione per subagent_type (vedi CUSTOMIZE_OPENCODE_SKILL):
  //  - Per tool "task": input.args.subagent_type (chiamante) + output.args.subagent_type (target)
  //  - Per altri tool: subagent_type recuperato da input.args o dalla state Map
  //  - Per tool "edit"/"write": filePath in output.args.filePath
  //  - Per tool "bash": command in input.args.command (o output.args.command)
  //  - Per tool "webfetch": url in input.args.url, prompt in input.args.prompt
  return {
    "tool.execute.before": async (input, output) => {
      const sessionID = input.sessionID || 'default';

      // 0. CAPTURE TARGET AGENT (Identity Propagation)
      // OpenCode non propaga l'identità del subagent nei tool call (bug #5894).
      // currentActiveAgent è il ponte necessario: viene settato qui alla
      // delega e letto in fase di cristallizzazione per il primo tool call del
      // subagent. È fragile in caso di deleghe parallele di tipi diversi — per
      // questo esiste il check "parallel_identity_conflict" sotto, che blocca
      // finché il tipo precedente non si è cristallizzato.
      if (input.tool === 'task') {
        const targetAgent = output?.args?.subagent_type || input.args?.subagent_type;
        if (targetAgent) {
          cleanupStalePending();

          // CHECK: blocca delegazioni parallele di TIPI DIVERSI mentre un tipo
          // precedente è ancora pending (non cristallizzato). Same-type (swarm
          // di più executor) resta permesso perché la Map usa l'agente come
          // chiave — un secondo "executor" non aggiunge un tipo diverso.
          const otherPendingTypes = [...pendingAgentTypes.keys()].filter(t => t !== targetAgent);
          if (otherPendingTypes.length > 0) {
            auditedCheck(sessionID, targetAgent, 'parallel_identity_conflict', () => {
              throw new Error(
                `❌ PARALLEL CONFLICT: delega a "${targetAgent}" bloccata — "${otherPendingTypes.join(', ')}" ` +
                `è ancora in corso (non risolto) e OpenCode non garantisce l'identità del subagent in parallelo ` +
                `tra tipi diversi (bug #5894).\n` +
                `→ Aspetta che "${otherPendingTypes.join(', ')}" completi almeno una tool call, poi riprova.\n` +
                `→ Deleghe parallele dello STESSO agente (Swarm Mode) restano permesse.`
              )
            }, { targetAgent, otherPendingTypes })
          }

          pendingAgentTypes.set(targetAgent, Date.now());
          // Ripristinato: rimosso per errore come "residuo" nella sessione 2026-07-14
          // (Concern 3), ma è ancora letto per la risoluzione identità e la
          // cristallizzazione. Senza questa assegnazione, agentToLock è sempre
          // undefined (registryAgent è quasi sempre vuoto per l'issue OpenCode
          // #14808) e nessun subagent cristallizza più la propria identità.
          currentActiveAgent = targetAgent;
          currentActiveAgentTimestamp = Date.now();

          // Salva/aggiorna la sessionID dell'Orchestratore — è chi chiama task.
          // FIX (2026-07-18): non fermarsi alla PRIMA sessionID mai vista. Se il
          // processo OpenCode resta vivo attraverso PIÙ conversazioni distinte
          // (ognuna con il proprio Orchestratore/sessionID), la vecchia logica
          // "solo se non è già settato" congelava orchestratorSessionID sulla
          // primissima conversazione per sempre — l'Orchestratore di ogni
          // conversazione successiva veniva trattato come subagent
          // (isOrchestrator: false), finendo sotto anti-loop/max-depth/
          // tool_phase/sub-delegation gate che non dovrebbero applicarsi a lui.
          // Aggiorniamo il riferimento ogni volta che chiama task una sessionID
          // SENZA identità cristallizzata propria (cioè non un subagent noto):
          // è la miglior euristica disponibile per "questo è l'Orchestratore",
          // e si autocorregge a ogni nuova conversazione.
          // FIX (2026-08-05): non riassegnare mai orchestratorSessionID a una
          // sessione che il registry (session.created) ha già confermato essere
          // FIGLIA di un'altra sessione. Senza questo guard, un subagent la cui
          // identità non è ancora cristallizzata (nessuna tool call reale fatta
          // prima) e la cui prima azione È una delega diretta (es. verifier→
          // executor via canDelegateTo) veniva scambiato per un nuovo
          // Orchestratore — dirottando orchestratorSessionID sulla sua sessione,
          // lasciando il VERO Orchestratore senza protezione (isOrchestrator
          // diventava false per lui) e bloccando erroneamente le azioni legittime
          // successive del subagent (trattato a sua volta come Orchestratore).
          // Confermato con test mirato (double-intermittenza: registry E
          // cristallizzazione entrambi assenti, TTL pending scaduto).
          const callerState = sessionState.get(sessionID);
          const isKnownChildSession = subagentRegistry.has(sessionID);
          if ((!callerState || !callerState.lastAgent) && !isKnownChildSession) {
            orchestratorSessionID = sessionID;
          }
        }
      }

      // 1. DEBUG LOGGING (Sempre attivo per diagnosi)
      try {
        const debugLog = {
          timestamp: getLocalTimestamp(),
          tool: input.tool,
          sessionID: sessionID,
          input: input, // Logghiamo tutto l'input per vedere se OpenCode cambia qualcosa
          outputArgs: output?.args
        };
            const debugPath = path.join(__dirname, 'delegation-guard', 'guard-debug.jsonl');
        if (!existsSync(path.dirname(debugPath))) mkdirSync(path.dirname(debugPath), { recursive: true });
        appendFileSync(debugPath, JSON.stringify(debugLog) + '\n', 'utf8');
      } catch (e) { /* Silently fail */ }

      // 1. Recupero Stato (In-Memory Map)
      // FIX (2026-08-15): era FIFO puro (evict per ordine di inserimento), non LRU —
      // con 100 sessioni accumulate, la PRIMA creata veniva evitta anche se fosse
      // l'Orchestratore ancora attivo (sessione lunga, poche tool call dirette
      // perché delega quasi tutto), perdendo conductorRulesLoaded/lastAgent e
      // ribloccando la delega successiva. Ora: (a) ogni accesso re-inserisce la
      // chiave in coda alla Map — l'ordine di inserimento diventa ordine LRU reale,
      // quindi l'eviction colpisce la sessione INATTIVA da più tempo, non la più
      // vecchia; (b) l'Orchestratore non viene MAI evitto, a prescindere dal suo
      // ordine LRU — è l'unica sessione la cui perdita di stato blocca l'intero
      // flusso di delega.
      let state = sessionState.get(sessionID);
      if (state) {
        sessionState.delete(sessionID);
        sessionState.set(sessionID, state);
      } else {
        if (sessionState.size >= MAX_SESSIONS) {
          let evicted = false;
          for (const key of sessionState.keys()) {
            if (key === orchestratorSessionID) continue;
            sessionState.delete(key);
            runtimeLog(`MAX_SESSIONS: evicted LRU session ${key}`);
            evicted = true;
            break;
          }
          if (!evicted) {
            // Solo l'Orchestratore in Map (caso limite) — nessun'altra sessione da evittare.
            runtimeLog(`MAX_SESSIONS: nessuna sessione evittabile (solo Orchestratore presente).`);
          }
        }
        state = createSessionState();
        sessionState.set(sessionID, state);
      }

      // 2. RISOLUZIONE IDENTITÀ (La Gerarchia di Sopravvivenza)
      // Priorità:
      //   1. IdentityInjector (__injectedAgent) - legacy, deprecato
      //   2. Subagent registry (da event session.created)
      //   3. Persistence (state.lastAgent) for the current session
      //   4. currentActiveAgent (bridge workaround per bug #5894)
      //
      // NOTA: input.agent e args.subagent_type NON sono campi garantiti dall'API
      // OpenCode ufficiale (vedi packages/plugin/src/index.ts). Se presenti sono
      // un bonus, ma non ci basiamo su di essi per la risoluzione identità.
      const injectedAgent = input.__injectedAgent;
      const registryAgent = subagentRegistry.get(sessionID);
        const caller = injectedAgent != null
          ? injectedAgent
          : (registryAgent || state.lastAgent || getCurrentActiveAgent());
        const subagentType = caller;

        // Identity crystallization — MAI sulla sessione dell'Orchestratore.
        // Prima non c'era questo guard: se l'Orchestratore faceva una tool call
        // non-task (es. todowrite) dopo aver settato currentActiveAgent via una
        // delega precedente, questo blocco poteva "cristallizzare" per errore la
        // sessione dell'Orchestratore con l'identità dell'ultimo target delegato
        // — root cause della race condition Swarm Mode del 2026-07-19 (vedi anche
        // la rimozione delle scritture di state.lastAgent nel task dispatcher).
        if (!state.lastAgent && input.tool !== 'task' && sessionID !== orchestratorSessionID) {
          const agentToLock = registryAgent || getCurrentActiveAgent();
          if (agentToLock) {
            state.lastAgent = agentToLock;
            sessionState.set(sessionID, state);
            runtimeLog(`[LOCK] sessionID=${sessionID} agent=${state.lastAgent} source=${registryAgent ? 'registry' : 'currentActive'}`);
            // Il tipo è ora risolto per questa sessione — rimuovilo dai pending.
            // Da qui in poi questa sessione usa state.lastAgent, non più currentActiveAgent.
            pendingAgentTypes.delete(agentToLock);
          }
        }

        // isOrchestrator: vera se la sessionID corrente è quella dell'Orchestratore.
        const isOrchestrator = orchestratorSessionID
          ? (sessionID === orchestratorSessionID)
          : (input.__isOrchestrator === true || (!caller && !state.lastAgent));
       // Nota: se non c'è nessun agente noto, l'attore è l'Orchestratore o un'identità ignota

      // 2.4. OSSERVABILITÀ TOOL MCP SCONOSCIUTI (2026-08-25)
      // FINDING: il dispatcher gestisce esplicitamente solo i tool nativi elencati
      // sotto — qualsiasi tool MCP (nome dinamico, es. "supabase_apply_migration",
      // "github_*", ecc.) non passa per NESSUN check di permesso (bashAllowlist,
      // readOnlyDespiteFullBash, allowEdit, writeScope non si applicano). Un
      // agente "tester" (bashAllowlist: []) o "verifier"/"debugger"
      // (readOnlyDespiteFullBash: true) potrebbe chiamare direttamente un tool
      // MCP distruttivo senza alcuna intercettazione.
      // Decisione esplicita dell'utente (2026-08-25): SOLO logging per ora, nessun
      // blocco — serve visibilità sull'ampiezza reale dell'uso prima di scegliere
      // una policy di enforcement (allowlist per-agente vs. restrizione ereditata
      // da bashAllowlist/readOnlyDespiteFullBash). Non è un confine di sicurezza:
      // la lista sotto può restare imprecisa senza creare un bypass, è solo
      // un'euristica "assomiglia a un tool nativo di OpenCode o no".
      if (!KNOWN_NATIVE_TOOLS.has(input.tool)) {
        runtimeLog(`🔍 MCP TOOL OSSERVATO (non enforced): tool="${input.tool}", sessionID=${sessionID}, agent=${subagentType || (isOrchestrator ? 'orchestrator' : 'unknown')}`);
        persistAuditEvent(sessionID, 'mcp_tool_usage', subagentType || (isOrchestrator ? 'orchestrator' : 'unknown'), 'observed', {
          tool: input.tool
        });
      }

      // 2.5. CHECK ASSOLUTO: L'Orchestratore non deve usare tool direttamente
      if (isOrchestrator) {
        // FIX (2026-07-23): bash/edit/write mancavano da questa lista. L'Orchestratore
        // poteva eseguirli direttamente perché nessun check li bloccava qui, e più giù
        // il permesso veniva deciso da subagentType — che per l'Orchestratore ricade sul
        // fallback (currentActiveAgent), ereditando i permessi bash/scrittura dell'ULTIMO
        // agente delegato (es. executor, bashAllowlist:["*"]) invece di essere bloccato
        // come dovrebbe essere sempre per l'Orchestratore.
        if (FORBIDDEN_ORCHESTRATOR_TOOLS.includes(input.tool)) {
          auditedCheck(sessionID, 'orchestrator', 'orchestrator_direct_tool', () => {
            throw new Error(`Delega invece di usare ${input.tool} direttamente.`);
          }, { tool: input.tool });
        }
      }

      // 2.6. GATE: conductor-rules deve essere caricata prima della prima delega.
      // Una volta per sessione (state.conductorRulesLoaded persiste in sessionState) —
      // non ricarica ad ogni prompt, blocca solo il primo `task` finché l'Orchestratore
      // non ha chiamato Skill('conductor-rules').
      // Fix 2026-08-11: sessionState è una Map in-memory (chiude col processo del
      // plugin) — se OpenCode viene chiuso e riaperto sulla STESSA sessione, il flag
      // si perde anche se le regole sono già nel contesto/storico. wasConductorRulesLoadedInHistory
      // controlla lo storico messaggi prima di bloccare, per non richiedere un ricaricamento inutile.
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
              throw new Error(`❌ ORCHESTRATOR: devi prima caricare Skill('conductor-rules') prima di delegare.`);
            }, { tool: input.tool });
          }
        }
      }

      // 3. PRIORITÀ ASSOLUTA: CHECK FILE SENSIBILI (Sempre attivo)
      if (['read', 'grep', 'glob'].includes(input.tool)) {
        const profileForC = subagentType ? agentProfiles[subagentType] : null;
        const filePath = output?.args?.filePath || output?.args?.pattern || input.args?.filePath || input.args?.pattern || input.args?.path || '';
        if (filePath) {
          auditedCheck(sessionID, subagentType || 'unknown', 'sensitive_file',
            () => checkSensitiveFileAccess(subagentType || 'unknown', profileForC, filePath, input.tool),
            { filePath, tool: input.tool });
        }
      }

      // 4. ZONA GRIGIA (Identità Sconosciuta)
      if (!subagentType) {
        const safeReadTools = ['read', 'grep', 'glob', 'ls', 'cat', 'find'];
        if (safeReadTools.includes(input.tool)) {
          runtimeLog(`⚠️ ZONA GRIGIA: tool "${input.tool}" permesso (Identità ignota). SessionID: ${sessionID}`);
          return; // Permesso in modalità safe
        }

        // Tool mutativi: permettiamo l'esecuzione ma logghiamo l'avviso 
        const mutativeTools = ['bash', 'edit', 'write', 'rm'] 
        if (mutativeTools.includes(input.tool)) { 
          runtimeLog(`⚠️ ZONA GRIGIA: tool mutativo "${input.tool}" permesso con identità ignota. SessionID: ${sessionID}`); 
        }
      }

      // 5. GESTIONE FASE PRE-DELEGATION
      // Solo l'Orchestratore è soggetto al check di fase — i subagent non devono
      // essere bloccati dalla fase della sessione dell'Orchestratore.
      if (state.phase === 'pre-delegation' && isOrchestrator) {
        // Se il tool corrente è 'task' verso un agente non-pre-delegation,
        // resettiamo la fase PRIMA del check — altrimenti il task viene bloccato
        // prima di poter resettare la fase dentro il task handler.
        if (input.tool === 'task') {
          const nextAgent = output?.args?.subagent_type
          if (nextAgent && !agentProfiles[nextAgent]?.canPreDelegate) {
            state.phase = 'delegated'
            state.lastAgent = null  // FIX: Resetta l'identità del pre-delegation agent
            sessionState.set(sessionID, state)
          }
        } else {
          // FIX (2026-08-25): era un'ALLOWLIST fissa — qualsiasi tool MCP dinamico
          // non enumerato (es. supabase_apply_migration, o qualsiasi mcp__*) veniva
          // bloccato in fase pre-delegation anche se legittimo, perché l'allowlist
          // non può conoscere in anticipo ogni tool MCP configurabile. read/grep/
          // glob/bash/edit/write/sequential-thinking sono GIÀ bloccati per
          // l'Orchestratore incondizionatamente dal check 2.5 sopra (che gira
          // PRIMA di questo, quindi qui non li rivediamo mai) — usando la stessa
          // lista condivisa (FORBIDDEN_ORCHESTRATOR_TOOLS) come DENYLIST invece di
          // riscrivere un'allowlist separata, qualsiasi altro tool passa, incluso
          // un tool MCP mai visto prima (webfetch/websearch/question inclusi,
          // 2026-07-27/2026-08-14 — l'Orchestratore può usarli direttamente).
          if (!FORBIDDEN_ORCHESTRATOR_TOOLS.includes(input.tool)) return
          auditedCheck(sessionID, subagentType || 'orchestrator', 'tool_phase', () => {
            throw new Error(`❌ ORCHESTRATOR: ${input.tool} vietato in fase pre-delegation.`)
          }, { tool: input.tool })
        }
      }

      // 6. DISPATCHER SPECIFICO
      const profile = subagentType ? agentProfiles[subagentType] : null;

      if (input.tool === 'bash') {
        const command = input.args?.command || output?.args?.command || '';
        // Se l'identità è l'orchestratore (root), blocca bash
        if (!subagentType || subagentType === 'orchestrator') {
          auditedCheck(sessionID, 'orchestrator', 'bash_block', () => {
            throw new Error(`❌ BASH: L'Orchestratore non può usare la shell. Delega a un subagent.`);
          }, { command });
          return;
        }
        // PRIORITÀ ASSOLUTA: file sensibili anche via shell (Get-Content, cat,
        // type, grep su .env, chiavi SSH, ecc.). RIAGGIUNTO 2026-07-28 dopo che
        // era sparito COMPLETAMENTE dal file (non solo l'eccezione bashAllowlist,
        // proprio tutto il blocco) — terza volta che regredisce, verificato con
        // test isolato. I pattern di SENSITIVE_FILE_PATTERNS sono ancorati con $
        // (fine stringa esatta) — non matchano un path incastonato tra virgolette
        // dentro un comando più lungo, quindi estraiamo i token tipo-path prima.
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
                  `❌ SENSITIVE FILE (bash): comando bash che accede a un file sensibile bloccato per "${subagentType}". ` +
                  `Pattern: ${pattern.name}, Severity: ${pattern.severity}, Path: ${token}. Comando: ${command.substring(0, 150)}`
                )
              }
            }
          }
        }, { command: command.substring(0, 150) })
        if (profile) {
          auditedCheck(sessionID, subagentType, 'bash_whitelist', () => checkBashWhitelist(subagentType, profile, command), { command });
        } else {
          throw new Error(`❌ BASH: Profilo non trovato per ${subagentType}.`);
        }
        return;
      }

      // Check 8: WEBFETCH guard
      if (input.tool === 'webfetch') {
        const url = input.args?.url || output?.args?.url || ''
        const prompt = output?.args?.prompt || ''
        const beforeAuditLen = state.webfetchAudit.length

        // Maintain Schema Check: must start with http:// or https://
        if (!/^https?:\/\//i.test(url)) {
          auditedCheck(sessionID, subagentType || 'unknown', 'webfetch_schema', () => {
            throw new Error(`❌ WEBFETCH: schema URL non consentito per "${subagentType || 'unknown'}": ${url}. Solo http/https ammessi.`);
          }, { url });
        }

        if (isOrchestrator) {
          // Allow Orchestrator immediately
          state.webfetchAudit.push({ agent: 'orchestrator', url, prompt: prompt?.substring(0, 100), timestamp: Date.now(), allowed: true, reason: 'orchestrator' });
        } else if (!profile) {
          // Expand Grey Zone: identity unknown (subagentType provided but no profile found)
          runtimeLog(`⚠️ ZONA GRIGIA: tool "webfetch" permesso con identità ignota. SessionID: ${sessionID}`);
          state.webfetchAudit.push({ agent: subagentType || 'unknown', url, prompt: prompt?.substring(0, 100), timestamp: Date.now(), allowed: true, reason: 'grey_zone' });
        } else {
          // Preserve Profile Logic for known subagents
          auditedCheck(sessionID, subagentType, 'webfetch', () => {
            checkWebfetch(subagentType, profile, url, prompt, state.webfetchAudit);
          }, { url, prompt });
        }

        // Nessun errore → persistere eventuali entry allowed
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
        
        // Check 10a: EDIT permission — verifica che l'agente possa modificare file
        if (profile && profile.allowEdit === false) {
          auditedCheck(sessionID, editAgent, 'edit_denied', () => {
            throw new Error(`❌ EDIT: ${editAgent} non ha permessi di modifica (allowEdit: false). Delega a executor.`)
          }, { filePath, agent: editAgent })
          return
        }
        if (isOrchestrator || !subagentType || subagentType === 'orchestrator') {
          auditedCheck(sessionID, 'orchestrator', 'edit_block', () => {
            throw new Error(`❌ EDIT: L'Orchestratore non può modificare file. Delega a un subagent.`)
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
        auditedCheck(sessionID, writeAgent, 'write_path', () => {
          checkWritePath(writeAgent, filePath, exists, state.scopeViolationTargets)
        }, { filePath, exists })
        return
      }

      // Se siamo in fase idle o delegated, blocca tool mutativi o pericolosi.
      if (['edit', 'bash', 'write', 'rm'].includes(input.tool)) {
        auditedCheck(sessionID, subagentType || 'orchestrator', 'tool_phase', () => {
          throw new Error(
            `❌ ORCHESTRATOR: ${input.tool} vietato in fase ${state.phase}.\n` +
            `→ Regola 3b: non fare debug/esplorazione manuale.\n` +
            `→ Se serve contesto, fai pre-delegation a explorer.\n` +
            `→ Se devi implementare, delega a executor.`
          )
        }, { tool: input.tool, phase: state.phase })
      }

      // ---- TASK DELEGATION (case B) ----
      if (input.tool === 'task') {
        const targetAgent = output?.args?.subagent_type
        runtimeLog(`TASK HANDLER START: tool=${input.tool}, targetAgent=${targetAgent}`)
        try {
          const prompt = output?.args?.prompt ?? ""
          const description = output?.args?.description ?? ""
          const fullText = `${description} ${prompt}`

          if (!targetAgent) {
            // subagent_type del tutto assente: OpenCode stesso rifiuta la tool call
            // a livello di schema (SchemaError "Missing key at subagent_type") prima
            // che il task venga processato — nessun blocco necessario qui.
            return
          }
          if (!agentProfiles[targetAgent]) {
            // FIX (2026-08-15): incidente reale — delega a "general" (agente
            // generico nativo di OpenCode, non presente in guard-config.json)
            // passava con un semplice `return` silenzioso, SALTANDO tutti i check
            // sotto (routing, delegation_rules, neverdo, anti_loop, workflow) —
            // il task veniva eseguito con ZERO enforcement del Guard. A differenza
            // del caso "subagent_type assente" sopra, qui il valore è valido per lo
            // schema di OpenCode (quindi la delega VIENE eseguita) ma non
            // corrisponde a nessun agente configurato — deve essere bloccata, non
            // lasciata passare in silenzio.
            pendingAgentTypes.delete(targetAgent);
            auditedCheck(sessionID, targetAgent, 'unknown_agent', () => {
              throw new Error(
                `❌ ROUTING: subagent_type "${targetAgent}" non esiste in guard-config.json — delega vietata.\n` +
                `→ Agenti validi: ${Object.keys(agentProfiles).sort().join(', ')}`
              )
            }, { targetAgent })
          }
          const targetProfile = agentProfiles[targetAgent]

          // Reset fase pre-delegation all'inizio di ogni nuova delega.
          // Se rimasta 'pre-delegation' dalla delega precedente, la resettiamo
          // subito — il pre-delegation agent ha gia' fatto il suo lavoro.
          if (state.phase === 'pre-delegation' && !agentProfiles[targetAgent]?.canPreDelegate) {
            state.phase = 'delegated'
            sessionState.set(sessionID, state)
          }

          // Routing documentazione (mantenuto)
          auditedCheck(sessionID, targetAgent, 'routing', () => checkRouting(targetAgent, targetProfile, fullText, agentProfiles), { agent: targetAgent, fullTextPreview: fullText.substring(0, 100) })

          // Delegation rules (nuovo check obbligatorio)
          auditedCheck(sessionID, targetAgent, 'delegation_rules', () => checkDelegationRulesWithRetry(targetAgent, targetProfile, fullText, agentProfiles, state), { agent: targetAgent, fullTextPreview: fullText.substring(0, 100) })

          // 🆕 NUOVO: NeverDo enforcement
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
          // NOTA: spostato PRIMA del return anticipato di canPreDelegate (vedi sotto).
          // Prima, un target canPreDelegate (explorer, codebase-mapper) usciva dalla
          // funzione prima di arrivare qui, bypassando il gate di sub-delegazione.
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
          // CHECK 4: Skill Injection — RIMOSSO
          // Le skill vanno caricate dal subagent internamente, non dall'Orchestratore nel prompt.
          // CHECK 5: Workflow Sequence
          // Include anche l'identità del CHIAMANTE (subagentType): se un agente di sola
          // diagnosi (verifier, debugger, explorer, ecc. — readOnlyDespiteFullBash) delega
          // DIRETTAMENTE a executor (permesso da canDelegateTo, es. verifier→executor dopo
          // verifica fallita), la sua sequenza di deleghe personale è vuota — ma lui STESSO
          // è la diagnosi già fatta. Senza questo, executor veniva bloccato per errore
          // chiedendo una diagnosi che era già stata effettuata dal chiamante.
          const workflowSequenceWithCaller = subagentType
            ? [...(state.delegationSequence || []), subagentType]
            : (state.delegationSequence || [])
          auditedCheck(sessionID, targetAgent, 'workflow', () => checkWorkflowSequence(targetAgent, fullText, workflowSequenceWithCaller, agentProfiles), { agent: targetAgent, fullTextPreview: fullText.substring(0, 100) })

          runtimeLog(`WORKFLOW CHECK: sessionID=${sessionID} delegationSequence=${JSON.stringify(state.delegationSequence)}, targetAgent=${targetAgent}`)

          // CHECK: Verifier obbligatorio dopo executor
          // Permette altri executor in parallelo (Swarm Mode) ma blocca qualsiasi
          // altro agente finché non arriva il verifier — TRANNE gli agenti di sola
          // analisi/diagnosi (readOnlyDespiteFullBash: true — debugger, explorer,
          // codebase-mapper, code-reviewer, security-auditor), che non producono
          // modifiche di codice e possono legittimamente lavorare su un problema
          // scollegato mentre un fix precedente aspetta la verifica.
          // Derivato dal flag invece di una lista fissa separata: una lista fissa
          // (diagnosisOnlyAgents) aveva dimenticato code-reviewer/security-auditor
          // — stesso identico flag già usato per il mutation-check, unica fonte
          // di verità invece di due liste che possono disallinearsi.
          const lastDelegated = (state.delegationSequence || [])[(state.delegationSequence || []).length - 1]
          if (lastDelegated === 'executor' &&
              targetAgent !== 'verifier' &&
              targetAgent !== 'executor' &&
              targetAgent !== 'doc-writer' &&
              !agentProfiles[targetAgent]?.readOnlyDespiteFullBash) {
            throw new Error(
              `❌ WORKFLOW: executor ha modificato codice. Il prossimo agente deve essere verifier.\n` +
              `→ Agente richiesto: verifier\n` +
              `→ Agente tentato: ${targetAgent}`
            )
          }

          runtimeLog(`WORKFLOW CHECK PASSED: targetAgent=${targetAgent}`)

          // Pre-delegation detection — DOPO tutti i check di sicurezza sopra.
          // Prima questo return anticipato avveniva PRIMA di sub-delegation,
          // dangerous, ssh_local, workflow sequence ed executor→verifier,
          // permettendo di aggirarli tutti semplicemente delegando a un
          // agente canPreDelegate (explorer, codebase-mapper) invece del
          // target "vero". Ora quegli agenti passano dagli stessi controlli
          // di chiunque altro — l'unica eccezione (executor→verifier) è ora
          // esplicita e deliberata (vedi readOnlyDespiteFullBash sopra), non un
          // side-effect accidentale della gestione della fase pre-delegation.
          if (targetAgent && agentProfiles[targetAgent]?.canPreDelegate) {
            state.phase = 'pre-delegation'
            // RIMOSSO: state.lastAgent = targetAgent
            // Scrivere qui l'identità del CHIAMANTE (state.lastAgent) con il
            // TARGET della delega confondeva "chi è questa sessione" con "a chi
            // ho appena delegato" — sotto Swarm Mode (deleghe parallele dalla
            // stessa sessione Orchestratore, incluse canPreDelegate) questo
            // produceva una race condition: l'ultima delega canPreDelegate
            // processata "vinceva" e contaminava state.lastAgent per le
            // chiamate executor elaborate dopo, facendo scattare erroneamente
            // il gate di sub-delegazione (isOrchestrator restava vero, ma il
            // check guarda state.lastAgent). L'identità del chiamante va
            // impostata SOLO dalla cristallizzazione (sopra), mai da qui.
            sessionState.set(sessionID, state)
            return
          }

          // Update state after all checks passed
          // RIMOSSO: state.lastAgent = targetAgent (stesso motivo sopra)

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
            state.delegationSequence.shift(); // rimuove il più vecchio
          }
          sessionState.set(sessionID, state);
          persistAuditEvent(sessionID, 'delegation', targetAgent, 'executed', {
            fullTextPreview: fullText.substring(0, 200)
          })
        } catch (taskError) {
          // Rollback: rimuovi il targetAgent dai pending perché il subagent
          // non verrà mai creato (check fallito prima della creazione).
          if (targetAgent) {
            pendingAgentTypes.delete(targetAgent);
            runtimeLog(`[ROLLBACK] removed ${targetAgent} from pendingAgentTypes after task check failure: ${taskError.message}`);
          }
          throw taskError;  // Ri-lancia per mantenere il comportamento di blocco
        }
      }
    },


    // ============================================
    // HOOK tool.execute.after — Check A (audit anti-esfiltrazione secrets)
    // ============================================
    // L'hook `after` in OpenCode NON può bloccare l'azione (è già eseguita),
    // quindi la rilevazione è postuma. Poiché `tool.execute.before` non è
    // affidabile in questo ambiente, qui trasformiamo la rilevazione in un
    // incidente di sicurezza esplicito: audit persistito + toast TUI + runtime log.
    // checkSecretsInOutput pusha l'entry in state.secretDetectionAudit prima di
    // lanciare, quindi l'audit log ha già il dettaglio; qui lo rendiamo visibile.
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
        // Hook after non può bloccare originariamente, ma modificando l'oggetto output per riferimento
        // possiamo redigere attivamente i secret prima che tornino a OpenCode.
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
        } catch (_) { /* TUI non disponibile, silenzioso */ }
        console.error('[delegation-guard] Secret detection:', e.message)
      }
    },


    // ============================================
    // EVENT HOOK — session lifecycle
    //
    // IMPORTANTE: Non esiste un hook dedicato "session.created" nell'API ufficiale
    // OpenCode (@opencode-ai/plugin). Tutti gli eventi di sessione (session.created,
    // session.deleted, etc.) arrivano solo tramite l'hook generico "event".
    //
    // Schema reale (da packages/schema/src/v1/session.ts):
    //   event.type = "session.created"
    //   event.properties = { sessionID, info: { id, parentID?, agent?, ... } }
    //
    // parentID e agent sono optional — null/undefined per root sessions.
    "event": async ({ event }) => {
      // Populate subagent registry when OpenCode creates a child session.
      if (event?.type === 'session.created') {
        const sessionID = event.properties?.sessionID
        const info = event.properties?.info

        if (sessionID && info) {
          // Child session (ha parentID) → subagent da registrare
          if (info.parentID && info.agent) {
            subagentRegistry.set(sessionID, info.agent)
            runtimeLog(`[REGISTRY] session.created child=${sessionID} agent=${info.agent} parent=${info.parentID}`)
            // FAST-RELEASE (redesign 2026-08-05): il registry ha già risolto l'identità
            // per questa sessione — non serve più aspettare la crystallizzazione lenta
            // (prima tool call reale) per sbloccare Opzione A su questo tipo.
            if (pendingAgentTypes.has(info.agent)) {
              pendingAgentTypes.delete(info.agent)
              runtimeLog(`[FAST-RELEASE] pendingAgentTypes cleared for "${info.agent}" via session.created (child=${sessionID})`)
            }
          }
          // Root session (no parentID) → probabilmente l'Orchestratore
          else if (info.agent) {
            runtimeLog(`[REGISTRY] session.created root=${sessionID} agent=${info.agent} (orchestrator)`)
            orchestratorSessionID = sessionID
          }
          // Sessione senza agent → zona grigia
          else {
            runtimeLog(`[REGISTRY] session.created sessionID=${sessionID} senza agent (zona grigia)`)
          }
        }
      }

      // Cleanup per-session delegation sequence solo su vera fine sessione.
      // RIMOSSO 'session.idle' dal trigger (2026-07-18): probabilmente scatta
      // ogni volta che l'Orchestratore resta in attesa di un subagent delegato
      // (cioè dopo OGNI delega, non solo a fine conversazione) — questo
      // azzerava delegationSequence subito dopo, per esempio, una delega a
      // explorer, rendendo il check "richiede diagnosi prima" per l'executor
      // successivo dipendente dal caso (solo se il prompt conteneva per
      // fortuna una keyword, non se la sequenza reale lo giustificava).
      // L'array ha già un cap a 20 con eviction FIFO (vedi sotto), quindi la
      // pulizia per igiene di memoria è garantita senza bisogno di questo reset.
      if (event?.type === 'session.deleted') {
        const sessionID = event?.sessionID
        if (sessionID) {
          subagentRegistry.delete(sessionID);
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
    const errLogMsg = `❌ CRASH ALL'AVVIO DEL PLUG-IN: ${err.message}\nStack:\n${err.stack}`
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
// EXPORT — unica interfaccia pubblica
// ============================================
// Le funzioni interne di check (read, edit, write, bash, ecc.) sono private
// al modulo: vivono dentro il closure e non sono esportate. L'unico export
// pubblico è `DelegationGuard`, che OpenCode chiama come hook plugin.
//
// FUTURE: Se servirà TDD puro (node --test senza istanziare OpenCode),
// estrarre le funzioni di check come named exports puri (stessa logica,
// no closure dependencies) da importare nei file di test.
//
// Convenzione di context per subagent_type (vedi CUSTOMIZE_OPENCODE_SKILL):
//  - OpenCode passa args.subagent_type al tool "task"
//  - Per gli altri tool (bash, edit, write, webfetch), subagent_type è
//    iniettato dal context in args o recuperato dalla state Map della sessione
//  - getSessionState(sessionID) → ritorna lo state corrente della sessione

// ============================================
// CHECK B — Persistenza audit log su disco
// ============================================
// Scrive eventi di audit in formato JSONL (un evento JSON per riga) in
// `audit-YYYY-MM-DD.jsonl` dentro la directory configurata. Default di
// produzione: `.planning/audit` (relativa a `__dirname`).
//
// Schema evento:
//   { timestamp, sessionId, eventType, agent, action, details }
//
// - `eventType`: 'secret' | 'sensitive' | 'webfetch' | 'delegation' | 'denied'
// - `action`:    'redacted' | 'allowed' | 'blocked' | 'executed'
// - `details`:   opzionale, type-specific
//
// Resilienza: errori di scrittura NON propagano (loggano in console.error
// con prefisso `[GUARD-AUDIT-ERROR]`). Il guard non deve mai bloccarsi per
// problemi di I/O sull'audit log.

/** @type {string} */
let currentAuditLogDir = path.join(__dirname, '.planning', 'audit')

/**
 * Gestisce la persistenza di incidenti e lezioni apprese quando un evento è 'denied'.
 * @param {string} agent 
 * @param {Record<string, any>} details 
 */
/**
 * Sanitizza testo prima di interpolarlo in una riga di INCIDENTS.md/LESSONS.md
 * (entrambi file markdown in append). Senza questo, un valore attaccante-
 * controllato (es. subagent_type in un errore ROUTING, o un comando bash
 * troncato in un errore SHELL MUTATION) contenente `\n### [INC-9999] ...`
 * può iniettare una entry falsa nell'audit trail — CR/LF sono l'unico modo
 * per far iniziare una nuova riga markdown, quindi rimuoverli neutralizza
 * l'injection indipendentemente dal contenuto del resto della stringa.
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
      runtimeLog(`handleDeniedEvent: _projectDirectory non impostata. Salto persistenza.`);
      return;
    }
    if (_projectDirectory.endsWith(path.sep + '.opencode') || _projectDirectory.includes(path.sep + '.opencode' + path.sep)) {
        runtimeLog(`handleDeniedEvent: _projectDirectory è dentro .opencode (${_projectDirectory}). Salto persistenza.`);
        return;
    }
    const metricsPath = path.resolve(_projectDirectory, '.opencode', 'metrics_count.json');
    const incidentsPath = path.resolve(_projectDirectory, '.planning', 'INCIDENTS.md');
    const metricsDir = path.dirname(metricsPath);
    const planningDir = path.dirname(incidentsPath);
    const lessonsPath = path.join(os.homedir(), '.config', 'opencode', 'LESSONS.md');
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
    // Sanitizzati: agent, checkName e details.error possono contenere testo
    // attaccante-controllato (es. subagent_type arbitrario, comando bash
    // troncato) — senza questo un CR/LF al loro interno può forgiare una
    // entry falsa nel log di audit (vedi sanitizeForMarkdownLog).
    const checkName = sanitizeForMarkdownLog(details.check || 'unknown_check');
    const safeAgent = sanitizeForMarkdownLog(agent);
    const safeError = sanitizeForMarkdownLog(details.error || 'Nessun dettaglio fornito');
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const incidentEntry = `\n### [${incidentId}] [${checkName}] | ${dateStr} | ${safeAgent} | Stato: bloccato | ${safeError}\n`;

    appendFileSync(incidentsPath, incidentEntry, 'utf8');

    const lessonKey = `${agent}:${details.check || 'unknown_check'}`;
    metrics.counts[lessonKey] = (metrics.counts[lessonKey] || 0) + 1;

    if (metrics.counts[lessonKey] === 2 && !metrics.lessons_written[lessonKey]) {
      const synthesis = safeError.replace(/^❌ [^:]+: /, '');
      const lessonEntry = `- [${dateStr}] ${safeAgent} ha tentato di ${checkName} $\rightarrow$ ${synthesis}\n`;
      appendFileSync(lessonsPath, lessonEntry, 'utf8');
      metrics.lessons_written[lessonKey] = true;
    }

    // Scrittura atomica (temp file + rename) invece di writeFileSync diretta.
    // Non elimina il read-modify-write race se OpenCode dovesse eseguire il
    // plugin in processi separati concorrenti sullo stesso progetto (non
    // verificabile da qui) — ma evita che un lettore concorrente veda un JSON
    // parzialmente scritto/corrotto a metà di un rename non atomico.
    const metricsTmpPath = `${metricsPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(metricsTmpPath, JSON.stringify(metrics, null, 2), 'utf8');
    renameSync(metricsTmpPath, metricsPath);
  } catch (e) {
    runtimeLog(`Denied event persistence failed: ${e.message}`);
  }
}

/**
 * Scrive un evento di audit in append sul file `audit-YYYY-MM-DD.jsonl`.
 * - Crea la directory se non esiste (`mkdirSync` recursive).
 * - Encoding UTF-8, separatore riga `\n`.
 * - Errori di scrittura vengono loggati in `console.error` e NON propagati.
 *
 * @param {string} sessionId - ID sessione OpenCode
 * @param {string} eventType - Tipo di evento ('secret'|'sensitive'|'webfetch'|'delegation'|'denied')
 * @param {string|null} agent - Nome agente che ha generato l'evento (o null)
 * @param {string} action - Azione ('redacted'|'allowed'|'blocked'|'executed')
 * @param {Record<string, any>} [details] - Dettagli opzionali type-specific
 */
function persistAuditEvent(sessionId, eventType, agent, action, details = {}) {
  try {
    if (!existsSync(currentAuditLogDir)) {
      mkdirSync(currentAuditLogDir, { recursive: true })
    }
    const now = new Date()
    const pad = (/** @type {number} */ n) => n.toString().padStart(2, '0')

    const dateStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}` // YYYY-MM-DD locale
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
    // Errori di scrittura NON devono bloccare il guard.
    console.error('[GUARD-AUDIT-ERROR]', e instanceof Error ? e.message : String(e))
  }
}

/**
 * Crea uno state di sessione iniziale.
 * @returns {{ phase: 'idle'|'pre-delegation'|'delegated', lastAgent: string|null, explorerContext: string, delegationHistory: any[], webfetchAudit: any[], secretDetectionAudit: any[], delegationSequence: string[] }}
 */
function createSessionState() {
  return {
    phase: /** @type {'idle'} */ ('idle'),
    lastAgent: null,
    explorerContext: '',
    delegationHistory: /** @type {any[]} */ ([]),
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
 * Normalizza un filePath per il check di zona vietata.
 * - Gestisce path traversal (../)
 * - Converte backslash Windows (\) a forward slash (/)
 * - Rimuove prefisso ./ (dot-slash)
 * - Rimuove prefisso / (path assoluti POSIX) per trattarli come relativi
 * - Usa path.posix.normalize per collassare separatori ridondanti
 *
 * Esportata per consentire TDD diretto sulla logica di normalizzazione.
 *
 * @param {string} filePath - Path da normalizzare (Windows o POSIX)
 * @returns {string} Path normalizzato POSIX-like, senza traversal/./prefisso
 */
function normalizePathForCheck(filePath) {
  if (!filePath) return ''
  if (typeof filePath !== 'string') return ''
  // 1) Converti backslash Windows a forward slash
  const forwardSlash = filePath.replace(/\\/g, '/')
  // 2) Rimuovi prefisso ./ (dot-slash)
  const noDotPrefix = forwardSlash.replace(/^\.\//, '')
  // 3) Risolvi traversal ../ (una o più occorrenze in testa)
  const noTraversal = noDotPrefix.replace(/^(\.\.\/)+/, '')
  // 4) Normalizza con path.posix.normalize (collassa separatori, gestisce residui)
  // 5) Rimuovi / iniziale (path assoluto POSIX → relativo per il check)
  return path.posix.normalize(noTraversal).replace(/^\/+/, '')
}

/** @type {() => any} */
const createAgentProfilesFallback = () => ({
  "codebase-mapper": {
    role: "mappatura codebase",
    allowEdit: false,
    keywords: ["mappa", "architettura", "struttura", "dipendenze", "stack"],
    allowMentions: ["fix", "test"],
    neverDo: ["apply correction", "implement feature", "modify code", "run test"],
    canPreDelegate: true,
    // Consistenza con guard-config.json (2026-07-25): mancava qui, presente solo
    // nel config esterno — il fallback interno resterebbe senza questa protezione
    // se guard-config.json non si caricasse mai.
    readOnlyDespiteFullBash: true,
    bashAllowlist: ["grep *", "rg *", "python -m graphify query*", "python -m graphify path*", "python -m graphify explain*"],
    canWebfetch: false,
    canDelegateTo: ["explorer"],
    writeScope: "all",
    delegation_rules: {
      can_handle_directly: ["exploration", "code_search", "architecture_analysis", "dependency_mapping"],
      must_delegate_to: {
        verification: "verifier",
        testing: "tester",
        documentation: "doc-writer",
        debugging: "debugger",
        exploration: "explorer",
        security_audit: "security-auditor",
        code_review: "code-reviewer",
        ui_prototyping: "sketcher",
        feasibility_spike: "spiker"
      }
    }
  },
  "code-reviewer": {
    role: "analisi codice",
    allowEdit: false,
    keywords: ["review", "analisi codice", "quality", "security review"],
    allowMentions: ["fix", "implementa"],
    neverDo: ["apply correction", "implement feature", "modify code"],
    canPreDelegate: false,
    readOnlyDespiteFullBash: true,
    bashAllowlist: ["grep *", "rg *", "npm test*", "npm run test*", "npm run lint*", "npm run typecheck*", "npx tsc*", "python -m graphify query*", "python -m graphify path*", "python -m graphify explain*"],
    canWebfetch: false,
    canDelegateTo: ["executor"],
    writeScope: "all",
    delegation_rules: {
      can_handle_directly: ["code_review", "quality_analysis"],
      must_delegate_to: {
        verification: "verifier",
        testing: "tester",
        documentation: "doc-writer",
        debugging: "debugger",
        exploration: "explorer",
        security_audit: "security-auditor",
        code_review: "code-reviewer",
        ui_prototyping: "sketcher",
        feasibility_spike: "spiker"
      }
    }
  },
  "debugger": {
    role: "diagnosi",
    allowEdit: false,
    keywords: ["debug", "analizza", "causa root", "perché crasha", "errori", "stack trace", "diagnostica", "identifica", "trova"],
    allowMentions: ["fix", "test", "errore"],
    neverDo: ["applica fix", "implementa fix", "modifica codice", "scrivi test", "esegui test"],
    canPreDelegate: false,
    // Il debugger ha bash pieno (bashAllowlist:["*"] via guard-config.json) per
    // eseguire tsc/test/graphify a piacere, ma per ruolo non deve MAI mutare
    // file — stessa classe di rischio già chiusa per il verifier (07-15).
    readOnlyDespiteFullBash: true,
    bashAllowlist: ["grep *", "rg *", "npx tsc*", "npm run typecheck*", "python -m graphify query*", "python -m graphify path*", "python -m graphify explain*", "graphify query*", "graphify path*", "graphify explain*", "npx graphify*", "node graphify*"],
    canWebfetch: true, // allineato a guard-config.json — debugger può cercare errori/stack trace online
    canDelegateTo: ["executor", "tester", "verifier"],
    writeScope: "all",
    delegation_rules: {
      can_handle_directly: ["debugging", "root_cause", "error_analysis", "stack_trace"],
      must_delegate_to: {
        verification: "verifier",
        testing: "tester",
        documentation: "doc-writer",
        debugging: "debugger",
        exploration: "explorer",
        security_audit: "security-auditor",
        code_review: "code-reviewer",
        ui_prototyping: "sketcher",
        feasibility_spike: "spiker"
      }
    }
  },
  "doc-writer": {
    role: "documentazione",
    allowEdit: true,
    keywords: ["documentazione", "readme", "manuale", "guide", "api docs", "docs", "aggiorna docs",
               "scrivi documentazione", "status_report", "changelog", "sessions", "planning files", "state.md",
               "ripristina file", "restore file", "aggiorna report", "update report", "scrivi report", "genera report"],
    allowMentions: ["fix", "test", "codice", "verifica", "validate", "check", "review", "diagnosi", "bug", "errore"],
    neverDo: ["applicare fix", "fare diagnosi", "eseguire modifica codice"],
    canPreDelegate: false,
    bashAllowlist: [],
    canWebfetch: false,
    canDelegateTo: ["executor", "verifier", "doc-writer", "explorer"],
    writeScope: "readme",
    delegation_rules: {
      can_handle_directly: ["documentation", "readme", "changelog", "api_docs"],
      must_delegate_to: {
        verification: "verifier",
        testing: "tester",
        documentation: "doc-writer",
        debugging: "debugger",
        exploration: "explorer",
        security_audit: "security-auditor",
        code_review: "code-reviewer",
        ui_prototyping: "sketcher",
        feasibility_spike: "spiker"
      }
    }
  },
  "executor": {
    role: "implementazione",
    allowEdit: true,
    keywords: ["fix", "implementa", "modifica", "aggiungi", "refactor", "applica", "commit",
               "copia", "backup", "sposta", "rinomina", "crea cartella", "replica",
               "copy", "move", "rename", "mkdir", "create", "deploy", "installa", "configura"],
    allowMentions: ["diagnosi", "analisi", "documentazione", "test", "readme", "status", "report"],
    neverDo: ["fare diagnosi", "scrivi test", "esegui test", "scrivere documentazione", "fare analisi",
              "aggiornare readme", "aggiornare docs", "scrivere manuale",
              "scrivi readme", "scrivi status_report", "aggiorna status_report",
              "scrivi changelog", "aggiorna changelog", "scrivi sessions", "aggiorna sessions", "update sessions",
              "planning files", "file di planning", "aggiorna state.md", "update state.md",
              "ripristina file", "restore file", "write report", "update report"],
    canPreDelegate: false,
    // L'executor implementa, non certifica il proprio lavoro: l'esecuzione
    // test (npm test/pytest/jest/ecc. via bash) spetta al verifier.
    noTestExecution: true,
    bashAllowlist: ["*"], // allow full — esecutore con commit/push atomici
    canWebfetch: true, // richiesta esplicita utente 2026-07-24 — serve a scaricare risorse esterne (es. Python releases) durante l'implementazione
    canDelegateTo: ["*"],
    writeScope: "all",
    delegation_rules: {
      can_handle_directly: ["implementation", "refactor", "bugfix", "deployment", "configuration"],
      must_delegate_to: {
        verification: "verifier",
        testing: "tester",
        documentation: "doc-writer",
        debugging: "debugger",
        exploration: "explorer",
        security_audit: "security-auditor",
        code_review: "code-reviewer",
        ui_prototyping: "sketcher",
        feasibility_spike: "spiker"
      }
    }
  },
  "explorer": {
    role: "ricerca",
    allowEdit: false,
    keywords: ["esplora", "analisi", "contestualizza", "dove è", "come funziona", "cerca", "trova", "struttura"],
    allowMentions: ["fix", "test", "implementa"],
    neverDo: ["apply correction", "implement feature", "modify code", "create file", "write code"],
    canPreDelegate: true,
    readOnlyDespiteFullBash: true,
    bashAllowlist: [
      "Get-ChildItem*",
      "Get-Content*",
      "Get-Item*",
      "Select-String*",
      "python -m graphify query*",
      "python -m graphify path*",
      "python -m graphify explain*"
    ],
    canWebfetch: true, // allineato a guard-config.json
    canDelegateTo: ["executor", "verifier", "doc-writer", "explorer"], // OpenCode non espone il tool task ai pre-delegation agents
    writeScope: "planning",
    delegation_rules: {
      can_handle_directly: ["exploration", "code_search", "architecture_analysis", "dependency_mapping"],
      must_delegate_to: {
        verification: "verifier",
        testing: "tester",
        documentation: "doc-writer",
        debugging: "debugger",
        exploration: "explorer",
        security_audit: "security-auditor",
        code_review: "code-reviewer",
        ui_prototyping: "sketcher",
        feasibility_spike: "spiker"
      }
    }
  },
  "security-auditor": {
    role: "audit security",
    allowEdit: false,
    keywords: ["security", "vulnerabilità", "audit", "owasp"],
    allowMentions: ["fix", "implementa"],
    neverDo: ["apply correction", "implement feature", "modify code"],
    canPreDelegate: false,
    readOnlyDespiteFullBash: true,
    bashAllowlist: ["grep *", "rg *", "npm audit*", "npm run audit*"],
    canWebfetch: false,
    canDelegateTo: ["executor"],
    writeScope: "all",
    delegation_rules: {
      can_handle_directly: ["security_audit", "vulnerability_scan"],
      must_delegate_to: {
        verification: "verifier",
        testing: "tester",
        documentation: "doc-writer",
        debugging: "debugger",
        exploration: "explorer",
        security_audit: "security-auditor",
        code_review: "code-reviewer",
        ui_prototyping: "sketcher",
        feasibility_spike: "spiker"
      }
    }
  },
  "sketcher": {
    role: "prototipi UI",
    allowEdit: true,
    keywords: ["mockup", "wireframe", "ui", "ux", "design", "prototipo visivo"],
    allowMentions: ["fix"],
    neverDo: ["apply correction", "implement backend", "implement logic"],
    canPreDelegate: false,
    bashAllowlist: [], // deny totale
    canWebfetch: false,
    canDelegateTo: ["executor", "verifier", "doc-writer", "explorer"],
    writeScope: "sketches",
    delegation_rules: {
      can_handle_directly: ["ui_prototyping", "mockup", "wireframe"],
      must_delegate_to: {
        verification: "verifier",
        testing: "tester",
        documentation: "doc-writer",
        debugging: "debugger",
        exploration: "explorer",
        security_audit: "security-auditor",
        code_review: "code-reviewer",
        ui_prototyping: "sketcher",
        feasibility_spike: "spiker"
      }
    }
  },
  "spiker": {
    role: "prototipi throwaway",
    allowEdit: true,
    keywords: ["prototipo", "spike", "feasibility", "test fattibilità"],
    allowMentions: [],
    neverDo: ["fix progetto reale", "modifica codebase principale"],
    canPreDelegate: false,
    bashAllowlist: ["*"], // allow full — prototipi usa-e-getta
    canWebfetch: false,
    canDelegateTo: ["*"],
    writeScope: "spikes",
    delegation_rules: {
      can_handle_directly: ["feasibility_spike", "throwaway_prototype"],
      must_delegate_to: {
        verification: "verifier",
        testing: "tester",
        documentation: "doc-writer",
        debugging: "debugger",
        exploration: "explorer",
        security_audit: "security-auditor",
        code_review: "code-reviewer",
        ui_prototyping: "sketcher",
        feasibility_spike: "spiker"
      }
    }
  },
  "tester": {
    role: "scrittura test",
    allowEdit: true,
    keywords: ["scrivi test", "crea test", "e2e", "maestro", "playwright", "coverage", "scenario"],
    allowMentions: ["test", "esegui", "verifica"],
    neverDo: ["run test", "apply correction", "perform diagnostic", "modify source code"],
    canPreDelegate: false,
    bashAllowlist: [], // deny totale
    canWebfetch: false,
    canDelegateTo: ["executor"],
    writeScope: "all",
    delegation_rules: {
      can_handle_directly: ["testing", "e2e", "unit_test", "test_creation"],
      must_delegate_to: {
        verification: "verifier",
        testing: "tester",
        documentation: "doc-writer",
        debugging: "debugger",
        exploration: "explorer",
        security_audit: "security-auditor",
        code_review: "code-reviewer",
        ui_prototyping: "sketcher",
        feasibility_spike: "spiker"
      }
    }
  },
  "verifier": {
    role: "validazione",
    allowEdit: false,
    keywords: ["verifica", "valida", "esegui test", "controlla", "review", "lint", "screenshot", "validate"],
    allowMentions: ["test", "fix", "esegui"],
    neverDo: ["apply correction", "write test", "perform diagnostic", "modify code"],
    canPreDelegate: false,
    bashAllowlist: ["*"], // allow full — anomalia documentata (unico read-only con bash)
    // Il verifier ha bash pieno solo per eseguire test/lint, MAI per mutare file.
    // checkShellMutation blocca comandi bash che scrivono/modificano/cancellano
    // file (PowerShell Set-Content, Python open('w'), sed -i, redirection, ecc.)
    // aggirando così il divieto di "fix" che altrimenti si applicherebbe solo
    // ai tool edit/write (che il verifier non ha comunque) e al testo del prompt.
    readOnlyDespiteFullBash: true,
    canWebfetch: false,
    canDelegateTo: ["executor", "doc-writer"],
    writeScope: "all",
    delegation_rules: {
      can_handle_directly: ["verification", "validation", "review", "linting"],
      must_delegate_to: {
        verification: "verifier",
        testing: "tester",
        documentation: "doc-writer",
        debugging: "debugger",
        exploration: "explorer",
        security_audit: "security-auditor",
        code_review: "code-reviewer",
        ui_prototyping: "sketcher",
        feasibility_spike: "spiker"
      }
    }
  }
})

// ============================================
// FUNZIONI DI CHECK — PRIVATE AL CLOSURE
// ============================================
// Le funzioni di check sono private al closure del plugin.
// Solo `DelegationGuard` è esportato come factory.
// I test verificano il comportamento via public API (DelegationGuard()).

/**
 * Pre-compila le regex dei pattern forbidden per evitare overhead a runtime.
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
  // Guard null-profile: fail-closed con messaggio descrittivo (Finding #4)
  if (!profile) {
    throw new Error(`❌ GUARD: profilo non trovato per agente "${agent}". Delega/routing non valido.`)
  }
  if (!Array.isArray(profile.neverDo)) {
    throw new Error(`❌ GUARD: neverDo mancante per "${agent}". Configurazione corrotta.`)
  }

  // Pre-compila le regex al volo se non sono già presenti nel profilo
  if (!profile.neverDoRegex) {
    compileNeverDoRegex(profile)
  }

  for (let i = 0; i < profile.neverDoRegex.length; i++) {
    if (profile.neverDoRegex[i].test(fullText)) {
      const forbidden = profile.neverDo[i]
      if (isAllowedMention(forbidden, profile.allowMentions, fullText)) continue;
      throw new Error(
        `❌ RULE: ${agent} NON può fare "${forbidden}".\n` +
        `→ Ruolo: ${profile.role}\n` +
        `→ Usa l'agente appropriato.`
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
    throw new Error(`❌ GUARD: agente non valido in checkWorkflowSequence. Delega/routing non valido.`)
  }
  const workflowRule = workflowRules[agent]
  if (!workflowRule) return
  const hasException = workflowRule.exceptions.some(ex => fullText.toLowerCase().includes(ex.toLowerCase()))
  if (hasException) return

  // Controlla se il prerequisito è già stato soddisfatto nella sequenza di deleghe reale.
  // Prerequisito = qualsiasi agente readOnlyDespiteFullBash (debugger, explorer,
  // codebase-mapper, verifier, code-reviewer, security-auditor) — sono tutti agenti
  // di sola analisi/validazione le cui scoperte contano come diagnosi già fatta.
  // Derivato dal flag invece di una lista fissa separata (vedi nota nel dispatcher
  // principale: una lista fissa duplicata aveva dimenticato code-reviewer/security-auditor).
  const sequenceAgents = delegationSequence || []
  const prereqAgents = allProfiles
    ? Object.keys(allProfiles).filter(name => allProfiles[name]?.readOnlyDespiteFullBash)
    : ['debugger', 'explorer', 'codebase-mapper', 'verifier'] // fallback se allProfiles non passato
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
    throw new Error(`❌ GUARD: profilo non trovato per agente "${agent}". Delega/routing non valido.`)
  }

  // Check documentazione: se il target non è doc-writer e il task è documentazione, blocca.
  const docBlockingAgents = ['executor', 'debugger', 'spiker', 'sketcher']
  if (docBlockingAgents.includes(agent) && isDocumentationTask(fullText)) {
    throw new Error(
      `❌ ROUTING: Task di documentazione rilevato. Usa doc-writer invece di ${agent}.\n` +
      `→ Prompt: "${fullText.substring(0, 100)}..."`
    )
  }
}

/** @type {(agent: string, profile: any, command: string) => void} */
function checkBashWhitelist(agent, profile, command) {
  // Guard null-profile: fail-closed con messaggio descrittivo (Finding #4)
  if (!profile) {
    throw new Error(`❌ GUARD: profilo non trovato per agente "${agent}". Delega/routing non valido.`)
  }
  if (!Array.isArray(profile.bashAllowlist)) {
    throw new Error(`❌ GUARD: bashAllowlist mancante per "${agent}". Configurazione corrotta.`)
  }
  if (/rm\s+-rf\s+(\/|~|\/c\/|c:\\)/i.test(command)) {
    throw new Error("❌ SICUREZZA: rm -rf su path radice/utente/Windows bloccato.")
  }
  if (/git\s+push.*--force.*(?=\s+(main|master|develop|release\/))/i.test(command)) {
    throw new Error("❌ SICUREZZA: git push --force su branch protetto (main/master/develop/release/*) bloccato.")
  }
  if (/git\s+add\s+-f\s+(\/|[a-zA-Z]:[\\\/])/.test(command)) {
    throw new Error("❌ SICUREZZA: git add -f con path assoluto bloccato.")
  }
  if (destructiveSystemPatterns.some(p => p.test(command.trim()))) {
    throw new Error("❌ SICUREZZA: Comando distruttivo di sistema bloccato.")
  }

  // Agenti come il verifier hanno bashAllowlist:["*"] per eseguire test/lint,
  // ma per ruolo non devono MAI mutare file. checkNeverDo/checkRouting guardano
  // solo il testo del prompt di delega, non il contenuto del comando bash —
  // senza questo check il divieto di "fix" sarebbe aggirabile eseguendo
  // PowerShell/Python/sed direttamente.
  if (profile.readOnlyDespiteFullBash) {
    const mutationMatch = shellMutationPatterns.find(p => p.test(command))
    const isTempScratch = tempDirMarkers.some(p => p.test(command))
    if (mutationMatch && !isTempScratch) {
      throw new Error(
        `❌ SHELL MUTATION: "${agent}" ha ruolo di sola validazione — comando bash che modifica file bloccato.\n` +
        `Comando: ${command.substring(0, 150)}\n` +
        `→ Se serve una correzione, delega a executor.`
      )
    }
  }

  // L'executor implementa, non certifica il proprio lavoro: l'esecuzione dei
  // test è compito del verifier (o del tester per scriverli). Senza questo
  // check, executor con bashAllowlist:["*"] potrebbe lanciare la test suite
  // da solo e dichiararsi a posto, aggirando la validazione indipendente che
  // il flusso executor→verifier è pensato per garantire.
  if (profile.noTestExecution) {
    const testMatch = testExecutionPatterns.find(p => p.test(command))
    if (testMatch) {
      throw new Error(
        `❌ TEST EXECUTION: "${agent}" non può eseguire test — la validazione spetta a verifier.\n` +
        `Comando: ${command.substring(0, 150)}\n` +
        `→ Completa l'implementazione e delega a verifier per l'esecuzione dei test.`
      )
    }
  }

  const allowlist = profile.bashAllowlist ?? []
  if (allowlist.length === 0) {
    throw new Error(`❌ BASH: ${profile.role} (${agent}) non può eseguire bash (deny totale).`)
  }
  if (allowlist[0] === '*') return

  const trimmed = command.trim()
  const matches = allowlist.some(pattern => {
    const regexStr = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
    return new RegExp(regexStr, 'i').test(trimmed)
  })
  if (!matches) {
    throw new Error(
      `❌ BASH: comando non in allowlist per ${agent}.\n` +
      `→ Comandi permessi: ${allowlist.join(', ')}\n` +
      `→ Eseguito: ${trimmed.substring(0, 60)}`
    )
  }
}

/** @type {(agent: string, profile: any, url: string, prompt: string, auditLog?: any[]) => void} */
function checkWebfetch(agent, profile, url, prompt, auditLog) {
  // Guard null-profile: fail-closed con messaggio descrittivo (Finding #4)
  if (!profile) {
    throw new Error(`❌ GUARD: profilo non trovato per agente "${agent}". Delega/routing non valido.`)
  }
  // Calcola esito del check PRIMA dell'audit/push (Finding #10: schema check + Finding #7: success/fail)
  // Schema check (Finding #10): blocca file://, javascript:, data: anche per agent con canWebfetch
  if (!/^https?:\/\//i.test(url)) {
    if (Array.isArray(auditLog)) {
      auditLog.push({
        agent,
        url,
        prompt: prompt?.substring(0, 100),
        timestamp: Date.now(),
        allowed: false,
        reason: 'invalid_url_schema'
      })
    }
    throw new Error(
      `❌ WEBFETCH: schema URL non consentito per "${agent}": ${url}. Solo http/https ammessi.`
    )
  }
  const hasExplicitRequest = !!(prompt && /richiesta utente esplicita webfetch/i.test(prompt))
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
    `❌ WEBFETCH: ${agent} non autorizzato a fetch risorse esterne.\n` +
    `→ Profilo: ${profile.role}\n` +
    `→ URL: ${url}\n` +
    `→ Aggiungi "richiesta utente esplicita webfetch" al prompt per consentire.`
  )
}

/** @type {(caller: string, callerProfile: any, target: string, allProfiles: any) => void} */
function checkTaskSubDelegation(caller, callerProfile, target, allProfiles) {
  // Guard null-profile: fail-closed con messaggio descrittivo (Finding #4)
  if (!callerProfile) {
    throw new Error(`❌ GUARD: profilo non trovato per caller "${caller}". Delega/routing non valido.`)
  }
  if (!allProfiles[target]) {
    throw new Error(`❌ SUB-DELEGATION: target "${target}" non è un agente conosciuto.`)
  }
  const allowed = callerProfile.canDelegateTo ?? []
  if (allowed.length === 0) {
    throw new Error(`❌ SUB-DELEGATION: ${caller} non può delegare (canDelegateTo vuoto).`)
  }
  if (allowed[0] === '*') return
  if (!allowed.includes(target)) {
    throw new Error(
      `❌ SUB-DELEGATION: ${caller} non può delegare a ${target}.\n` +
      `→ Può delegare a: ${allowed.join(', ')}`
    )
  }
}

// ============================================
// CHECK A — Anti-esfiltrazione secrets (output post-tool)
// ============================================

/**
 * Check A — Scansiona l'output di un tool per pattern di secrets/credenziali.
 * Se TROVATO un secret → throw con messaggio redatto + audit log.
 *
 * Agenti trusted (canDelegateTo include "*", es. executor) sono skippati
 * perché legittimamente gestiscono secrets (commit, env setup, ecc.).
 *
 * Funzione PURA, riusabile in qualsiasi contesto (anche tool.execute.before
 * per check preliminare). Nell'hook `tool.execute.after` viene chiamata in
 * try/catch perché l'hook after non può bloccare in OpenCode.
 *
 * @param {unknown} output - Output del tool (string, object, o qualsiasi tipo serializzabile)
 * @param {string} subagent - Nome del subagent
 * @param {any} profile - Profilo agente (opzionale, ma obbligatorio per fail-closed)
 * @param {any[]} [auditLog] - Array opzionale dove pushare record di detection
 * @param {string} [filePath] - Path del file letto (se applicabile), per esclusione log/lezioni del Guard
 * @throws {Error} se profile mancante o se viene trovato un secret
 */
function checkSecretsInOutput(output, subagent, profile, auditLog, filePath) {
  if (!output) return
  if (!profile) {
    throw new Error(`❌ GUARD: profile mancante per checkSecretsInOutput (subagent: ${subagent})`)
  }
  // Trusted agents (es. executor con canDelegateTo:["*"]) → skip
  if (Array.isArray(profile.canDelegateTo) && profile.canDelegateTo.includes('*')) return
  // File di log/lezioni del Guard → skip (menzioni di path, non secret reali)
  if (isSecretScanExcluded(filePath)) return

  const text = typeof output === 'string' ? output : JSON.stringify(output)
  if (!text) return

  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex (regex con flag /g sono stateful)
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
        `❌ ESFILTRAZIONE: rilevato ${pattern.name} (${matches.length} occorrenze) nell'output per agente "${subagent}". ` +
        `Output redatto per sicurezza.`
      )
    }
  }
}

/**
 * Check C — Blocca accesso a file sensibili (env, ssh keys, aws creds, ecc.)
 * via read/grep/glob. Fail-closed per default.
 *
 * Eccezione: agenti con `bashAllowlist: ["*"]` (full bash, es. executor)
 * possono accedere a questi file se esplicitamente necessario.
 *
 * Funzione PURA, normalizza Windows backslash a forward slash per matching coerente.
 *
 * @param {string} agent - Nome agente (es. 'debugger')
 * @param {any} profile - Profilo agente (opzionale)
 * @param {string|null|undefined} filePath - Path del file o pattern da controllare
 * @param {string} toolName - Tool che sta tentando l'accesso ('read', 'grep', 'glob')
 * @throws {Error} se il file matcha un SENSITIVE_FILE_PATTERNS
 */
function checkSensitiveFileAccess(agent, profile, filePath, toolName) {
  if (!filePath || typeof filePath !== 'string') return

  // NESSUNA eccezione per bashAllowlist:["*"]. Questa eccezione era già stata
  // rimossa due volte (design originale + refactor del 07-23) e per la terza
  // volta è ricomparsa (probabilmente per un checkpoint file non allineato dopo
  // il reset del container il 2026-07-28) — confermata con test isolato che
  // mostrava un agente 'executor' bypassare completamente il blocco su .env.
  // I file sensibili non devono essere leggibili/scrivibili da NESSUN agente,
  // indipendentemente dai suoi permessi bash. Se questa riga ricompare ANCORA,
  // il problema è nel processo di sincronizzazione dei file, non nel codice.

  // Normalizza backslash Windows → forward slash
  const normalized = filePath.replace(/\\/g, '/')

  for (const pattern of SENSITIVE_FILE_PATTERNS) {
    if (pattern.name === 'secrets_directory' && isNodeModulesPath(normalized)) continue
    // Reset lastIndex (regex con flag /i e /g sono stateful)
    pattern.regex.lastIndex = 0
    if (pattern.regex.test(normalized)) {
      throw new Error(
        `❌ SENSITIVE FILE: accesso a file sensibile bloccato per agente "${agent || 'unknown'}". ` +
        `Tool: ${toolName}, File: ${filePath}, Pattern: ${pattern.name}, Severity: ${pattern.severity}`
      )
    }
  }
}

/**
 * Helper interno (non esportato) — Validazione comune del path zone per edit/write.
 * DRY: usato da checkEditPath e checkWritePath per evitare duplicazione.
 *
 * Pipeline di check (fail-closed, throw al primo errore):
 *   1. Guard null-agent (Finding #4)
 *   2. Normalizzazione path (Windows backslash, ./ prefisso, ../ traversal)
 *   3. Check esplicito path traversal
 *   4. Check zona vietata (node_modules, .git, dist, build)
 *   5. Check containment nel progetto (skip se _projectDirectory non affidabile)
 *
 * @param {string} agent - Nome agente (es. 'executor')
 * @param {string} filePath - Path da validare
 * @param {'edit'|'write'} opType - Tipo operazione (per messaggio errore)
 */
function validatePathZone(agent, filePath, opType) {
  if (!agent || typeof agent !== 'string') {
    throw new Error(`❌ GUARD: agente non valido in check${opType === 'edit' ? 'Edit' : 'Write'}Path. Delega/routing non valido.`)
  }
  // Guard su filePath (Bug #1): senza questo, `filePath=null` viene normalizzato
  // a '' da normalizePathForCheck e tutti i check successivi passano (fail-OPEN).
  if (!filePath || typeof filePath !== 'string') {
    throw new Error(`❌ GUARD: filePath non valido per agente "${agent}" in ${opType}. filePath ricevuto: ${JSON.stringify(filePath)}`)
  }
  const normalized = normalizePathForCheck(filePath)
  if (normalized.startsWith('..') || /^\.\.(\/|\\)/.test(filePath || '')) {
    throw new Error(`❌ PATH TRAVERSAL: ${filePath} non ammesso.`)
  }
  if (/^(node_modules|\.git|dist|build)\//i.test(normalized)) {
    throw new Error(`❌ PATH: ${opType} in ${filePath} bloccato (zona vietata).`)
  }
  // FIX (2026-08-15): l'audit trail del Guard (.planning/audit/*.jsonl,
  // .planning/INCIDENTS.md, .opencode/metrics_count.json) non era in nessuna
  // zona vietata — qualsiasi agente con edit/write nel progetto (es. executor,
  // writeScope 'all') poteva modificare o cancellare il proprio audit trail.
  // NOTA: .planning/ nel suo complesso resta scrivibile (explorer ha
  // writeScope 'planning' per design), solo audit/ e INCIDENTS.md sono protetti.
  if (/^\.planning\/audit\//i.test(normalized) ||
      /^\.planning\/incidents\.md$/i.test(normalized) ||
      /^\.opencode\/metrics_count\.json$/i.test(normalized)) {
    throw new Error(`❌ PATH: ${opType} in ${filePath} bloccato — audit trail del Guard, non modificabile da nessun agente.`)
  }
  // Check containment nel progetto. OpenCode a volte passa directory=plugins\
  // come project directory (vedi sessione 2026-07-12) — _projectDirectory in quel
  // caso non è affidabile come radice di containment.
  //
  // FIX (2026-08-15): il vecchio codice SALTAVA COMPLETAMENTE il containment
  // quando _projectDirectory era inaffidabile — nessun altro check qui ferma un
  // path assoluto fuori progetto (il check "PATH TRAVERSAL" sopra intercetta solo
  // "../" iniziali, non un path assoluto altrove), quindi in quello scenario
  // edit/write su QUALSIASI file del filesystem passava senza alcun blocco.
  // Ora, se _projectDirectory è inaffidabile, si usa `worktree` (passato dalla
  // factory OpenCode, tipicamente la radice reale del git worktree) come radice
  // di fallback prima di arrendersi allo skip totale.
  const projectRoot = isReliableProjectRoot(_projectDirectory)
    ? _projectDirectory
    : (isReliableProjectRoot(_worktree) ? _worktree : '')
  if (projectRoot) {
    const resolvedPath = path.resolve(filePath);
    const resolvedProject = path.resolve(projectRoot);
    if (!resolvedPath.startsWith(resolvedProject + path.sep) &&
        resolvedPath !== resolvedProject) {
      throw new Error(
        `❌ PATH OUT OF PROJECT: ${filePath} è fuori dalla directory del progetto.\n` +
        `→ Progetto: ${resolvedProject}\n` +
        `→ Path risolto: ${resolvedPath}\n` +
        `→ Usa un path relativo dentro il progetto.`
      );
    }
  }
}

/**
 * Un candidato a radice di progetto è "affidabile" se non è vuoto e non punta
 * dentro `.opencode` o `plugins` — gli stessi due contesti in cui OpenCode è
 * noto passare la directory sbagliata (vedi commento in validatePathZone).
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
 * Normalizza il path (gestisce backslash Windows, ./ prefisso, ../ traversal)
 * PRIMA di controllare le zone vietate. Fail-closed per path traversal esplicito.
 *
 * @param {string} agent - Nome agente (es. 'executor')
 * @param {string} filePath - Path del file da editare
 */
function checkEditPath(agent, filePath) {
  // FIX (2026-07-25): mancava del tutto lo scan sui pattern sensibili per edit —
  // solo read/grep/glob lo avevano (riga ~932). Un agente con allowEdit:true
  // poteva sovrascrivere .env/chiavi SSH/credenziali senza alcun blocco, purché
  // il path fosse dentro il progetto (validatePathZone non c'entra, controlla
  // solo i confini del progetto, non il contenuto sensibile del path).
  checkSensitiveFileAccess(agent, null, filePath, 'edit')
  validatePathZone(agent, filePath, 'edit')
}

/** Agenti con writeScope ristretto a cartelle throwaway, e il relativo pattern/etichetta. */
const RESTRICTED_WRITE_SCOPE_AGENTS = {
  sketcher: { pattern: /^(sketches|mockups|prototypes)\//i, label: 'sketches/, mockups/, prototypes/' },
  spiker: { pattern: /^(spikes|experiments|prototypes|tmp|sandbox)\//i, label: 'spikes/, experiments/, prototypes/, tmp/, sandbox/' }
}

/**
 * Traccia i tentativi ripetuti di un agente a writeScope ristretto di scrivere
 * FUORI dal proprio scope, sullo STESSO path normalizzato. Alla 2a ripetizione
 * dello stesso target, sostituisce il generico errore SCOPE con un routing error
 * più forte — segnale che non si tratta di un vero throwaway/prototipo (un errore
 * isolato/typo non ripete mai lo stesso identico path due volte), ma di un tentativo
 * insistito di far passare del lavoro reale attraverso un agente permissivo.
 *
 * Validato via simulazione su scenari realistici prima dell'implementazione
 * (self-correction, typo isolati su path diversi, sessioni lunghe con più spike
 * separati, evasione via "successo di facciata" tra due tentativi) — 0 falsi
 * positivi/negativi tranne un caso ambiguo per design (stesso typo esatto ripetuto
 * 2 volte), accettabile perché il costo del falso positivo è solo un messaggio di
 * redirect, non un blocco permanente.
 *
 * @param {string} agent
 * @param {string} filePath
 * @param {Record<string, number>} scopeViolationTargets - state.scopeViolationTargets della sessione
 * @param {string} baseMessage - messaggio d'errore originale (1° tentativo)
 * @throws {Error} sempre — messaggio base al 1° tentativo, escalation dal 2°
 */
function throwOrEscalateScopeViolation(agent, filePath, scopeViolationTargets, baseMessage) {
  const key = agent + '::' + normalizePathForCheck(filePath)
  const count = (scopeViolationTargets[key] || 0) + 1
  scopeViolationTargets[key] = count
  if (count >= 2) {
    throw new Error(
      `❌ ROUTING: ${agent} ha già tentato ${count} volte di scrivere in "${filePath}" (fuori dal proprio writeScope).\n` +
      `→ Non è un throwaway/prototipo genuino — redelega a executor con domain:implementation.`
    )
  }
  throw new Error(baseMessage)
}

/**
 * Check 10+11 — Write path enforcement.
 * Normalizza il path (gestisce backslash Windows, ./ prefisso, ../ traversal)
 * PRIMA di controllare le zone vietate. Fail-closed per path traversal esplicito.
 *
 * @param {string} agent - subagent_type (es. 'executor')
 * @param {string} filePath - path del file target
 * @param {boolean} exists - true se il file esiste già, false se è nuovo
 * @param {Record<string, number>} [scopeViolationTargets] - state.scopeViolationTargets della sessione (solo per agenti a writeScope ristretto)
 * @throws {Error} se write a file esistente non consentito
 */
function checkWritePath(agent, filePath, exists, scopeViolationTargets) {
  // FIX (2026-07-25): stesso buco di checkEditPath — mancava lo scan sui pattern
  // sensibili per write.
  checkSensitiveFileAccess(agent, null, filePath, 'write')

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
      `❌ WRITE: write a file esistente (${filePath}) bloccato — usa "edit" per file esistenti.\n` +
      `→ Eccezioni: *.log, *.tmp, *.bak`
    )
  }

  if (restriction) {
    // Bug #2 fix: normalizza path (rimuove ./, \ → /) e usa flag /i per case-insensitive
    const normalizedScope = normalizePathForCheck(filePath)
    if (!restriction.pattern.test(normalizedScope)) {
      const baseMessage = `❌ SCOPE: ${agent} può scrivere solo in ${restriction.label}.\n→ Path: ${filePath}`
      if (scopeViolationTargets) {
        throwOrEscalateScopeViolation(agent, filePath, scopeViolationTargets, baseMessage)
      }
      throw new Error(baseMessage)
    }
  }
}


