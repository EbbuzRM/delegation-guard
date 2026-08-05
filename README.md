# Delegation Guard

Delegation Guard è un middleware di sicurezza deterministico per l'ecosistema OpenCode. Intercetta ogni tool call e richiesta di delega tra agenti, applicando controlli rigorosi per prevenire loop ricorsivi, accesso non autorizzato a dati sensibili, esecuzione di comandi distruttivi ed esfiltrazione di secret.

Il Guard è completamente deterministico — nessuna dipendenza da LLM. Ogni regola è codificata come funzione pura, testabile in isolamento.

## Core Security Pillars

### Anti-Loop Guard
Previene cicli di delega infiniti tramite quattro regole applicate allo stack di delega:

| Regola | Descrizione |
|--------|-------------|
| Self-loop | Blocca un agente che delega a sé stesso |
| Ping-pong | Blocca il 2-ciclo ripetuto (A→B→A→B), non la singola iterazione legittima |
| Saturazione | Stesso agente appare ≥4 volte negli ultimi 5 passi (backstop) |
| Profondità massima | Stack oltre 5 livelli viene bloccato |

L'Orchestratore è esentato dai controlli anti-loop in quanto radice di ogni catena di delega.

### Sensitive File Protection
Ogni tool call di lettura (read, grep, glob) viene intercettata prima di qualsiasi altro controllo. Il Guard blocca l'accesso a:

- **Critico**: `.env`, `.env.*`, chiavi SSH (`~/.ssh/id_*`), file `.pem`, credential AWS/GCP/Azure
- **Alto**: directory `secrets/`, `credentials/`, `private/`; file `.p12`, `.pfx`, `.jks`, `.netrc`, file `.git-credentials`, `.docker/config.json`
- **Medio**: `.npmrc` (può contenere token di autenticazione)

Nessun agente è esentato — il blocco si applica a tutti indipendentemente da `bashAllowlist`. L'eccezione che permetteva ad executor di accedere a file sensibili è stata rimossa definitivamente (fix 2026-07-28).

### Bash Allowlists
Ogni agente ha una lista di pattern di comandi consentiti, seguendo il principio del minimo privilegio:

| Agente | bashAllowlist | readOnlyDespiteFullBash | Note |
|--------|--------------|------------------------|------|
| executor | `["*"]` | — | Full access; `noTestExecution: true` |
| verifier | `["*"]` | ✓ | Test/lint only; no file mutations |
| spiker | `["*"]` | — | Full access; write scope: spikes/ |
| codebase-mapper | `["*"]` | ✓ | Shell mutation bloccata |
| code-reviewer | `["*"]` | ✓ | Shell mutation bloccata |
| debugger | `["*"]` | ✓ | Shell mutation bloccata; canWebfetch |
| explorer | `["*"]` | ✓ | Shell mutation bloccata; canWebfetch |
| security-auditor | `["*"]` | ✓ | Shell mutation bloccata |
| tester | `[]` | — | Deny totale |
| sketcher | `[]` | — | Deny totale |
| doc-writer | `[]` | — | Deny totale |

**readOnlyDespiteFullBash**: il flag blocca comandi bash che mutano file (PowerShell `Set-Content`/`Add-Content`/`Out-File`/`Remove-Item`, Python `open('w')`, Node `fs.writeFileSync`, `sed -i`, `tee`, `rm`, ecc.) anche per agenti con `bashAllowlist: ["*"]`. L'eccezione è la scrittura in directory temporanee (`AppData\Local\Temp`, `/tmp/`, `$env:TEMP`) che rimane permessa.

**noTestExecution**: il flag blocca l'esecuzione di test (`npm test`, `pytest`, `jest`, `go test`, ecc.) tramite bash. Attivo su executor — l'esecuzione test spetta al verifier.

