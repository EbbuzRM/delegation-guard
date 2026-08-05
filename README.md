# Delegation Guard

> Deterministic security middleware for OpenCode multi-agent orchestration.  
> **Zero LLM dependencies.** Every rule is a pure function, testable in isolation.

---

## 📑 Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
  - [Default Agents](#default-agents)
  - [Adding a Custom Agent](#adding-a-custom-agent)
  - [Custom Paths](#custom-paths)
- [Core Security Pillars](#-core-security-pillars)
  - [Anti-Loop Guard](#anti-loop-guard)
  - [Sensitive File Protection](#sensitive-file-protection)
  - [Bash Allowlists](#bash-allowlists)
  - [Workflow Enforcement](#workflow-enforcement)
  - [Routing Guard & Delegation Rules](#routing-guard--delegation-rules)
  - [Edit Guard](#edit-guard)
  - [Write Guard](#write-guard)
  - [Webfetch Guard](#webfetch-guard)
  - [Secret Detection](#secret-detection)
- [Identity Resolution](#-identity-resolution)
  - [Crystallization](#crystallization)
  - [Cross-Type Parallelism Protection](#cross-type-parallelism-protection)
  - [Gray Zone](#gray-zone)
  - [Orchestrator](#orchestrator)
- [Agent Profiles](#-agent-profiles)
  - [Full Agent Table](#full-agent-table)
  - [Delegation Rules per Agent](#delegation-rules-per-agent)
- [Observability](#-observability)
  - [Log Files](#log-files)
  - [Audit Event Schema](#audit-event-schema)
  - [Incident Tracking](#incident-tracking)
  - [TUI Notifications](#tui-notifications)
- [Key Runtime Log Patterns](#-key-runtime-log-patterns)
- [Known Limitations](#-known-limitations)
- [Testing](#-testing)
- [Contributing](#-contributing)

---

## Overview

**Delegation Guard** is a fully deterministic security middleware designed for OpenCode multi-agent orchestration. It acts as a protective layer between OpenCode and its agents, enforcing strict security policies, routing rules, and workflow constraints — without relying on any LLM.

Every guard rule is implemented as a **pure function**, making the system:
- ✅ **Deterministic** — same input always yields same output
- ✅ **Testable** — each rule can be unit-tested in isolation
- ✅ **Auditable** — every decision is logged with full traceability

> 🔧 **Note:** This project also serves as a workaround for several bugs in the OpenCode platform.

---

## Features

| Feature | Description |
|---------|-------------|
| 🔒 **Deterministic Security** | No LLM involvement — pure function-based rule enforcement |
| 🛡️ **Multi-Layer Protection** | Anti-loop, sensitive file, bash, edit, write, webfetch guards |
| 🧭 **Smart Routing** | Domain-based task routing with delegation rules |
| 🔍 **Secret Detection** | Active redaction of credentials in tool outputs |
| 📊 **Full Observability** | Structured audit trails, incident tracking, real-time notifications |
| 🧪 **Comprehensive Testing** | 34 automated scenarios covering all guard behaviors |

---

## Installation

1. Clone the repository:
```bash
git clone https://github.com/EbbuzRM/delegation-guard.git
cd delegation-guard
```

2. Copy the default configuration:
```bash
cp guard-config.json.example guard-config.json
```

3. Ensure the guard is loaded by OpenCode as a plugin (see [OpenCode plugin documentation](https://docs.opencode.ai/plugins)).

---

## Quick Start

1. **Review the default configuration** in `guard-config.json` — it ships with a full set of pre-configured agents.

2. **Run the test harness** to verify everything works:
```bash
node test-harness2.mjs
```

3. **Start OpenCode** — the guard will automatically intercept and validate all agent tool calls.

---

## Configuration

All agent permissions and routing rules are centralized in `guard-config.json`. Native OpenCode agent profiles (`.config/opencode/agents/*.md`) no longer contain bash permissions — everything is managed by the Guard.

### Default Agents

The default `guard-config.json` ships with pre-configured agents. Each agent profile includes:

```json
{
  "delegation_rules": {
    "can_handle_directly": ["implementation", "bugfix"],
    "must_delegate_to": {
      "verification": "verifier",
      "testing": "tester"
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `can_handle_directly` | Domains this agent can process itself |
| `must_delegate_to` | Domains that must be routed to a specific agent |

### Adding a Custom Agent

Add a new entry to `guard-config.json`:

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

> ⚠️ **IMPORTANT:** Custom agents also require a matching OpenCode agent definition file in your `.config/opencode/agents/` directory. The guard config alone does not create the agent — it only defines its permissions and routing.

### Custom Paths

The guard uses several relative paths for logging and audit trails. All paths are relative to the plugin directory (`__dirname`):

| Path | Purpose | Customizable |
|------|---------|------------|
| `.planning/guard-init.log` | Plugin bootstrap log | Yes — edit `initLogPath` in the factory |
| `.planning/audit/audit-YYYY-MM-DD.jsonl` | Structured audit trail | Yes — edit audit path in the plugin |
| `.planning/INCIDENTS.md` | Security block incidents (project dir) | Yes |
| `delegation-guard/guard-debug.jsonl` | Full I/O debug log | Yes — edit debug path |
| `delegation-guard-runtime.log` | Operational runtime log | Yes — edit `runtimeLogPath` |
| `.opencode/metrics_count.json` | Incident counters (project dir) | Yes |

To change these paths, edit the corresponding constants in `delegation-guard.js`.

---

## 🛡️ Core Security Pillars

### Anti-Loop Guard

Prevents infinite delegation loops via four rules applied to the delegation stack:

| Rule | Description |
|------|-------------|
| **Self-loop** | Blocks an agent delegating to itself |
| **Ping-pong** | Blocks repeated 2-cycle (A→B→A→B), not single legitimate iteration |
| **Saturation** | Same agent appears ≥4 times in the last 5 steps (backstop) |
| **Max depth** | Stack exceeding 5 levels is blocked |

> ⏱️ **Note:** The Orchestrator is exempt from anti-loop checks as root of every delegation chain.

### Sensitive File Protection

Every read tool call (`read`, `grep`, `glob`) is intercepted before any other check. The Guard blocks access to:

| Severity | Files / Patterns |
|----------|------------------|
| **Critical** | `.env`, `.env.*`, SSH keys (`~/.ssh/id_*`), `.pem` files, AWS/GCP/Azure credentials |
| **High** | `secrets/`, `credentials/`, `private/` directories; `.p12`, `.pfx`, `.jks`, `.netrc`, `.git-credentials`, `.docker/config.json` |
| **Medium** | `.npmrc` (may contain authentication tokens) |

> 🔒 **IMPORTANT:** No agent is exempt — the block applies to all regardless of `bashAllowlist`. The exception allowing executor to access sensitive files was permanently removed (fix 2026-07-28).

### Bash Allowlists

Each agent has an allowed command pattern list following the principle of least privilege:

| Agent | `bashAllowlist` | `readOnlyDespiteFullBash` | Notes |
|-------|-----------------|------------------------|-------|
| `executor` | `["*"]` | — | Full access; `noTestExecution: true` |
| `verifier` | `["*"]` | ✅ | Test/lint only; no file mutations |
| `spiker` | `["*"]` | — | Full access; write scope: `spikes/` |
| `codebase-mapper` | `["*"]` | ✅ | Shell mutation blocked |
| `code-reviewer` | `["*"]` | ✅ | Shell mutation blocked |
| `debugger` | `["*"]` | ✅ | Shell mutation blocked; `canWebfetch` |
| `explorer` | `["*"]` | ✅ | Shell mutation blocked; `canWebfetch` |
| `security-auditor` | `["*"]` | ✅ | Shell mutation blocked |
| `tester` | `[]` | — | Total deny |
| `sketcher` | `[]` | — | Total deny |
| `doc-writer` | `[]` | — | Total deny |

**`readOnlyDespiteFullBash`**: blocks file-mutating bash commands (PowerShell `Set-Content`/`Add-Content`/`Out-File`/`Remove-Item`, Python `open('w')`, Node `fs.writeFileSync`, `sed -i`, `tee`, `rm`, etc.) even for agents with `bashAllowlist: ["*"]`. Exception: writing to temporary directories (`AppData\Local\Temp`, `/tmp/`, `$env:TEMP`) remains permitted.

**`noTestExecution`**: blocks test execution (`npm test`, `pytest`, `jest`, `go test`, etc.) via bash. Active on `executor` — test execution is the `verifier`'s responsibility.

**Additional bash protections:**
- Recursive deletion on root, user, or Windows paths → **blocked**
- `git push` with force flags on protected branches (`main`, `master`, `develop`, `release/*`) → **blocked**
- `git add -f` with absolute path → **blocked**
- Destructive system patterns (`format`, `diskpart`, recursive deletion) → **blocked**
- Sensitive files accessible via shell (e.g., `Get-Content .env`) → **blocked for all agents**

### Workflow Enforcement

The Guard enforces a mandatory delegation sequence:

1. **Diagnostic prerequisite**: `executor` requires a prior diagnostic agent (`debugger`, `explorer`, `codebase-mapper`) or a keyword/diagnostic file reference in the prompt.
   - **Exceptions for routine operations**: `ota`, `update`, `deploy`, `publish`, `release`, `commit`, `push`.

2. **Post-executor verifier**: after `executor`, the next agent must be:
   - `verifier` — standard validation
   - `executor` — parallel executor (Swarm Mode)
   - `doc-writer` — documentation updates

> **Note:** `verifier` and `doc-writer` may operate autonomously (no preceding `executor` required).

### Routing Guard & Delegation Rules

Every task must declare a domain in the prompt (`domain:<name>`). The Guard verifies the target agent can handle that domain:

- If the agent can handle it directly → **permitted**
- If it must delegate to another agent → **blocked with suggestion**
- If domain is undeclared → **error "Task domain not declared"**

**Recognized aliases:**
- `architecture` → `architecture_analysis`
- `security` → `security_audit`

**Retry mechanism:** max 3 attempts per `(agent, domain)` pair, then escalation to manual intervention.

**Documentation task detection:** if a non-`doc-writer` agent tries to edit `.md` or `.txt` files, the Guard blocks it automatically and suggests delegating to `doc-writer`. Detection uses three steps:
1. Write verb in prompt
2. Anti-code check — if prompt mentions code files, it's not a documentation task
3. Verification of target `.md`/`.txt` files

### Edit Guard

Intercepts edit calls and enforces:

- Verifies the agent profile allows edit
- Orchestrator cannot edit files directly
- Blocks changes in protected zones: `node_modules/`, `.git/`, `dist/`, `build/`
- Blocks path traversal (e.g., `../../etc/passwd`)

### Write Guard

Intercepts write calls and enforces:

- Same protected zones as Edit Guard
- Blocks overwriting existing files (exceptions: `*.log`, `*.tmp`, `*.bak`)
- Enforces per-agent write scope:
  - `sketcher` → only `sketches/`, `mockups/`, `prototypes/`
  - `spiker` → only `spikes/`, `experiments/`, `prototypes/`, `tmp/`, `sandbox/`

### Webfetch Guard

Intercepts `webfetch` calls:

- Only `http://` and `https://` schemes permitted
- Orchestrator is always authorized
- For other agents, must be enabled in profile (`canWebfetch: true`) or prompt must contain `"explicit user webfetch request"`
- If identity is unknown (gray zone), webfetch is permitted but logged

### Secret Detection

After every tool call, the Guard scans output for credential patterns:

| Severity | Patterns |
|----------|----------|
| **Critical** | GitHub PAT (`ghp_...`), AWS Access Key (`AKIA...`), private keys (RSA/EC/OPENSSH/DSA) |
| **High** | URLs with credentials, Bearer tokens, Modal API keys, Supabase tokens, JWTs |
| **Medium** | Generic API keys in JSON, private key file paths |

When a secret is detected, the Guard **actively modifies** the output object, replacing all string fields with:

```
[REDACTED BY DELEGATION GUARD - SECURITY VIOLATION: SECRET DETECTED]
```

This is **active redaction**, not just logging.

> **Note:** Trusted agents (with `canDelegateTo: ["*"]`, e.g., `executor` and `spiker`) are exempt as they handle credentials legitimately.

---

## 🔍 Identity Resolution

The Guard resolves agent identity at every tool call via a hierarchy:

1. `input.__injectedAgent` (legacy)
2. `global.currentActiveAgent` or `input.agent`
3. `state.lastAgent` (per-session crystallized identity)

### Crystallization

When the Orchestrator delegates a task, the target agent is captured in `global.currentActiveAgent`. At the first non-task tool call of the subagent, the identity is crystallized into per-session state (`state.lastAgent`), isolating it from overwrites by subsequent delegations.

### Cross-Type Parallelism Protection

If the Orchestrator attempts to delegate to a different agent type while another is still pending crystallization, the Guard blocks the delegation with an explicit error. Same-type delegations (Swarm Mode) are always permitted — only cross-type parallel is serialized.

> ⏱️ **Note:** The TTL for a pending uncrystallized agent is **15 seconds** (reduced from 60s on 2026-07-23 to avoid prolonged blocks during LLM outages).

### Gray Zone

If identity is unresolvable:

- **Read-only tools** (`read`, `grep`, `glob`): permitted with warning
- **Mutative tools** (`bash`, `edit`, `write`): permitted but logged. Downstream checks (allowlist, edit guard, write guard) apply only if they require a known profile.

### Orchestrator

The Orchestrator is detected by comparing the current session with `global.__orchestratorSessionID`. It may use `task` and `webfetch`/`websearch` without restrictions, but cannot directly use `glob`, `grep`, `read`, `sequential-thinking`, `todowrite`, `bash`, `edit`, `write` — it must delegate to a subagent.

---

## 🤖 Agent Profiles

### Full Agent Table

| Agent | Role | `bashAllowlist` | `readOnly` | `canPreDelegate` | `writeScope` | `allowEdit` | `canWebfetch` | Notes |
|-------|------|-----------------|------------|------------------|--------------|-------------|---------------|-------|
| `codebase-mapper` | codebase mapping | `["*"]` | ✅ | `true` | `all` | `false` | `false` | Pre-delegation |
| `code-reviewer` | code analysis | `["*"]` | ✅ | `false` | `all` | `false` | `false` | lint, tsc, typecheck |
| `debugger` | diagnostics | `["*"]` | ✅ | `false` | `all` | `false` | `true` | canWebfetch for error lookups |
| `doc-writer` | documentation | `[]` | — | `false` | `readme` | `true` | `false` | Deny bash; docs scope |
| `executor` | implementation | `["*"]` | — | `false` | `all` | `true` | `true` | noTestExecution; verifier required after |
| `explorer` | research | `["*"]` | ✅ | `true` | `planning` | `false` | `true` | Pre-delegation |
| `security-auditor` | security audit | `["*"]` | ✅ | `false` | `all` | `false` | `false` | npm audit |
| `sketcher` | UI prototypes | `[]` | — | `false` | `sketches` | `true` | `false` | Deny bash; sketches/mockups/prototypes only |
| `spiker` | throwaway prototypes | `["*"]` | — | `false` | `spikes` | `true` | `false` | Full access; spikes/experiments/sandbox |
| `tester` | test writing | `[]` | — | `false` | `all` | `true` | `false` | Deny bash; writes tests, does not run them |
| `verifier` | validation | `["*"]` | ✅ | `false` | `all` | `false` | `false` | Test/lint only; no mutations |

> `readOnly` = `readOnlyDespiteFullBash` — shell mutation blocked even with full bash.

> **Note:** Configuration is centralized in `guard-config.json`. Native OpenCode profiles (`.config/opencode/agents/*.md`) no longer contain bash permissions — everything is managed by the Guard.

### Delegation Rules per Agent

Each agent profile defines `delegation_rules` with:

- `can_handle_directly`: domains the agent can process directly
- `must_delegate_to`: domains that must be delegated to another agent

**Example (executor):**

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

---

## 📊 Observability

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

Every denied event (security block) triggers `handleDeniedEvent()` which:

1. Writes a line to `.planning/INCIDENTS.md` in the project directory with:
   - Progressive ID (`INC-NNNN`)
   - Check name
   - Date
   - Agent
   - Reason

2. Updates counters in `.opencode/metrics_count.json`

3. If the same incident type (`agent` + `check`) repeats ≥2 times, writes a "lesson" to `~/.config/opencode/LESSONS.md` for cross-project persistent memory

> **Note:** Persistence is skipped if `_projectDirectory` is empty or points to `.opencode/plugins` (unreliable contexts).

### TUI Notifications

Every blocked action displays a real-time error toast in the OpenCode interface, showing:
- Check name
- Agent name
- First line of the block reason

---

## 📝 Key Runtime Log Patterns

| Pattern | Meaning |
|---------|---------|
| `IDENTITY LOCK: session=... -> agent` | Identity crystallized for a session |
| `GRAY ZONE: tool "..." permitted` | Unknown identity, tool permitted in safe mode |
| `WORKFLOW CHECK PASSED: agent=...` | Workflow validation passed |
| `blocked: agent=..., check=..., reason=...` | Security block with details |
| `CLEANUP: global sequence reset` | Orchestrator session terminated |

---

## ⚠️ Known Limitations

| Limitation | Cause | Status |
|------------|-------|--------|
| `tool.execute.before` doesn't fire for subagent tool calls | OpenCode Bug | Workaround: identity crystallization |
| `delegationSequence` resets on new guard instance | State in `createDelegationGuard()` closure | SQLite persistence planned |
| Routing based on keywords, not semantic | Design choice | Deliberate — ensures determinism |

---

## 🧪 Testing

Check functions are private to the plugin closure — no named exports. Tests verify behavior via the public API (`DelegationGuard` factory) by instantiating the guard with a mock client and simulating tool calls through the `tool.execute.before` hook.

`test-harness2.mjs` is included in this repository and covers **8 main suites**:

1. Routing / domain declaration
2. Workflow sequence (fix requires diagnosis)
3. Sensitive file protection (read/grep/glob/edit/write/bash)
4. No test execution for executor
5. Shell mutation for `readOnlyDespiteFullBash` agents
6. Orchestrator tool restrictions
7. Swarm Mode — same-type parallel OK, cross-type blocked
8. Orchestrator hijack guard (subagent auto-delegation before crystallization)

### Running Tests

```bash
node test-harness2.mjs
```

The test harness imports from `./delegation-guard.js` — make sure the path matches your setup.

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

*Built with 💻 and ☕ for secure multi-agent orchestration.*
