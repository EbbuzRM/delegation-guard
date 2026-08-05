# Delegation Guard

Deterministic security middleware for the OpenCode multi-agent ecosystem. Intercepts every tool call and delegation request between agents, enforcing strict checks to prevent recursive loops, unauthorized sensitive data access, destructive commands, and secret exfiltration.

The Guard is fully deterministic — no LLM dependencies. Every rule is codified as a pure function, testable in isolation.

## Installation

### Files

| File | Destination | Description |
|------|-------------|-------------|
| `delegation-guard.js` | `<your-opencode-dir>/plugins/` | Main plugin code |
| `guard-config.json` | `<your-opencode-dir>/plugins/` | Agent profiles configuration |

Copy both files to the same directory. OpenCode loads plugins automatically at startup.

### Test Harness (Optional)

`test-harness2.mjs` is an automated test suite (34 scenarios) that verifies all guard behaviors. To run it:

1. Copy `delegation-guard.js` and `guard-config.json` to the plugin directory
2. Edit the import path in `test-harness2.mjs` if your plugin directory differs from the default
3. Run: `node test-harness2.mjs`

The test harness imports from `./delegation-guard.js` — make sure the path matches your setup.

## Customizing Agent Profiles

The default `guard-config.json` ships with a full set of pre-configured agents. You can:

1. **Keep the defaults** — copy `guard-config.json` as-is and start using the guard immediately
2. **Customize existing agents** — modify permissions, bash allowlists, delegation rules, or write scopes for any agent
3. **Add new agents** — create new agent entries following the same schema

Each agent profile supports these fields:

| Field | Type | Description |
|-------|------|-------------|
| `role` | string | Human-readable agent role |
| `allowEdit` | boolean | Whether the agent can use the `edit` tool |
| `bashAllowlist` | string[] | Allowed bash command patterns (`["*"]` = all) |
| `readOnlyDespiteFullBash` | boolean | Block shell mutations even with full bash access |
| `canWebfetch` | boolean | Whether the agent can use `webfetch` |
| `canDelegateTo` | string[] | Which agents this agent can delegate to (`["*"]` = all) |
| `canPreDelegate` | boolean | Whether the agent can operate in pre-delegation phase |
| `writeScope` | string | Restricted write directory (e.g., `sketches`, `spikes`, `planning`, `readme`, `all`) |
| `noTestExecution` | boolean | Block test execution via bash (e.g., `npm test`, `pytest`) |
| `delegation_rules` | object | Domain routing rules (`can_handle_directly` + `must_delegate_to`) |

### Delegation Rules Schema

```json
"delegation_rules": {
  "can_handle_directly": ["implementation", "bugfix"],
  "must_delegate_to": {
    "verification": "verifier",
    "testing": "tester"
  }
}
```

- `can_handle_directly`: domains this agent processes itself
- `must_delegate_to`: domains that must be routed to a specific agent

### Adding a Custom Agent

```json
"my-custom-agent": {
  "role": "my custom role",
  "allowEdit": true,
  "bashAllowlist": ["npm *", "node *"],
  "canWebfetch": false,
  "canDelegateTo": ["explorer"],
  "canPreDelegate": false,
  "writeScope": "all",
  "delegation_rules": {
    "can_handle_directly": ["my_domain"],
    "must_delegate_to": {}
  }
}
```

> **Note**: Custom agents also require a matching OpenCode agent definition file in your `.config/opencode/agents/` directory. The guard config alone does not create the agent — it only defines its permissions and routing.

## Custom Paths (Optional)

The guard uses several relative paths for logging and audit trails. All paths are relative to the plugin directory (`__dirname`):

| Path | Purpose | Customizable |
|------|---------|--------------|
| `.planning/guard-init.log` | Plugin bootstrap log | Yes — edit `initLogPath` in the factory |
| `.planning/audit/audit-YYYY-MM-DD.jsonl` | Structured audit trail | Yes — edit audit path in the plugin |
| `.planning/INCIDENTS.md` | Security block incidents (project dir) | Yes |
| `delegation-guard/guard-debug.jsonl` | Full I/O debug log | Yes — edit debug path |
| `delegation-guard-runtime.log` | Operational runtime log | Yes — edit `runtimeLogPath` |
| `.opencode/metrics_count.json` | Incident counters (project dir) | Yes |

To change these paths, edit the corresponding constants in `delegation-guard.js`.

## Configuration

`guard-config.json` defines agent profiles (bash allowlists, delegation rules, permissions). See the Agent Profiles section below for details.

## Core Security Pillars

### Anti-Loop Guard
Prevents infinite delegation loops via four rules applied to the delegation stack:

