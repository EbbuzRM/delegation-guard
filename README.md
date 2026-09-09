# Delegation Guard

Deterministic security middleware for [OpenCode](https://opencode.ai/) multi-agent orchestration. Zero LLM dependencies -- every rule is a pure function.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Also serves as a workaround for several OpenCode bugs.

> **What this is -- and what it is NOT.** Delegation Guard is a deterministic policy-enforcement layer. It is **not** a sandbox, credential store, or complete secret scanner. Post-execution redaction (via `tool.execute.after`) cannot undo a tool action that already ran. Trusted agents -- those with `canDelegateTo: ["*"]`, currently `executor` and `spiker` -- are exempt from output scanning by design. The guard's own source, configuration, and test files are excluded from scanning because they contain textual pattern examples; treat them as untrusted input. See [SECURITY.md](docs/SECURITY.md) for full caveats.

| Without the guard | With Delegation Guard |
|---|---|
| No enforcement layer for credential-path access by default | Sensitive-file blocks apply to read, grep, glob, edit, write, and bash |
| Agent delegates in a loop forever / cross-type parallel collisions | Anti-loop limits + parallelism rules |
| File changes follow ad-hoc permission prompts and session settings -- no fixed per-agent policy | Per-agent write scope + edit guard enforced on every call |
| Secrets leak into tool output | Redaction on non-trusted output |
| No trace of why a tool call happened | JSONL audit trail + denied-event registry |

## Quick Start

### 30-second flow

1. **Prerequisites:** Node.js (any recent version supporting ES module `import`) and [OpenCode](https://opencode.ai/) with plugin support enabled.
2. Follow [Installation from source](#installation-from-source) for the complete setup.
3. From the repository, run `node test-harness2.mjs` to verify the guard in isolation (no OpenCode required). Expected result: 21 suites, 92 assertions, all passing.
4. Restart OpenCode after installation. The guard is live.

## What it protects

- **Routing and domain enforcement** -- agent identity resolution, delegation rules, anti-loop limits, and cross-type parallelism restrictions.
- **Per-agent policies** -- edit permissions, write-scope boundaries, bash command allowlists, web-fetch access, and test-execution gating.
- **Sensitive-file protection** -- blocks read, grep, glob, edit, write, and bash access to credential paths (`.env`, SSH keys, cloud credential files, etc.) while allowing conventional placeholders like `.env.example`.
- **Secret detection and redaction** -- scans non-trusted agent output for known credential patterns (GitHub, AWS, OpenAI, Slack, Google, private keys, JWT, and more) and redacts matches in returned objects.
- **Audit trail** -- JSONL audit events, denied-event registry (`INCIDENTS.md`), incident counters, repeated-incident lessons, and runtime diagnostics across plugin and project directories.
- **Workflow prerequisites** -- enforces diagnostic-before-executor and verifier-after-executor sequences, plus a conductor-rules gate before the first delegation.

## How it works

```
Agent tool call
       |
       v
 Resolve identity (session -> agent profile)
       |
       v
 +---------------------+
 | Guard checks:       |
 | - Routing / domain  |
 | - Workflow phase    |
 | - Sensitive file    |
 | - Bash allowlist    |
 | - Edit / write      |
 | - Web fetch         |
 | - Scope boundary    |
 +---------------------+
       |
  +---------+---------+
  |         |         |
  v         v         v
 Allow    Block    Redact output
  |         |         |
  v         v         v
 Tool runs  Error   Tool runs + secrets removed
  |         |         |
  +---------+---------+
            |
            v
     Audit log (JSONL)
```

## Installation from source

### 1. Clone

```bash
git clone https://github.com/EbbuzRM/delegation-guard.git
cd delegation-guard
```

### 2. Install plugin, configuration, and agent profiles

**Unix/macOS:**

```bash
mkdir -p ~/.config/opencode/plugins/delegation-guard ~/.config/opencode/agents
cp delegation-guard.js guard-config.json ~/.config/opencode/plugins/delegation-guard/
cp agents/*.md ~/.config/opencode/agents/
```

**Windows PowerShell:**

```powershell
$plugin = "$env:USERPROFILE\.config\opencode\plugins\delegation-guard"
$agents = "$env:USERPROFILE\.config\opencode\agents"
New-Item -ItemType Directory -Force -Path $plugin, $agents | Out-Null
Copy-Item delegation-guard.js, guard-config.json $plugin
Copy-Item agents\*.md $agents
```

Keep each `agents/*.md` file. They define the agent identities that `guard-config.json` governs; copying only the plugin does not create those agents.

### 3. Install conductor-rules skill

The guard blocks orchestration delegations unless the `conductor-rules` skill is available. Copy it to OpenCode's user skills directory (lowercase folder name):

**Unix/macOS:**

```bash
mkdir -p ~/.config/opencode/skills/conductor-rules
cp skill/Conductor-rules/SKILL.md ~/.config/opencode/skills/conductor-rules/
```

**Windows PowerShell:**

```powershell
$skill = "$env:USERPROFILE\.config\opencode\skills\conductor-rules"
New-Item -ItemType Directory -Force -Path $skill | Out-Null
Copy-Item skill\Conductor-rules\SKILL.md $skill
```

### 4. Enable the plugin in OpenCode

Plugins placed in OpenCode's `~/.config/opencode/plugins/` directory may be auto-loaded. This source-install flow uses explicit `opencode.json` (or `opencode.jsonc`) registration for deterministic setup; add a `file:///` entry to the `plugin` array:

```json
{
  "plugin": [
    "file:///C:/Users/YOU/.config/opencode/plugins/delegation-guard/delegation-guard.js"
  ]
}
```

On Unix/macOS the path is:

```json
{
  "plugin": [
    "file:///home/YOU/.config/opencode/plugins/delegation-guard/delegation-guard.js"
  ]
}
```

Restart OpenCode after editing the config. See the [OpenCode plugin documentation](https://opencode.ai/docs/plugins/) for the full reference on local paths and npm-based plugins.

## Prerequisites

- Node.js (any recent version supporting ES module `import`)
- [OpenCode](https://opencode.ai/) with plugin support enabled
- The `conductor-rules` skill installed as described above
- Agent profile `.md` files copied into the OpenCode `agents/` directory

## Configuration

Everything is centralized in `guard-config.json`. Each agent profile declares its permissions, delegation targets, write scope, and domain routing. Minimal custom-agent entry:

```json
{
  "agentProfiles": {
    "my-agent": {
      "role": "custom role",
      "allowEdit": false,
      "bashAllowlist": [],
      "canWebfetch": false,
      "canDelegateTo": [],
      "canPreDelegate": false,
      "writeScope": "all",
      "delegation_rules": {
        "can_handle_directly": ["research"],
        "must_delegate_to": {}
      }
    }
  }
}
```

The runtime deep-merges external profiles with its built-in fallback profiles; **arrays replace** inherited arrays (they do not concatenate). Add a matching `my-agent.md` under OpenCode's `agents/` directory.

For the full field reference, shipped-agent list, data paths, and defaults, see [docs/configuration.md](docs/configuration.md). To contribute, see [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

## Examples

### Blocked `.env` read

When an agent attempts to read a sensitive file, the guard blocks the call and throws:

```
❌ SENSITIVE FILE: sensitive file access blocked for agent "executor". Tool: read, File: C:\App\project\.env, Pattern: env_files, Severity: critical
```

The same block applies to `grep`, `glob`, `edit`, `write`, and `bash` commands that reference credential paths (SSH keys, cloud credential files, etc.). Conventional placeholders like `.env.example` are allowed.

### Audit event

Every blocked call is written as a JSONL line to `.planning/audit/audit-YYYY-MM-DD.jsonl`:

```json
{"timestamp":"2026-09-09T14:23:07.123+02:00","sessionId":"ses_abc123","eventType":"denied","agent":"executor","action":"blocked","details":{"check":"sensitive_file","error":"❌ SENSITIVE FILE: sensitive file access blocked for agent \"executor\". Tool: read, File: .env, Pattern: env_files, Severity: critical","filePath":".env","tool":"read"}}
```

Audit events use the schema `{ timestamp, sessionId, eventType, agent, action, details }` where `eventType` is one of `denied`, `delegation`, `webfetch`, `sensitive`, `secret`, or `mcp_tool_usage`, and `action` is one of `blocked`, `executed`, `allowed`, `observed`, or `redacted`. See [docs/configuration.md](docs/configuration.md) for the full field reference.

## Troubleshooting

**Delegations are blocked with a conductor-rules error.**
Install the conductor-rules skill. See step 3 in [Installation from source](#installation-from-source). The skill must be in `~/.config/opencode/skills/conductor-rules/SKILL.md`.

**Agent keeps getting routing errors.**
Every delegated task must declare a domain. Add `domain:<name>` to the task prompt (the alias `task_domain:<name>` is also accepted). The domain must match an entry in the agent's `can_handle_directly` list or its `must_delegate_to` map.

**Secrets visible in output anyway.**
Output scanning is post-execution (`tool.execute.after`). The tool already ran; redaction only cleans the returned object. Check the audit log for what was captured, and keep credentials outside the worktree.

**Guard not loading.**
Ensure the plugin is listed in your OpenCode configuration and that `delegation-guard.js` and `guard-config.json` are in the plugin directory. Verify that agent `.md` files are in the OpenCode `agents/` directory.

## Limitations

- Routing is keyword/domain-based, not semantic.
- `tool.execute.after` secret detection is post-execution; it can redact returned values but cannot undo a completed tool action.
- Regex scanning covers known patterns only; it is not comprehensive secret scanning.
- Guard state is process-local; delegation sequence state does not persist across a new guard instance.
- OpenCode hook behavior can vary by version; compatibility follows the checked-in plugin API dependency.

## Docs and contributing

- [Configuration and operations](docs/configuration.md) -- full field reference, data paths, defaults
- [Security policy](docs/SECURITY.md) -- reporting, caveats, scope
- [Contributing](docs/CONTRIBUTING.md) -- how to change the guard or documentation
- [Issues](https://github.com/EbbuzRM/delegation-guard/issues) -- reproducible bugs and usage questions

## License

[MIT](./LICENSE)
