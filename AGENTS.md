## Token-Efficient Workflow

Default mode is lean.

- Inspect only files directly named by the task, plus their immediate dependencies and relevant tests.
- Use targeted `rg` searches with explicit paths; do not scan `.planning/`,
  audit logs, generated files, or the full repository unless the task
  actually requires them.

- Do not invoke Graphify automatically merely because the task concerns the
  codebase. Use it only when:
  - the user explicitly requests Graphify;
  - architecture or cross-module relationships are central to the task; or
  - a targeted investigation is insufficient and the existing graph can
    materially reduce the required exploration.

- Do not run `graphify update .` after ordinary code changes.
  Run it only after an explicit Graphify request or when the graph itself
  needs to remain synchronized for a task that actually used it.

- Use Obsidian project memory when historical context may materially affect
  the task, especially for previously investigated bugs, durable decisions,
  non-obvious workarounds, or known project constraints.

- Treat Obsidian indexes as routing information, not as a reason to load
  broad history. Start from compact indexes and follow only the specific
  bug/decision note relevant to the current task.

- Do not read broad Activity Log, Session Log, Changelog, or Releases history
  for routine work unless the task specifically requires historical session
  context.

- Record durable bug causes, fixes, decisions, constraints, and workarounds
  when they are genuinely useful for future work. Do not create memory entries
  for routine actions or temporary investigation details.

- Prefer a focused test or test section before the full harness.
  Run the full suite when the change affects shared behavior, security policy,
  broad infrastructure, or when focused verification is insufficient.

- Keep command output bounded. Prefer targeted searches and precise line ranges
  over dumping whole large files.

- Expand investigation autonomously when correctness requires it, but do not
  broaden scope merely to be exhaustive.