Oltre all'allowlist, il Guard applica protezioni extra su ogni agente con bash:
- Eliminazione ricorsiva su percorsi root, utente o Windows bloccata
- `git push` con flag force su branch protetti (main, master, develop, release/*) bloccato
- `git add -f` con path assoluto bloccato
- Pattern distruttivi di sistema (format, diskpart, eliminazione ricorsiva) bloccati
- File sensibili accessibili via shell (es. `Get-Content .env`) bloccati per tutti gli agenti

### Workflow Enforcement
Il Guard impone una sequenza di delega obbligatoria:

1. **Prerequisito diagnostico**: executor richiede un agente diagnostico precedente (debugger, explorer, codebase-mapper) oppure una keyword o riferimento a file diagnostico nel prompt. Eccezioni per operazioni routinarie: ota, update, deploy, publish, release, commit, push.

2. **Post-executor verifier**: dopo executor, il prossimo agente deve essere:
   - `verifier` — validazione standard
   - `executor` — altro executor in parallelo (Swarm Mode)
   - `doc-writer` — aggiornamenti documentazione

   Verifier e doc-writer possono operare autonomamente (senza executor precedente).

### Routing Guard + Delegation Rules
Ogni task deve dichiarare un dominio nel prompt (`domain:<nome>`). Il Guard verifica che l'agente target possa gestire quel dominio:

- Se l'agente può gestirlo direttamente → permesso
- Se deve delegare ad altro agente → bloccato con suggerimento
- Se il dominio non è dichiarato → errore "Dominio del task non dichiarato"

Alias riconosciuti automaticamente: `architecture` → `architecture_analysis`, `security` → `security_audit`.

Il routing include un meccanismo di retry: max 3 tentativi per coppia (agente, dominio), poi escalation a intervento manuale.

**Documentation task detection**: se un agente non-doc-writer prova a modificare file `.md` o `.txt`, il Guard lo blocca automaticamente e suggerisce di delegare a doc-writer. La rilevazione usa tre step: (1) verbo di scrittura nel prompt, (2) anti-code check — se il prompt menziona file di codice, non è un task di documentazione, (3) verifica presenza di file .md/.txt target.

### Edit Guard
Intercetta le chiamate `edit` e applica:
- Verifica che il profilo dell'agente permetta edit
- L'Orchestratore non può editare file direttamente
- Blocca modifiche in zone protette: `node_modules/`, `.git/`, `dist/`, `build/`
- Blocca path traversal (es. `../../etc/passwd`)

### Write Guard
Intercetta le chiamate `write` e applica:
- Stesse zone protette dell'Edit Guard
- Blocca sovrascrittura di file esistenti (eccezioni: `*.log`, `*.tmp`, `*.bak`)
- Applica scope di scrittura per agente: sketcher → solo `sketches/`, `mockups/`, `prototypes/`; spiker → solo `spikes/`, `experiments/`, `prototypes/`, `tmp/`, `sandbox/`

### Webfetch Guard
Intercetta le chiamate `webfetch`:
- Solo schemi `http://` e `https://` permessi
- L'Orchestratore è sempre autorizzato
- Per gli altri agenti, deve essere abilitato nel profilo (`canWebfetch: true`) o il prompt deve contenere "richiesta utente esplicita webfetch"
- Se l'identità è sconosciuta (zona grigia), webfetch è permesso ma loggato

### Secret Detection (Post-Execution)
Dopo ogni tool call, il Guard scansiona l'output per pattern di credential:
- **Critico**: GitHub PAT (`ghp_...`), AWS Access Key (`AKIA...`), chiavi private (RSA/EC/OPENSSH/DSA)
- **Alto**: URL con credential, Bearer token, API key Modal, Supabase token, JWT
- **Medio**: API key generica in JSON, percorsi file di chiavi private

Quando un secret viene rilevato, il Guard modifica attivamente l'oggetto output sostituendo tutti i campi stringa con `[REDACTED BY DELEGATION GUARD - SECURITY VIOLATION: SECRET DETECTED]` prima che il risultato torni a OpenCode. L'azione è quindi una redazione attiva, non solo logging. Agenti trusted (con `canDelegateTo: ["*"]`, es. executor e spiker) sono esentati perché gestiscono credential legittimamente.

## Identity Resolution

Il Guard risolve l'identità dell'agente a ogni tool call tramite una gerarchia:

1. `input.__injectedAgent` (legacy)
2. `global.currentActiveAgent` o `input.agent`
3. `state.lastAgent` (identità cristallizzata per sessione)

### Cristallizzazione
Quando l'Orchestratore delega un task, il target agent viene catturato in `global.currentActiveAgent`. Al primo tool call non-task del subagent, l'identità viene cristallizzata nel per-session state (`state.lastAgent`), isolandola da sovrascritture dovute a deleghe successive.

### Protezione Parallelismo Cross-Tipo
Se l'Orchestratore tenta di delegare a un tipo di agente diverso mentre un altro è ancora in attesa di cristallizzare la propria identità, il Guard blocca la delega con un errore esplicito. Deleghe dello stesso tipo (Swarm Mode) sono sempre permesse — solo il cross-tipo parallelo è serializzato.

Il TTL per il pending di un agente non cristallizzato è **15 secondi** (abbassato da 60s il 2026-07-23 per evitare blocchi prolungati in caso di outage LLM).

### Zona Grigia
Se l'identità non è risolvibile:
- **Tool read-only** (read, grep, glob): permessi con warning
- **Tool mutativi** (bash, edit, write): permessi ma loggati. I controlli downstream (allowlist, edit guard, write guard) si applicano solo se richiedono un profilo noto.

### Orchestrator
L'Orchestrator è rilevato confrontando la sessione corrente con `global.__orchestratorSessionID`. Può usare `task` e `webfetch`/`websearch` senza restrizioni, ma non può usare direttamente `glob`, `grep`, `read`, `sequential-thinking`, `todowrite`, `bash`, `edit`, `write` — deve delegare a un subagent.

## Agent Profiles

### Full Agent Table

| Agente | Ruolo | bashAllowlist | readOnly | canPreDelegate | writeScope | allowEdit | canWebfetch | Note |
|--------|-------|--------------|----------|----------------|------------|-----------|-------------|------|
| codebase-mapper | mappatura codebase | `["*"]` | ✓ | true | all | false | false | Pre-delegation |
| code-reviewer | analisi codice | `["*"]` | ✓ | false | all | false | false | lint, tsc, typecheck |
| debugger | diagnosi | `["*"]` | ✓ | false | all | false | true | canWebfetch per lookup errori |
| doc-writer | documentazione | `[]` | — | false | readme | true | false | Deny bash; docs scope |
| executor | implementazione | `["*"]` | — | false | all | true | true | noTestExecution; verifier required after |
| explorer | ricerca | `["*"]` | ✓ | true | planning | false | true | Pre-delegation |
| security-auditor | audit security | `["*"]` | ✓ | false | all | false | false | npm audit |
| sketcher | prototipi UI | `[]` | — | false | sketches | true | false | Deny bash; sketches/mockups/prototypes only |
| spiker | prototipi throwaway | `["*"]` | — | false | spikes | true | false | Full access; spikes/experiments/sandbox |
| tester | scrittura test | `[]` | — | false | all | true | false | Deny bash; writes tests, does not run them |
| verifier | validazione | `["*"]` | ✓ | false | all | false | false | Test/lint only; no mutations |

`readOnly` = `readOnlyDespiteFullBash` — shell mutation bloccata anche con bash pieno.

La configurazione è centralizzata in `guard-config.json`. I profili nativi di OpenCode (`.config/opencode/agents/*.md`) non contengono più permessi bash — tutto è gestito dal Guard.

### Delegation Rules per Agente
Ogni profilo agente definisce `delegation_rules` con:
- `can_handle_directly`: domini che l'agente può processare direttamente
- `must_delegate_to`: domini che devono essere delegati ad altro agente

Esempio (executor):
```json
"delegation_rules": {
  "can_handle_directly": ["implementation", "refactor", "bugfix", "deployment", "configuration"],
  "must_delegate_to": {
    "verification": "verifier",
    "testing": "tester",
    "documentation": "doc-writer",
    "debugging": "debugger"
  }
}
```

## Configurazione

### Agent Profiles
Modifica `guard-config.json` (consigliato) o la funzione `createAgentProfilesFallback()` nel plugin per:
- Aggiungere/rimuovere agenti
- Modificare permessi bash, writeScope, canDelegateTo
- Configurare delegation_rules

### Security Patterns
Modifica le costanti nel plugin:
- `SENSITIVE_FILE_PATTERNS`: pattern di file sensibili da proteggere
- `SECRET_PATTERNS`: pattern di credential da rilevare nell'output
- `dangerousPatterns` / `destructiveSystemPatterns`: comandi distruttivi da bloccare

### Workflow Rules
Modifica `workflowRules` nel plugin per controllare:
- Quali agenti richiedono prerequisiti
- Le eccezioni che bypassano i controlli

### Trigger Reload
Il Guard rileva automaticamente le modifiche a `guard-config.json` basandosi sul `mtime` del file (controllo ogni 5 secondi). Non è necessario riavviare OpenCode — le modifiche al config vengono applicate entro 5 secondi dalla scrittura. Il file `guard-init.log` conferma il caricamento iniziale del plugin.

## Observability

### Log Files

| File | Scopo | Posizione |
|------|-------|-----------|
| `guard-init.log` | Bootstrap plugin | `.planning/` (relativo a `__dirname`) |
| `guard-debug.jsonl` | Debug I/O completo | `delegation-guard/` (relativo a `__dirname`) |
| `delegation-guard-runtime.log` | Monitoraggio operativo | directory plugin (`__dirname`) |
| `audit-YYYY-MM-DD.jsonl` | Audit trail strutturato | `.planning/audit/` (relativo a `__dirname`) |
| `INCIDENTS.md` | Registro blocchi di sicurezza | `.planning/` nella project directory |
| `LESSONS.md` | Pattern ricorrenti (≥2 incidenti) | `~/.config/opencode/` |
| `metrics_count.json` | Contatori incidenti per tipo | `.opencode/` nella project directory |

### Audit Event Schema
```json
{
  "timestamp": "2026-06-29T10:30:00.000+02:00",
  "sessionId": "...",
  "eventType": "denied|delegation|secret|sensitive|webfetch",
  "agent": "executor",
  "action": "blocked|allowed|executed",
  "details": { ... }
}
```

### Incident Tracking
Ogni evento `denied` (blocco di sicurezza) attiva `handleDeniedEvent()` che:
1. Scrive una riga in `.planning/INCIDENTS.md` nella project directory con ID progressivo (`INC-NNNN`), check name, data, agente e motivo
2. Aggiorna contatori in `.opencode/metrics_count.json`
3. Se lo stesso tipo di incidente (agente + check) si ripete ≥2 volte, scrive una "lezione" in `~/.config/opencode/LESSONS.md` per memoria persistente cross-progetto

La persistenza viene saltata se `_projectDirectory` è vuoto o punta a `.opencode`/`plugins` (contesti non affidabili).

### TUI Notifications
Ogni azione bloccata mostra un toast di errore in tempo reale nell'interfaccia OpenCode, con il nome del check, l'agente e la prima riga del motivo del blocco.

## Key Runtime Log Patterns

| Pattern | Significato |
|---------|-------------|
| `IDENTITY LOCK: session=... -> agente` | Identità cristallizzata per una sessione |
| `ZONA GRIGIA: tool "..." permesso` | Identità sconosciuta, tool permesso in modalità sicura |
| `WORKFLOW CHECK PASSED: agent=...` | Validazione workflow superata |
| `blocked: agent=..., check=..., reason=...` | Blocco di sicurezza con dettagli |
| `CLEANUP: global sequence reset` | Sessione orchestrator terminata |

## Known Limitations

| Limitazione | Causa | Stato |
|-------------|-------|-------|
| tool.execute.before non si attiva per tool call di subagent | Limitazione OpenCode | Workaround: identity crystallization |
| delegationSequence si resetta alla creazione di una nuova istanza guard | Stato nel closure di `createDelegationGuard()` | Persistenza SQLite pianificata |
| Routing basato su keyword, non semantico | Scelta progettuale | Deliberato — garantisce determinismo |

## Graphify Plugin

`graphify.js` è un plugin companion che inietta un reminder prima delle chiamate `bash` quando il grafo della codebase è disponibile (`graphify-out/graph.json` esiste nella project directory). L'obiettivo è ricordare all'agente di usare `graphify query` invece di grep manuale per domande architetturali, sfruttando il grafo già calcolato.

Il reminder si attiva una sola volta per sessione (`reminded = true` dopo il primo trigger). Il plugin si auto-esclude se la directory indica il brand sbagliato (es. `.kilo` su istanza opencode, o `.opencode` su istanza kilo).

## Testing

Le funzioni di check sono **private al closure** del plugin — non sono named exports. I test verificano il comportamento tramite la public API (`DelegationGuard` factory) istanziando il guard con un mock client e simulando tool call tramite l'hook `tool.execute.before`.

`test-harness2.mjs` copre 7 suite principali:
1. Routing / domain declaration
2. Workflow sequence (fix richiede diagnosi)
3. Sensitive file protection (read/grep/glob/edit/write/bash)
4. No test execution per executor
5. Shell mutation per agenti `readOnlyDespiteFullBash`
6. Orchestrator tool restrictions
7. Swarm Mode — parallelo stesso tipo OK, cross-tipo bloccato

Il file importa da `delegation-guard-refactored.js` (nome del file refactorato in uso durante i test): aggiornare l'import se il filename cambia. Eseguire con `node test-harness2.mjs`.

## Key File Paths

| File | Scopo |
|------|-------|
| `delegation-guard.js` | Codice principale del plugin |
| `guard-config.json` | Profili agente esterni |
| `README-Delegation Guard.md` | Questo documento |
| `delegation-guard-runtime.log` | Log operativo runtime |
| `.planning/guard-init.log` | Log inizializzazione plugin |
| `delegation-guard/guard-debug.jsonl` | Debug I/O completo (relativo a `__dirname`) |
| `.planning/audit/audit-YYYY-MM-DD.jsonl` | Audit trail |
