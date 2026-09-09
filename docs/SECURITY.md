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
- Output scanning is skipped only for agents whose `canDelegateTo` includes `'*'` — currently `executor` and `spiker` — because they legitimately handle secrets during env setup and commits. Any custom agent with wildcard delegation becomes exempt under the same rule.
- The guard blocks configured sensitive paths, but alternate encodings, generated commands, unsupported tools, and external processes may fall outside coverage.
- Audit persistence failures do not block guard decisions.

Use least-privilege profiles, keep credentials outside worktrees, review audit logs, and validate configuration changes before deployment.
