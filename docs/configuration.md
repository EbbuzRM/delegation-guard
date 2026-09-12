# Configuration and operations

`guard-config.json` is the external policy source for agent profiles. The plugin loads it from three candidate locations in order: (1) `.opencode/plugins/guard-config.json` inside the project directory, (2) `plugins/guard-config.json` at the project root, or (3) the installed plugin directory next to `delegation-guard.js`. External values override fallback values; arrays replace arrays.

## Profile schema

Configuration root:

| Field | Type | Meaning |
|---|---|---|
| `agentProfiles` | object | Map of agent name to profile. Required for external config to load. |

Profile fields:

| Field | Type | Meaning |
|---|---|---|
| `role` | string | Human-readable role. |
| `allowEdit` | boolean | Whether agent may use edit operations. |
| `bashAllowlist` | string[] | Allowed command patterns; `[]` denies shell commands. |
| `canWebfetch` | boolean | Enables web fetch for profile. |
| `canDelegateTo` | string[] | Allowed delegation targets; `*` permits all configured targets. |
| `trustedForSecrets` | boolean | When `true`, this agent's output skips secret redaction (`checkSecretsInOutput`). Default `false`. Explicit config only, never derived from `canDelegateTo`; the fallback safety-net never sets it (fail-closed). Currently enabled only for `executor` and `spiker`. |
| `canPreDelegate` | boolean | Allows pre-delegation behavior. |
| `writeScope` | string | Scope label such as `all`, `planning`, `readme`, `sketches`, or `spikes`. |
| `readOnlyDespiteFullBash` | boolean | Blocks mutating shell commands despite `bashAllowlist: ["*"]`. |
| `noTestExecution` | boolean | Blocks test commands for that profile. |
| `keywords` | string[] | Task-matching keywords for agent selection. Fallback-only; can be overridden. |
| `allowMentions` | string[] | Permitted analytical-context mentions that bypass `neverDo` checks. |
| `neverDo` | string[] | Forbidden action phrases; regex-matched against delegation prompts. |
| `delegation_rules` | object | Domain routing policy. |

`delegation_rules` contains:

```json
{
  "can_handle_directly": ["implementation"],
  "must_delegate_to": {
    "verification": "verifier"
  }
}
```

Every delegated task should declare `domain:<name>` (alternatively `task_domain:<name>` is accepted). `architecture` aliases to `architecture_analysis`; `security` aliases to `security_audit`.

## Shipped agents

The matching definitions are in [`agents/`](../agents/): `codebase-mapper`, `code-reviewer`, `debugger`, `doc-writer`, `executor`, `explorer`, `security-auditor`, `sketcher`, `spiker`, `tester`, `verifier`, and `orchestrator`. Install all files; permissions in frontmatter identify what OpenCode exposes, while runtime policy lives in `guard-config.json`.

## Data and log paths

| Path | Purpose |
|---|---|
| `delegation-guard-runtime.log` | Runtime diagnostics next to plugin file. Truncated to 1 MB on plugin load. |
| `.planning/audit/audit-YYYY-MM-DD.jsonl` | Structured audit events in the project directory (worktree fallback when `directory` is unreliable; plugin directory only as last resort). |
| `.planning/INCIDENTS.md` | Denied-event registry in project directory. |
| `.opencode/metrics_count.json` | Incident counters in project directory. |
| `.planning/LESSONS.md` | Repeated incident lessons in project directory (was `~/.config/opencode/LESSONS.md` before 2026-09-11; the old homedir file is not migrated). |
| `.planning/guard-init.log` | Plugin startup diagnostics next to plugin file. |
| `delegation-guard/guard-debug.jsonl` | Per-tool-call debug trace next to plugin file. Opt-in: written only when the environment variable `OPENCODE_GUARD_DEBUG=1` is set. |

Audit events contain timestamp, session ID, event type, agent, action, and optional details. Audit I/O failures are logged and do not block the guard.

## Security-relevant defaults

- Sensitive paths include environment files except conventional placeholders such as `.env.example`, SSH keys, cloud credential files, private-key formats, `.netrc`, `.git-credentials`, `.npmrc`, and Docker credentials.
- Shell checks reject sensitive-file access, destructive commands, protected-branch force pushes, and mutating commands for read-only profiles.
- Executor test execution is always blocked (`noTestExecution: true` is hardcoded in the fallback profile and in the shipped config); verifier owns validation.
- Secret output scanning recognizes selected GitHub, AWS, private-key, bearer, JWT, OpenAI, Slack, Google, Supabase, Modal, URL-credential, and generic JSON credential patterns.
- The guard excludes its own source/config/test files, log files, and specifically `.planning/BACKLOG.md` from output scanning because they contain textual examples. The backlog exclusion is path-scoped: another `BACKLOG.md` remains scanned. These files must still be handled as untrusted input.

## Known behavior

The runtime has a process-local delegation sequence. Restarting the plugin resets that state. The implementation also contains compatibility workarounds for OpenCode hook behavior; check the source and test harness when upgrading OpenCode.