| Rule | Description |
|------|-------------|
| Self-loop | Blocks an agent delegating to itself |
| Ping-pong | Blocks repeated 2-cycle (A→B→A→B), not single legitimate iteration |
| Saturation | Same agent appears ≥4 times in the last 5 steps (backstop) |
| Max depth | Stack exceeding 5 levels is blocked |

The Orchestrator is exempt from anti-loop checks as root of every delegation chain.

### Sensitive File Protection
Every read tool call (read, grep, glob) is intercepted before any other check. The Guard blocks access to:

- **Critical**: `.env`, `.env.*`, SSH keys (`~/.ssh/id_*`), `.pem` files, AWS/GCP/Azure credentials
- **High**: `secrets/`, `credentials/`, `private/` directories; `.p12`, `.pfx`, `.jks`, `.netrc`, `.git-credentials`, `.docker/config.json` files
- **Medium**: `.npmrc` (may contain authentication tokens)

No agent is exempt — the block applies to all regardless of `bashAllowlist`. The exception allowing executor to access sensitive files was permanently removed (fix 2026-07-28).

### Bash Allowlists
Each agent has an allowed command pattern list following the principle of least privilege:

| Agent | bashAllowlist | readOnlyDespiteFullBash | Notes |
|-------|--------------|------------------------|-------|
| executor | `["*"]` | — | Full access; `noTestExecution: true` |
| verifier | `["*"]` | ✓ | Test/lint only; no file mutations |
| spiker | `["*"]` | — | Full access; write scope: spikes/ |
| codebase-mapper | `["*"]` | ✓ | Shell mutation blocked |
| code-reviewer | `["*"]` | ✓ | Shell mutation blocked |
| debugger | `["*"]` | ✓ | Shell mutation blocked; canWebfetch |
| explorer | `["*"]` | ✓ | Shell mutation blocked; canWebfetch |
| security-auditor | `["*"]` | ✓ | Shell mutation blocked |
| tester | `[]` | — | Total deny |
| sketcher | `[]` | — | Total deny |
| doc-writer | `[]` | — | Total deny |

**readOnlyDespiteFullBash**: this flag blocks file-mutating bash commands (PowerShell `Set-Content`/`Add-Content`/`Out-File`/`Remove-Item`, Python `open('w')`, Node `fs.writeFileSync`, `sed -i`, `tee`, `rm`, etc.) even for agents with `bashAllowlist: ["*"]`. The exception is writing to temporary directories (`AppData\Local\Temp`, `/tmp/`, `$env:TEMP`) which remains permitted.

**noTestExecution**: this flag blocks test execution (`npm test`, `pytest`, `jest`, `go test`, etc.) via bash. Active on executor — test execution is the verifier's responsibility.

