# Security policy

## Scope

Delegation Guard is deterministic OpenCode plugin middleware. It protects tool calls and selected tool outputs according to configured agent profiles. It is not a sandbox, credential store, or complete secret scanner.

## Reporting

This repository currently declares no dedicated security email, private advisory channel, or supported disclosure SLA. Do not publish an undisclosed vulnerability in an issue. Contact the repository maintainer through the project's GitHub account and request a private reporting channel:

<https://github.com/EbbuzRM/delegation-guard>

Include affected commit/version, reproduction steps, impact, and safe remediation details. Do not include live credentials; revoke any credential exposed during reproduction.

## Important caveats

- Secret matching is regex-based and limited to known formats.
- Output detection runs after tool execution. It can redact returned values and create audit events, but cannot prevent or reverse the completed operation.
- Output scanning is skipped only for agents with explicit `trustedForSecrets: true` in `guard-config.json` — currently `executor` and `spiker` — because they legitimately handle secrets during env setup and commits. Trust is explicit per-agent config, never derived from `canDelegateTo`.
- The guard blocks configured sensitive paths, but alternate encodings, generated commands, unsupported tools, and external processes may fall outside coverage.
- Audit persistence failures do not block guard decisions.

## Invarianti

- No agent may ever be granted `permission.task: allow`. Nested delegation is denied natively in OpenCode 1.18.30; the guard backstop `checkTaskSubDelegation` is the only barrier against drift or misconfiguration of custom agents (pinned by test suite section 26).
- The sessionID→agent registry is the primary identity source (the `agent` field is absent by design in `tool.execute.*` events).
- Fallback safety-net: bash, webfetch, and sub-delegation are fail-closed; routing is fail-operational.
- Secret-scan trust is explicit: only `trustedForSecrets: true` in `guard-config.json` disables output redaction (currently `executor` and `spiker`); it is never derived from `canDelegateTo`, and the fallback safety-net never sets it (fail-closed). Pinned by test suite section 27.

Use least-privilege profiles, keep credentials outside worktrees, review audit logs, and validate configuration changes before deployment.
