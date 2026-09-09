# Contributing

## Before changing files

1. Read [`README.md`](../README.md), [`docs/configuration.md`](configuration.md), and the relevant agent profile.
2. Keep runtime behavior and configuration claims synchronized with `delegation-guard.js`, `guard-config.json`, and `test-harness2.mjs`.
3. Do not add credentials, private keys, or real secrets to source, fixtures, logs, or documentation.

## Changes

- Keep changes focused and deterministic.
- Preserve the public plugin entry point `DelegationGuard`.
- Update tests when behavior changes; do not weaken tests to hide regressions.
- Keep documentation examples valid JSON and valid OpenCode profile frontmatter.
- Do not edit generated audit artifacts as part of a feature change.

## Verification

Run from repository root:

```bash
node test-harness2.mjs
```

Review the complete output and confirm zero failures. If OpenCode compatibility is affected, test with the target OpenCode version as well.

## Pull requests

Describe behavior change, security impact, configuration impact, and verification command/output. Link relevant issues. Do not commit generated logs or local `.planning/` state.