In addition to the allowlist, the Guard enforces extra protections on every agent with bash:
- Recursive deletion on root, user, or Windows paths blocked
- `git push` with force flags on protected branches (main, master, develop, release/*) blocked
- `git add -f` with absolute path blocked
- Destructive system patterns (format, diskpart, recursive deletion) blocked
- Sensitive files accessible via shell (e.g., `Get-Content .env`) blocked for all agents

### Workflow Enforcement
The Guard enforces a mandatory delegation sequence:

1. **Diagnostic prerequisite**: executor requires a prior diagnostic agent (debugger, explorer, codebase-mapper) or a keyword/diagnostic file reference in the prompt. Exceptions for routine operations: ota, update, deploy, publish, release, commit, push.

2. **Post-executor verifier**: after executor, the next agent must be:
   - `verifier` — standard validation
   - `executor` — parallel executor (Swarm Mode)
   - `doc-writer` — documentation updates

   Verifier and doc-writer may operate autonomously (no preceding executor required).

### Routing Guard + Delegation Rules
Every task must declare a domain in the prompt (`domain:<name>`). The Guard verifies the target agent can handle that domain:

- If the agent can handle it directly → permitted
- If it must delegate to another agent → blocked with suggestion
- If domain is undeclared → error "Task domain not declared"

Recognized aliases: `architecture` → `architecture_analysis`, `security` → `security_audit`.

Routing includes a retry mechanism: max 3 attempts per (agent, domain) pair, then escalation to manual intervention.

**Documentation task detection**: if a non-doc-writer agent tries to edit `.md` or `.txt` files, the Guard blocks it automatically and suggests delegating to doc-writer. Detection uses three steps: (1) write verb in prompt, (2) anti-code check — if prompt mentions code files, it's not a documentation task, (3) verification of target .md/.txt files.

### Edit Guard
Intercepts `edit` calls and enforces:
- Verifies the agent profile allows edit
- Orchestrator cannot edit files directly
- Blocks changes in protected zones: `node_modules/`, `.git/`, `dist/`, `build/`
- Blocks path traversal (e.g., `../../etc/passwd`)

### Write Guard
Intercepts `write` calls and enforces:
- Same protected zones as Edit Guard
- Blocks overwriting existing files (exceptions: `*.log`, `*.tmp`, `*.bak`)
- Enforces per-agent write scope: sketcher → only `sketches/`, `mockups/`, `prototypes/`; spiker → only `spikes/`, `experiments/`, `prototypes/`, `tmp/`, `sandbox/`

### Webfetch Guard
Intercepts `webfetch` calls:
- Only `http://` and `https://` schemes permitted
- Orchestrator is always authorized
- For other agents, must be enabled in profile (`canWebfetch: true`) or prompt must contain "explicit user webfetch request"
- If identity is unknown (gray zone), webfetch is permitted but logged

### Secret Detection (Post-Execution)
After every tool call, the Guard scans output for credential patterns:
- **Critical**: GitHub PAT (`ghp_...`), AWS Access Key (`AKIA...`), private keys (RSA/EC/OPENSSH/DSA)
- **High**: URLs with credentials, Bearer tokens, Modal API keys, Supabase tokens, JWTs
- **Medium**: Generic API keys in JSON, private key file paths

When a secret is detected, the Guard actively modifies the output object replacing all string fields with `[REDACTED BY DELEGATION GUARD - SECURITY VIOLATION: SECRET DETECTED]` before the result returns to OpenCode. The action is active redaction, not just logging. Trusted agents (with `canDelegateTo: ["*"]`, e.g., executor and spiker) are exempt as they handle credentials legitimately.

## Identity Resolution

The Guard resolves agent identity at every tool call via a hierarchy:

1. `input.__injectedAgent` (legacy)
2. `global.currentActiveAgent` or `input.agent`
3. `state.lastAgent` (per-session crystallized identity)

### Crystallization
When the Orchestrator delegates a task, the target agent is captured in `global.currentActiveAgent`. At the first non-task tool call of the subagent, the identity is crystallized into per-session state (`state.lastAgent`), isolating it from overwrites by subsequent delegations.

### Cross-Type Parallelism Protection
If the Orchestrator attempts to delegate to a different agent type while another is still pending crystallization, the Guard blocks the delegation with an explicit error. Same-type delegations (Swarm Mode) are always permitted — only cross-type parallel is serialized.

The TTL for a pending uncrystallized agent is **15 seconds** (reduced from 60s on 2026-07-23 to avoid prolonged blocks during LLM outages).

### Gray Zone
If identity is unresolvable:
- **Read-only tools** (read, grep, glob): permitted with warning
- **Mutative tools** (bash, edit, write): permitted but logged. Downstream checks (allowlist, edit guard, write guard) apply only if they require a known profile.

### Orchestrator
The Orchestrator is detected by comparing the current session with `global.__orchestratorSessionID`. It may use `task` and `webfetch`/`websearch` without restrictions, but cannot directly use `glob`, `grep`, `read`, `sequential-thinking`, `todowrite`, `bash`, `edit`, `write` — it must delegate to a subagent.

## Agent Profiles

### Full Agent Table

| Agent | Role | bashAllowlist | readOnly | canPreDelegate | writeScope | allowEdit | canWebfetch | Notes |
|-------|------|--------------|----------|----------------|------------|-----------|-------------|-------|
| codebase-mapper | codebase mapping | `["*"]` | ✓ | true | all | false | false | Pre-delegation |
| code-reviewer | code analysis | `["*"]` | ✓ | false | all | false | false | lint, tsc, typecheck |
| debugger | diagnostics | `["*"]` | ✓ | false | all | false | true | canWebfetch for error lookups |
| doc-writer | documentation | `[]` | — | false | readme | true | false | Deny bash; docs scope |
| executor | implementation | `["*"]` | — | false | all | true | true | noTestExecution; verifier required after |
| explorer | research | `["*"]` | ✓ | true | planning | false | true | Pre-delegation |
| security-auditor | security audit | `["*"]` | ✓ | false | all | false | false | npm audit |
| sketcher | UI prototypes | `[]` | — | false | sketches | true | false | Deny bash; sketches/mockups/prototypes only |
| spiker | throwaway prototypes | `["*"]` | — | false | spikes | true | false | Full access; spikes/experiments/sandbox |
| tester | test writing | `[]` | — | false | all | true | false | Deny bash; writes tests, does not run them |
| verifier | validation | `["*"]` | ✓ | false | all | false | false | Test/lint only; no mutations |

`readOnly` = `readOnlyDespiteFullBash` — shell mutation blocked even with full bash.

Configuration is centralized in `guard-config.json`. Native OpenCode profiles (`.config/opencode/agents/*.md`) no longer contain bash permissions — everything is managed by the Guard.

### Delegation Rules per Agent
Each agent profile defines `delegation_rules` with:
- `can_handle_directly`: domains the agent can process directly
- `must_delegate_to`: domains that must be delegated to another agent

Example (executor):
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

## Configuration

### Agent Profiles
Edit `guard-config.json` (recommended) or the `createAgentProfilesFallback()` function in the plugin to:
- Add/remove agents
- Modify bash permissions, writeScope, canDelegateTo
- Configure delegation_rules

### Security Patterns
Edit constants in the plugin:
- `SENSITIVE_FILE_PATTERNS`: sensitive file patterns to protect
- `SECRET_PATTERNS`: credential patterns to detect in output
- `dangerousPatterns` / `destructiveSystemPatterns`: destructive commands to block

### Workflow Rules
Edit `workflowRules` in the plugin to control:
- Which agents require prerequisites
- Exceptions that bypass checks

### Trigger Reload
The Guard automatically detects changes to `guard-config.json` based on file `mtime` (checked every 5 seconds). No OpenCode restart needed — config changes are applied within 5 seconds of writing. The `guard-init.log` file confirms initial plugin loading.

## Observability

### Log Files

| File | Purpose | Location |
|------|---------|----------|
| `guard-init.log` | Plugin bootstrap | `.planning/` (relative to `__dirname`) |
| `guard-debug.jsonl` | Full I/O debug | `delegation-guard/` (relative to `__dirname`) |
| `delegation-guard-runtime.log` | Operational monitoring | Plugin directory (`__dirname`) |
| `audit-YYYY-MM-DD.jsonl` | Structured audit trail | `.planning/audit/` (relative to `__dirname`) |
| `INCIDENTS.md` | Security block registry | `.planning/` in project directory |
| `LESSONS.md` | Recurring patterns (≥2 incidents) | `~/.config/opencode/` |
| `metrics_count.json` | Incident counters by type | `.opencode/` in project directory |

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
Every `denied` event (security block) triggers `handleDeniedEvent()` which:
1. Writes a line to `.planning/INCIDENTS.md` in the project directory with a progressive ID (`INC-NNNN`), check name, date, agent, and reason
2. Updates counters in `.opencode/metrics_count.json`
3. If the same incident type (agent + check) repeats ≥2 times, writes a "lesson" to `~/.config/opencode/LESSONS.md` for cross-project persistent memory

Persistence is skipped if `_projectDirectory` is empty or points to `.opencode`/`plugins` (unreliable contexts).

### TUI Notifications
Every blocked action displays a real-time error toast in the OpenCode interface, showing the check name, agent, and first line of the block reason.

## Key Runtime Log Patterns

| Pattern | Meaning |
|---------|---------|
| `IDENTITY LOCK: session=... -> agent` | Identity crystallized for a session |
| `GRAY ZONE: tool "..." permitted` | Unknown identity, tool permitted in safe mode |
| `WORKFLOW CHECK PASSED: agent=...` | Workflow validation passed |
| `blocked: agent=..., check=..., reason=...` | Security block with details |
| `CLEANUP: global sequence reset` | Orchestrator session terminated |

## Known Limitations

| Limitation | Cause | Status |
|------------|-------|--------|
| tool.execute.before doesn't fire for subagent tool calls | OpenCode Bug | Workaround: identity crystallization |
| delegationSequence resets on new guard instance | State in `createDelegationGuard()` closure | SQLite persistence planned |
| Routing based on keywords, not semantic | Design choice | Deliberate — ensures determinism |

## Testing

Check functions are **private to the plugin closure** — no named exports. Tests verify behavior via the public API (`DelegationGuard` factory) by instantiating the guard with a mock client and simulating tool calls through the `tool.execute.before` hook.

`test-harness2.mjs` is included in this repository and covers 8 main suites:
1. Routing / domain declaration
2. Workflow sequence (fix requires diagnosis)
3. Sensitive file protection (read/grep/glob/edit/write/bash)
4. No test execution for executor
5. Shell mutation for `readOnlyDespiteFullBash` agents
6. Orchestrator tool restrictions
7. Swarm Mode — same-type parallel OK, cross-type blocked
8. Orchestrator hijack guard (subagent auto-delegation before crystallization)

## Key File Paths

| File | Purpose |
|------|---------|
| `delegation-guard.js` | Main plugin code (DelegationGuard factory + `tool.execute.before` hook) |
| `guard-config.json` | Agent profiles (runtime priority over JS fallback) |
| `test-harness2.mjs` | Automated test suite (34 scenarios) |
