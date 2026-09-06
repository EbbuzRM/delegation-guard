import { DelegationGuard } from './delegation-guard.js';
import { readFileSync, existsSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const mockClient = { tui: { showToast: async () => {} } };
const testRoot = mkdtempSync(path.join(os.tmpdir(), 'delegation-guard-harness-'));
process.chdir(testRoot);
function projectRoot() {
  mkdirSync(testRoot, { recursive: true });
  return testRoot;
}
const guard = await DelegationGuard({
  project: { id: 'test-project' },
  client: mockClient,
  $: async () => {},
  directory: projectRoot('main'),
  worktree: projectRoot('main')
});
const before = guard['tool.execute.before'];

let pass = 0, fail = 0;
const failures = [];
let callID = 0;
let subCounter = 0;

async function preloadConductorRules(guardObj, sessionID) {
  // Normalize like the hook does internally (input.sessionID || 'default') —
  // orchSession may arrive undefined from callers relying on the default.
  const sid = sessionID || 'default';
  // Register sid as the root (Orchestrator) session via the event hook
  // "session.created" — same production mechanism (see guard4/event4
  // below) — so isOrchestrator resolves true for this sessionID IMMEDIATELY,
  // without going through a real task call (which self-heals only AFTERWARDS,
  // too late to unlock the gate on the task call itself).
  const eventFn = guardObj['event'];
  if (eventFn) {
    await eventFn({ event: { type: 'session.created', properties: { sessionID: sid, info: { agent: 'orchestrator' } } } });
  }
  const beforeFn = guardObj['tool.execute.before'];
  callID++;
  return beforeFn(
    { tool: 'skill', sessionID: sid, callID: 'call_' + callID },
    { args: { name: 'conductor-rules' } }
  );
}

async function delegateAndCrystallize(subagentType, description, prompt, orchSession) {
  // 0. Preload conductor-rules to avoid hitting gate 2.6 (not the focus here)
  await preloadConductorRules(guard, orchSession);
  // 1. The Orchestrator delegates (from its own session)
  callID++;
  await before(
    { tool: 'task', sessionID: orchSession, callID: 'call_' + callID },
    { args: { subagent_type: subagentType, description, prompt } }
  );
  // 2. The subagent (new session) makes a first harmless tool call to crystallize
  subCounter++;
  const subSession = 'ses_sub_' + subCounter;
  callID++;
  await before(
    { tool: 'read', sessionID: subSession, callID: 'call_' + callID, args: { filePath: 'README.md' } },
    { args: { filePath: 'README.md' } }
  );
  return subSession;
}

async function expectPass(name, fn) {
  try { await fn(); pass++; }
  catch (e) { fail++; failures.push(`[SHOULD PASS] ${name} -> BLOCKED: ${e.message.split('\n')[0]}`); }
}
async function expectBlock(name, fn, mustContain) {
  try {
    await fn();
    fail++; failures.push(`[SHOULD BLOCK] ${name} -> PASSED without errors`);
  } catch (e) {
    if (mustContain && !e.message.includes(mustContain)) {
      fail++; failures.push(`[WRONG MESSAGE] ${name} -> "${e.message.split('\n')[0]}" (expected to contain "${mustContain}")`);
    } else pass++;
  }
}
function call(tool, sessionID, args) {
  callID++;
  return before({ tool, sessionID, callID: 'call_' + callID, args }, { args });
}
async function taskCall(subagentType, description, prompt, orchSession = 'ses_orch_' + (++subCounter)) {
  // Preload conductor-rules to avoid hitting gate 2.6 (not the focus here)
  await preloadConductorRules(guard, orchSession);
  callID++;
  return before(
    { tool: 'task', sessionID: orchSession, callID: 'call_' + callID },
    { args: { subagent_type: subagentType, description, prompt } }
  );
}

// ============================================================
console.log('--- 1. ROUTING / DOMAIN ---');
await expectPass('correct domain: executor/implementation with diagnosis', async () => {
  await taskCall('executor', 'domain:implementation - fix bug X', 'domain:implementation root cause identified, apply fix to bug X');
  await call('read', 'ses_sub_r1', { filePath: 'a.txt' });
});

await expectBlock('missing domain', () =>
  taskCall('executor', 'fix bug X without domain', 'Apply fix to bug X'), 'Undeclared task domain');

await expectPass('domain alias: architecture -> architecture_analysis', async () => {
  await taskCall('codebase-mapper', 'domain:architecture - map project', 'domain:architecture Map architecture');
  await call('read', 'ses_sub_r2', { filePath: 'b.txt' });
});

await expectBlock('wrong domain for agent (review on code-reviewer)', () =>
  taskCall('code-reviewer', 'domain:review - analysis', 'domain:review Analyze the plan'), 'exists but is managed by');

await expectPass('correct domain for code-reviewer: quality_analysis', async () => {
  await taskCall('code-reviewer', 'domain:quality_analysis - code analysis', 'domain:quality_analysis Analyze code quality');
  await call('read', 'ses_sub_r3', { filePath: 'c.txt' });
});

console.log('--- 2. WORKFLOW: fix requires diagnosis ---');
await expectBlock('executor fix without prior diagnosis', () =>
  taskCall('executor', 'domain:implementation - fix bug Y', 'domain:implementation Fix bug Y'), 'Fix requires diagnosis first');

await expectPass('executor fix with root cause in prompt', async () => {
  await taskCall('executor', 'domain:implementation - fix bug Y', 'domain:implementation The root cause is: fix for bug Y');
  await call('read', 'ses_sub_r4', { filePath: 'd.txt' });
});

console.log('--- 3. SENSITIVE FILES (read/grep/glob/edit/write/bash) ---');
for (const tool of ['read', 'grep', 'glob']) {
  const sess = await delegateAndCrystallize('executor', 'domain:implementation - read config', 'domain:implementation root cause known, read config');
  await expectBlock(`sensitive file via ${tool}`, () => call(tool, sess, { filePath: 'C:\\App\\project\\.env' }));
}
{
  const sess = await delegateAndCrystallize('executor', 'domain:implementation - read file', 'domain:implementation root cause known, read app.py');
  await expectPass('normal file read', () => call('read', sess, { filePath: 'C:\\App\\project\\app.py' }));
}
{
  const sess = await delegateAndCrystallize('executor', 'domain:implementation - edit config', 'domain:implementation root cause known, modify config');
  await expectBlock('sensitive file via edit', () => call('edit', sess, { filePath: 'C:\\App\\project\\.env', oldString: 'a', newString: 'b' }));
}
{
  const sess = await delegateAndCrystallize('executor', 'domain:implementation - write config', 'domain:implementation root cause known, write config');
  await expectBlock('sensitive file via write', () => call('write', sess, { filePath: 'C:\\App\\project\\.env', content: 'x' }));
}
{
  const sess = await delegateAndCrystallize('executor', 'domain:implementation - bash config', 'domain:implementation root cause known, read with bash');
  await expectBlock('sensitive file via bash Get-Content', () => call('bash', sess, { command: 'Get-Content "C:\\Users\\test\\.env"' }));
}
{
  const sess = await delegateAndCrystallize('executor', 'domain:implementation - npm install', 'domain:implementation root cause known, install dependencies');
  await expectPass('normal bash command (npm install)', () => call('bash', sess, { command: 'npm install' }));
}
{
  // Reported by the user on 2026-08-25: .env.example holds no real secrets
  // (it only documents which variables exist) — blocking it like .env makes no sense.
  const sess = await delegateAndCrystallize('executor', 'domain:implementation - read env example', 'domain:implementation root cause known, read env example');
  await expectPass('.env.example NOT blocked', () => call('read', sess, { filePath: '.env.example' }));
  await expectPass('.env.sample NOT blocked', () => call('read', sess, { filePath: '.env.sample' }));
  await expectPass('.env.template NOT blocked', () => call('read', sess, { filePath: 'config/.env.template' }));
  // Regression: the other .env suffixes stay blocked.
  await expectBlock('.env.local stays blocked', () => call('read', sess, { filePath: '.env.local' }));
  await expectBlock('.env.production stays blocked', () => call('read', sess, { filePath: '.env.production' }));
  await expectBlock('test.env stays blocked', () => call('read', sess, { filePath: 'test.env' }));
}

console.log('--- 4. NO TEST EXECUTION for executor ---');
{
  const sess = await delegateAndCrystallize('executor', 'domain:implementation - run tests', 'domain:implementation root cause known, verify');
  await expectBlock('executor cannot run npm test', () => call('bash', sess, { command: 'npm test' }), 'TEST EXECUTION');
  await expectBlock('executor cannot run pytest', () => call('bash', sess, { command: 'pytest tests/' }), 'TEST EXECUTION');
}
{
  // Real incident on 2026-08-25: `git add` on files whose NAME contains a
  // test-runner keyword (jest.setup.js, *.test.ts) was mistaken
  // for a test execution — "naked" patterns (\bjest\b etc.) matched
  // anywhere in the string, not only when the tool was really invoked.
  const sess = await delegateAndCrystallize('executor', 'domain:implementation - git add test file', 'domain:implementation root cause known, git add');
  await expectPass('git add on files with "jest"/"test" in the name NOT blocked', () =>
    call('bash', sess, { command: 'git add services/AuthService.ts hooks/__tests__/useEmailAuth.test.ts jest.setup.js services/__tests__/AuthService.test.ts' }));
  await expectPass('git status on a project with test files in the path NOT blocked', () =>
    call('bash', sess, { command: 'git status --short' }));
  await expectPass('reading pytest.ini/phpunit.xml/mocha.opts NOT blocked', () =>
    call('bash', sess, { command: 'cat pytest.ini phpunit.xml mocha.opts' }));
  // Regression: a REAL invocation stays blocked even with test files around.
  await expectBlock('really invoked jest stays blocked for executor', () =>
    call('bash', sess, { command: 'jest --coverage' }), 'TEST EXECUTION');
  await expectBlock('jest after another command (&&) stays blocked', () =>
    call('bash', sess, { command: 'npm run build && jest' }), 'TEST EXECUTION');
  // Second real incident, same day: "jest" inside a quoted regex alternation
  // in quotes (text search, not execution) — the previous fix
  // anchored "|" as a shell pipe, but a "|" with no space before the tool is
  // almost always regex alternation, not a real pipe.
  await expectPass('"jest" inside a quoted regex pattern (grep-like) NOT blocked', () =>
    call('bash', sess, { command: 'git diff -- package.json | Select-String -Pattern "^[+-]\\s+\\"" | Select-String -Pattern "vector-icons|bottom-tabs|react-native|typescript|jest|metro|expo/cli|types/react"' }));
  await expectBlock('jest after a REAL pipe (with space) stays blocked', () =>
    call('bash', sess, { command: 'npm run lint | jest' }), 'TEST EXECUTION');
}
{
  const sess = await delegateAndCrystallize('verifier', 'domain:verification - run tests', 'domain:verification run the test suite');
  await expectPass('verifier CAN run npm test', () => call('bash', sess, { command: 'npm test' }));
}

console.log('--- 5. SHELL MUTATION for readOnlyDespiteFullBash agents ---');
{
  const sess = await delegateAndCrystallize('verifier', 'domain:verification - quick fix', 'domain:verification verify the file');
  await expectBlock('verifier cannot write via Set-Content', () => call('bash', sess, { command: 'Set-Content -Path file.py -Value "x"' }), 'SHELL MUTATION');
  await expectPass('verifier redirection 2>&1 not blocked', () => call('bash', sess, { command: 'npx jest --runInBand 2>&1' }));
}
{
  const sess = await delegateAndCrystallize('debugger', 'domain:debugging - diagnosis', 'domain:debugging diagnose the problem');
  await expectBlock('debugger cannot write via sed -i', () => call('bash', sess, { command: 'sed -i "s/old/new/" file.py' }), 'SHELL MUTATION');
}

console.log('--- 6. ORCHESTRATOR cannot use tools directly ---');
{
  const orchSession = 'ses_orch_direct_test';
  // Establish orchSession as a recognized Orchestrator (self-healing) with
  // a real delegation, before testing direct blocks — otherwise isOrchestrator
  // resolves false for this session (nobody ever saw it delegate).
  await taskCall('executor', 'domain:implementation - establish orchestrator', 'domain:implementation root cause known, establish', orchSession);
  for (const tool of ['bash', 'edit', 'write', 'grep', 'glob']) {
    await expectBlock(`orchestrator cannot use ${tool} directly`, () =>
      call(tool, orchSession, tool === 'bash' ? { command: 'echo hi' } : { filePath: 'x.txt' }));
  }
  await expectPass('orchestrator CAN use read directly', () =>
    call('read', orchSession, { filePath: 'x.txt' }));
  await expectPass('orchestrator CAN use webfetch directly', () =>
    call('webfetch', orchSession, { url: 'https://example.com' }));
  await expectPass('orchestrator CAN use websearch directly', () =>
    call('websearch', orchSession, { query: 'test' }));
  await expectPass('orchestrator CAN use todowrite', () =>
    call('todowrite', orchSession, { todos: [] }));
}

console.log('--- 7. SWARM MODE: parallel same-agent OK, different types blocked ---');
{
  // Fresh instance to avoid leftover pendingAgentTypes from previous sections
  const guard2 = await DelegationGuard({
    project: { id: 'test-project-swarm' }, client: mockClient, $: async () => {},
    directory: projectRoot('swarm'), worktree: projectRoot('swarm')
  });
  const before2 = guard2['tool.execute.before'];
  async function taskCall2(subagentType, description, prompt, orchSession) {
    callID++;
    return before2(
      { tool: 'task', sessionID: orchSession, callID: 'call_' + callID },
      { args: { subagent_type: subagentType, description, prompt } }
    );
  }

  const orchSessionA = 'ses_orch_swarm_testA';
  await preloadConductorRules(guard2, orchSessionA);
  await expectPass('first parallel executor', () =>
    taskCall2('executor', 'domain:implementation - step1', 'domain:implementation root cause known, step1', orchSessionA));
  await expectPass('second parallel executor (swarm, same type OK)', () =>
    taskCall2('executor', 'domain:implementation - step2', 'domain:implementation root cause known, step2', orchSessionA));

  const orchSessionB = 'ses_orch_swarm_testB';
  const guard3 = await DelegationGuard({
    project: { id: 'test-project-swarm2' }, client: mockClient, $: async () => {},
    directory: projectRoot('swarm2'), worktree: projectRoot('swarm2')
  });
  const before3 = guard3['tool.execute.before'];
  async function taskCall3(subagentType, description, prompt, orchSession) {
    callID++;
    return before3(
      { tool: 'task', sessionID: orchSession, callID: 'call_' + callID },
      { args: { subagent_type: subagentType, description, prompt } }
    );
  }
  await preloadConductorRules(guard3, orchSessionB);
  await expectPass('first explorer delegation', () =>
    taskCall3('explorer', 'domain:exploration - ctx', 'domain:exploration gather context', orchSessionB));
  await expectBlock('parallel delegation of different type blocked (explorer still pending)', () =>
    taskCall3('codebase-mapper', 'domain:architecture - map', 'domain:architecture map architecture', orchSessionB),
    'PARALLEL CONFLICT');
}

console.log('--- 8. ORCHESTRATOR HIJACK GUARD: subagent self-delegates before crystallizing ---');
{
  // Regression for the 2026-08-05 bug: a subagent session whose identity is not
  // yet crystallized (no real tool call made) and whose first action is a
  // direct delegation (e.g. verifier->executor via canDelegateTo) was mistaken for a
  // new Orchestrator, hijacking orchestratorSessionID and leaving the REAL
  // Orchestrator unprotected. Fix: subagentRegistry (session.created) prevents
  // hijacking once the registry has confirmed the session is a CHILD.
  const guard4 = await DelegationGuard({
    project: { id: 'test-project-hijack' }, client: mockClient, $: async () => {},
    directory: projectRoot('hijack'), worktree: projectRoot('hijack')
  });
  const before4 = guard4['tool.execute.before'];
  const event4 = guard4['event'];
  function call4(tool, sessionID, args) {
    callID++;
    return before4({ tool, sessionID, callID: 'call_' + callID, args }, { args });
  }

  const orchSession = 'ses_orch_hijack_test';
  await preloadConductorRules(guard4, orchSession);
  callID++;
  await before4(
    { tool: 'task', sessionID: orchSession, callID: 'call_' + callID },
    { args: { subagent_type: 'verifier', description: 'domain:verification - verify fix', prompt: 'domain:verification verify the applied fix' } }
  );

  const verifierSession = 'ses_sub_verifier_hijack_test';
  // Simulate session.created (registry) for verifier BEFORE it makes any
  // real tool call — frees pendingAgentTypes (fast-release) but does NOT crystallize
  // state.lastAgent (that requires a non-task tool call).
  await event4({ event: { type: 'session.created', properties: { sessionID: verifierSession, info: { parentID: orchSession, agent: 'verifier' } } } });

  await expectPass('verifier (not crystallized) delegates directly to executor', () => {
    callID++;
    return before4(
      { tool: 'task', sessionID: verifierSession, callID: 'call_' + callID },
      { args: { subagent_type: 'executor', description: 'domain:implementation - apply fix', prompt: 'domain:implementation root cause: verification failed, apply fix' } }
    );
  });

  await expectPass('Orchestrator can use read after verifier self-delegation', () =>
    call4('read', orchSession, { filePath: 'x.txt' }));

  await expectPass('verifier NOT mistaken for Orchestrator after delegating', () =>
    call4('read', verifierSession, { filePath: 'y.txt' }));
}

console.log('--- 9. CONDUCTOR-RULES GATE: skill must load before the first delegation ---');
{
  const guardGateBlock = await DelegationGuard({
    project: { id: 'test-project-gate-block' }, client: mockClient, $: async () => {},
    directory: projectRoot('gate-block'), worktree: projectRoot('gate-block')
  });
  const beforeGB = guardGateBlock['tool.execute.before'];
  await expectBlock('orchestrator delegates without loading conductor-rules', () => {
    callID++;
    return beforeGB(
      { tool: 'task', sessionID: 'ses_orch_gate_block', callID: 'call_' + callID },
      { args: { subagent_type: 'executor', description: 'domain:implementation - test gate', prompt: 'domain:implementation root cause known, test gate' } }
    );
  }, 'conductor-rules');

  await expectPass('retry after loading conductor-rules to a different target causes no parallel conflict', async () => {
    callID++;
    await beforeGB(
      { tool: 'skill', sessionID: 'ses_orch_gate_block', callID: 'call_' + callID },
      { args: { name: 'conductor-rules' } }
    );
    callID++;
    await beforeGB(
      { tool: 'task', sessionID: 'ses_orch_gate_block', callID: 'call_' + callID },
      { args: { subagent_type: 'codebase-mapper', description: 'domain:architecture - retry gate', prompt: 'domain:architecture map architecture after loading rules' } }
    );
  });
}
{
  const guardGateAllow = await DelegationGuard({
    project: { id: 'test-project-gate-allow' }, client: mockClient, $: async () => {},
    directory: projectRoot('gate-allow'), worktree: projectRoot('gate-allow')
  });
  const beforeGA = guardGateAllow['tool.execute.before'];
  await expectPass('orchestrator loads conductor-rules then delegates successfully', async () => {
    callID++;
    await beforeGA(
      { tool: 'skill', sessionID: 'ses_orch_gate_allow', callID: 'call_' + callID },
      { args: { name: 'conductor-rules' } }
    );
    callID++;
    await beforeGA(
      { tool: 'task', sessionID: 'ses_orch_gate_allow', callID: 'call_' + callID },
      { args: { subagent_type: 'executor', description: 'domain:implementation - test gate ok', prompt: 'domain:implementation root cause known, test gate ok' } }
    );
  });
}
{
  const guardGateSub = await DelegationGuard({
    project: { id: 'test-project-gate-sub' }, client: mockClient, $: async () => {},
    directory: projectRoot('gate-sub'), worktree: projectRoot('gate-sub')
  });
  const beforeGS = guardGateSub['tool.execute.before'];
  const orchSessionGS = 'ses_orch_gate_sub_setup';
  // Preload conductor-rules on the same guard/session: the task only serves
  // to create the subagent for the next test, not to test the gate.
  callID++;
  await beforeGS(
    { tool: 'skill', sessionID: orchSessionGS, callID: 'call_' + callID },
    { args: { name: 'conductor-rules' } }
  );
  callID++;
  await beforeGS(
    { tool: 'task', sessionID: orchSessionGS, callID: 'call_' + callID },
    { args: { subagent_type: 'verifier', description: 'domain:verification - setup subagent', prompt: 'domain:verification setup subagent for gate test' } }
  );

  const subSessionGS = 'ses_sub_gate_nonorch';
  // Crystallize the subagent identity (lastAgent=verifier) with a real tool call,
  // like in the other sections (e.g. delegateAndCrystallize).
  callID++;
  await beforeGS(
    { tool: 'read', sessionID: subSessionGS, callID: 'call_' + callID, args: { filePath: 'x.txt' } },
    { args: { filePath: 'x.txt' } }
  );

  await expectPass('subagent (non-orchestrator) delegates without hitting the conductor-rules gate', () => {
    callID++;
    return beforeGS(
      { tool: 'task', sessionID: subSessionGS, callID: 'call_' + callID },
      { args: { subagent_type: 'executor', description: 'domain:implementation - delegate from subagent', prompt: 'domain:implementation root cause known, delegate from subagent' } }
    );
  });
}
{
  // Simulate a plugin process restart (e.g. closing/reopening OpenCode)
  // on the SAME sessionID: a new DelegationGuard instance starts with
  // an empty in-memory Map sessionState, but the session message history
  // (via client.session.messages) already holds a Skill('conductor-rules') call.
  // The gate must not require loading it a second time.
  const restartSessionID = 'ses_orch_gate_restart';
  const mockClientWithHistory = {
    tui: { showToast: async () => {} },
    session: {
      messages: async ({ path }) => {
        if (path?.id !== restartSessionID) return { data: [] };
        return {
          data: [{
            info: { id: 'msg_1' },
            parts: [{
              type: 'tool', tool: 'skill', callID: 'call_prev',
              state: { status: 'completed', input: { name: 'conductor-rules' }, output: '', title: '', metadata: {}, time: { start: 0, end: 0 } }
            }]
          }]
        };
      }
    }
  };
  const guardGateRestart = await DelegationGuard({
    project: { id: 'test-project-gate-restart' }, client: mockClientWithHistory, $: async () => {},
    directory: projectRoot('gate-restart'), worktree: projectRoot('gate-restart')
  });
  const beforeGR = guardGateRestart['tool.execute.before'];
  await expectPass('after plugin restart (empty Map) on the same session, history confirms conductor-rules already loaded', () => {
    callID++;
    return beforeGR(
      { tool: 'task', sessionID: restartSessionID, callID: 'call_' + callID },
      { args: { subagent_type: 'executor', description: 'domain:implementation - test gate restart', prompt: 'domain:implementation root cause known, test gate restart' } }
    );
  });
}

console.log('--- 10. SCOPE VIOLATION REPEAT-TARGET ESCALATION: same out-of-scope path repeated ---');
{
  // NOTE: we use a real temp directory and RELATIVE filePaths — this mirrors how
  // normalizePathForCheck really works (strips a single leading "/", not the project prefix)
  // and validatePathZone (containment via path.resolve). With a fake project dir
  // and prefixed absolute filePaths, the SCOPE check (which expects "spikes/...")
  // would always fail regardless of the real scope, invalidating the test.
  const guardScope = await DelegationGuard({
    project: { id: 'test-project-scope-escalate' }, client: mockClient, $: async () => {},
    directory: projectRoot('scope-escalate'), worktree: projectRoot('scope-escalate')
  });
  const beforeSE = guardScope['tool.execute.before'];
  const eventSE = guardScope['event'];
  const orchSessionSE = 'ses_orch_scope_escalate';
  const subSessionSE = 'ses_sub_scope_escalate';

  // Register the root session as Orchestrator and the child session as spiker,
  // via the session.created event hook — same production mechanism (see section 9).
  await eventSE({ event: { type: 'session.created', properties: { sessionID: orchSessionSE, info: { agent: 'orchestrator' } } } });
  await eventSE({ event: { type: 'session.created', properties: { sessionID: subSessionSE, info: { agent: 'spiker', parentID: orchSessionSE } } } });

  const outOfScopePath = 'src/real-fix.ts';

  await expectBlock('1st attempt on out-of-scope path: generic SCOPE error, no escalation', () => {
    callID++;
    return beforeSE(
      { tool: 'write', sessionID: subSessionSE, callID: 'call_' + callID, args: { filePath: outOfScopePath, content: 'x' } },
      { args: { filePath: outOfScopePath, content: 'x' } }
    );
  }, 'SCOPE');

  await expectBlock('2nd attempt on the SAME out-of-scope path: escalation to ROUTING/redelegate', () => {
    callID++;
    return beforeSE(
      { tool: 'write', sessionID: subSessionSE, callID: 'call_' + callID, args: { filePath: outOfScopePath, content: 'y' } },
      { args: { filePath: outOfScopePath, content: 'y' } }
    );
  }, 'ROUTING');

  const otherOutOfScopePath = 'src/other-file.ts';
  await expectBlock('attempt on a DIFFERENT, never-seen path: generic SCOPE error (no premature escalation)', () => {
    callID++;
    return beforeSE(
      { tool: 'write', sessionID: subSessionSE, callID: 'call_' + callID, args: { filePath: otherOutOfScopePath, content: 'z' } },
      { args: { filePath: otherOutOfScopePath, content: 'z' } }
    );
  }, 'SCOPE');

  await expectPass('write inside own writeScope stays allowed', () => {
    callID++;
    return beforeSE(
      { tool: 'write', sessionID: subSessionSE, callID: 'call_' + callID, args: { filePath: 'spikes/ok.js', content: 'x' } },
      { args: { filePath: 'spikes/ok.js', content: 'x' } }
    );
  });
}

console.log('--- 11. PRE-DELEGATION PHASE: "question" tool (interactive questions) always allowed ---');
{
  const guardPreDeleg = await DelegationGuard({
    project: { id: 'test-project-pre-delegation' }, client: mockClient, $: async () => {},
    directory: projectRoot('pre-delegation'), worktree: projectRoot('pre-delegation')
  });
  const beforePD = guardPreDeleg['tool.execute.before'];
  const orchSessionPD = 'ses_orch_pre_delegation';

  // Preload conductor-rules (gate 2.6) on the Orchestrator session.
  callID++;
  await beforePD(
    { tool: 'skill', sessionID: orchSessionPD, callID: 'call_' + callID },
    { args: { name: 'conductor-rules' } }
  );

  // Delegate to explorer (canPreDelegate: true) -> puts the Orchestrator into pre-delegation phase.
  callID++;
  await beforePD(
    { tool: 'task', sessionID: orchSessionPD, callID: 'call_' + callID },
    { args: { subagent_type: 'explorer', description: 'domain:exploration - map the auth module', prompt: 'domain:exploration map the auth module before delegating the fix' } }
  );

  await expectPass('"question" tool allowed in pre-delegation phase (interactive user question)', () => {
    callID++;
    return beforePD(
      { tool: 'question', sessionID: orchSessionPD, callID: 'call_' + callID, args: { text: 'Proceed with option A or B?' } },
      { args: { text: 'Proceed with option A or B?' } }
    );
  });

  await expectBlock('bash stays forbidden in pre-delegation phase (no unintended relaxation)', () => {
    callID++;
    return beforePD(
      { tool: 'bash', sessionID: orchSessionPD, callID: 'call_' + callID, args: { command: 'ls' } },
      { args: { command: 'ls' } }
    );
  }, 'Delegate');

  // Real incident on 2026-08-25: the Orchestrator, after delegating to explorer
  // (canPreDelegate: true → pre-delegation phase) to have a file's content reported
  // back, tried to use its own exclusive MCP tool
  // supabase_apply_migration — blocked because it was missing from the old
  // fixed allowlist. No dynamic MCP tool can be enumerated in advance,
  // so the pre-delegation phase is now a DENYLIST (same tools always forbidden
  // to the Orchestrator) instead of an allowlist.
  await expectPass('never-seen dynamic MCP tool (e.g. supabase_apply_migration) allowed in pre-delegation phase', () => {
    callID++;
    return beforePD(
      { tool: 'supabase_apply_migration', sessionID: orchSessionPD, callID: 'call_' + callID, args: { project_id: 'x', name: 'y', query: 'SELECT 1;' } },
      { args: { project_id: 'x', name: 'y', query: 'SELECT 1;' } }
    );
  });
}

console.log('--- 12. SHELL MUTATION via direct .NET (named PowerShell cmdlet bypass) ---');
{
  // Real incident on 2026-08-14: "debugger" (readOnlyDespiteFullBash) wrote
  // a file via [System.IO.File]::WriteAllText() instead of a cmdlet like
  // Set-Content — no pattern covered it, the command passed as read-only.
  //
  // Dedicated instance (not the shared `guard` from sections 1-7 via delegateAndCrystallize):
  // 'default' accumulates dozens of delegations across previous sections, and the anti-loop
  // saturation guard could block delegation to debugger, leaving currentActiveAgent
  // on the wrong agent — a false
  // negative of the TEST, not of the Guard. Identity via registry (session.created), as in
  // section 10, avoids the problem entirely.
  const guardNet = await DelegationGuard({
    project: { id: 'test-project-dotnet-mutation' }, client: mockClient, $: async () => {},
    directory: projectRoot('dotnet-mutation'), worktree: projectRoot('dotnet-mutation')
  });
  const beforeNet = guardNet['tool.execute.before'];
  const eventNet = guardNet['event'];
  const orchSessionNet = 'ses_orch_dotnet_mutation';
  const subSessionNet = 'ses_sub_dotnet_mutation';
  await eventNet({ event: { type: 'session.created', properties: { sessionID: orchSessionNet, info: { agent: 'orchestrator' } } } });
  await eventNet({ event: { type: 'session.created', properties: { sessionID: subSessionNet, info: { agent: 'debugger', parentID: orchSessionNet } } } });

  await expectBlock('.NET File.WriteAllText (full System.IO) blocked for debugger', () => {
    callID++;
    const command = '[System.IO.File]::WriteAllText("C:\\App\\project\\out.txt", $content)';
    return beforeNet(
      { tool: 'bash', sessionID: subSessionNet, callID: 'call_' + callID, args: { command } },
      { args: { command } }
    );
  }, 'SHELL MUTATION');

  await expectBlock('.NET File.AppendAllLines ([IO.File] accelerator) blocked for debugger', () => {
    callID++;
    const command = '[IO.File]::AppendAllLines("C:\\App\\project\\log.txt", $lines)';
    return beforeNet(
      { tool: 'bash', sessionID: subSessionNet, callID: 'call_' + callID, args: { command } },
      { args: { command } }
    );
  }, 'SHELL MUTATION');

  await expectBlock('.NET Directory.CreateDirectory blocked for debugger', () => {
    callID++;
    const command = '[System.IO.Directory]::CreateDirectory("C:\\App\\project\\newdir")';
    return beforeNet(
      { tool: 'bash', sessionID: subSessionNet, callID: 'call_' + callID, args: { command } },
      { args: { command } }
    );
  }, 'SHELL MUTATION');

  await expectPass('.NET File.ReadAllText stays allowed (read-only) for debugger', () => {
    callID++;
    const command = '[System.IO.File]::ReadAllText("C:\\App\\project\\in.txt")';
    return beforeNet(
      { tool: 'bash', sessionID: subSessionNet, callID: 'call_' + callID, args: { command } },
      { args: { command } }
    );
  });
}

console.log('--- 13. UNKNOWN SUBAGENT_TYPE: delegating to an unconfigured agent must block, not pass silently ---');
{
  // Real incident on 2026-08-15: delegating to "general" (native generic OpenCode
  // agent, absent from guard-config.json) ran with ZERO enforcement —
  // the old code did a silent `return`, skipping all checks.
  const guardUnknown = await DelegationGuard({
    project: { id: 'test-project-unknown-agent' }, client: mockClient, $: async () => {},
    directory: projectRoot('unknown-agent'), worktree: projectRoot('unknown-agent')
  });
  const beforeUA = guardUnknown['tool.execute.before'];
  const orchSessionUA = 'ses_orch_unknown_agent';

  callID++;
  await beforeUA(
    { tool: 'skill', sessionID: orchSessionUA, callID: 'call_' + callID },
    { args: { name: 'conductor-rules' } }
  );

  await expectBlock('delegation to unconfigured subagent_type "general" blocked', () => {
    callID++;
    return beforeUA(
      { tool: 'task', sessionID: orchSessionUA, callID: 'call_' + callID },
      { args: { subagent_type: 'general', description: 'domain:implementation - quick fix', prompt: 'domain:implementation root cause known, quick fix' } }
    );
  }, 'ROUTING');

  await expectPass('task without subagent_type causes no custom block (OpenCode rejects at schema level)', () => {
    callID++;
    return beforeUA(
      { tool: 'task', sessionID: orchSessionUA, callID: 'call_' + callID },
      { args: { description: 'domain:implementation - fix without target', prompt: 'domain:implementation root cause known' } }
    );
  });
}

console.log('--- 14. SECRET SCAN: false positive when reading the Guard source files ---');
{
  // Real incident on 2026-08-15: delegation-guard.js holds TEXTUAL examples of
  // sensitive patterns in its own comments (documenting what the patterns
  // detect) — reading it triggered redaction of the whole file. Verify both
  // that the Guard files are now excluded, and that generic detection on
  // OTHER files was NOT weakened by the exclusion.
  const guardSecret = await DelegationGuard({
    project: { id: 'test-project-secret-scan' }, client: mockClient, $: async () => {},
    directory: projectRoot('secret-scan'), worktree: projectRoot('secret-scan')
  });
  const eventSecret = guardSecret['event'];
  const beforeSecret = guardSecret['tool.execute.before'];
  const afterSecret = guardSecret['tool.execute.after'];
  const subSessionSecret = 'ses_sub_secret_scan';
  await eventSecret({ event: { type: 'session.created', properties: { sessionID: subSessionSecret, info: { agent: 'debugger', parentID: 'ses_orch_secret_scan' } } } });
  // Crystallize state.lastAgent='debugger' — tool.execute.after reads ONLY
  // state.lastAgent (sessionState, populated by tool.execute.before), not the
  // subagentRegistry populated by the event hook above.
  callID++;
  await beforeSecret(
    { tool: 'read', sessionID: subSessionSecret, callID: 'call_' + callID, args: { filePath: 'README.md' } },
    { args: { filePath: 'README.md' } }
  );

  await expectPass('reading delegation-guard.js is NOT redacted (contains only textual examples)', async () => {
    const output = { args: { filePath: 'C:\\Users\\test\\.opencode\\plugins\\delegation-guard.js' }, output: 'sample comment: .ssh folder, id_rsa key in path .ssh/id_rsa' };
    await afterSecret({ tool: 'read', sessionID: subSessionSecret }, output);
    if (output.output.includes('REDACTED')) {
      throw new Error(`expected intact content, found: ${output.output}`);
    }
  });

  await expectPass('reading a NON-excluded file with a real secret still gets redacted (no regression)', async () => {
    const output = { args: { filePath: 'C:\\Users\\test\\project\\some-other-file.js' }, output: 'private key: .ssh/id_rsa' };
    await afterSecret({ tool: 'read', sessionID: subSessionSecret }, output);
    if (!output.output.includes('REDACTED')) {
      throw new Error(`expected REDACTED, found intact content: ${output.output}`);
    }
  });
}

console.log('--- 15. PATH TRAVERSAL BYPASS: worktree fallback when directory is unreliable ---');
{
  // Real incident: when `directory` ends up inside .opencode/plugins (known
  // OpenCode bug), the old code skipped the ENTIRE containment check —
  // no other check stops an absolute path outside the project. Now it uses `worktree`
  // as the fallback root before giving up with a total skip.
  const guardTraversal = await DelegationGuard({
    project: { id: 'test-project-traversal' }, client: mockClient, $: async () => {},
    directory: 'C:\\Users\\test\\.opencode\\plugins', // unreliable on purpose
    worktree: 'C:\\Users\\test\\real-project' // reliable fallback
  });
  const beforeTrav = guardTraversal['tool.execute.before'];
  const eventTrav = guardTraversal['event'];
  const subSessionTrav = 'ses_sub_traversal';
  await eventTrav({ event: { type: 'session.created', properties: { sessionID: subSessionTrav, info: { agent: 'executor', parentID: 'ses_orch_traversal' } } } });

  await expectBlock('write outside the fallback worktree gets blocked (was: no block)', () => {
    callID++;
    const filePath = 'C:\\Windows\\System32\\evil.txt';
    return beforeTrav(
      { tool: 'write', sessionID: subSessionTrav, callID: 'call_' + callID, args: { filePath, content: 'x' } },
      { args: { filePath, content: 'x' } }
    );
  }, 'PATH OUT OF PROJECT');

  await expectPass('write inside the fallback worktree stays allowed', () => {
    callID++;
    const filePath = 'C:\\Users\\test\\real-project\\src\\ok.txt';
    return beforeTrav(
      { tool: 'write', sessionID: subSessionTrav, callID: 'call_' + callID, args: { filePath, content: 'x' } },
      { args: { filePath, content: 'x' } }
    );
  });
}

console.log('--- 16. INCIDENTS.md INJECTION: newline in an error must not forge fake entries ---');
{
  const injectionProjectDir = mkdtempSync(path.join(os.tmpdir(), 'delegation-guard-incidents-injection-'));
  const guardInj = await DelegationGuard({
    project: { id: 'test-project-injection' }, client: mockClient, $: async () => {},
    directory: injectionProjectDir, worktree: injectionProjectDir
  });
  const beforeInj = guardInj['tool.execute.before'];
  const orchSessionInj = 'ses_orch_injection';
  callID++;
  await beforeInj(
    { tool: 'skill', sessionID: orchSessionInj, callID: 'call_' + callID },
    { args: { name: 'conductor-rules' } }
  );

  // the subagent_type itself is the vector: it lands raw in the ROUTING error (fix #13)
  // and hence in INCIDENTS.md — a \n followed by a fake markdown entry would, if not
  // sanitized, look like a real, separate audit entry.
  const maliciousAgent = 'evil\n### [INC-9999] [fake_check] | 2020-01-01 | fake-agent | State: blocked | FAKE INJECTED ENTRY';
  await expectBlock('delegation with malicious subagent_type still blocked (routing)', () => {
    callID++;
    return beforeInj(
      { tool: 'task', sessionID: orchSessionInj, callID: 'call_' + callID },
      { args: { subagent_type: maliciousAgent, description: 'domain:implementation - test injection', prompt: 'domain:implementation root cause known, test injection' } }
    );
  }, 'ROUTING');

  const incidentsPath = path.join(injectionProjectDir, '.planning', 'INCIDENTS.md');
  await expectPass('INCIDENTS.md contains no injected INC-9999 entry (only the real entry)', () => {
    if (!existsSync(incidentsPath)) throw new Error('INCIDENTS.md was not written');
    const content = readFileSync(incidentsPath, 'utf8');
    // "INC-9999" as INERT TEXT inside the single real entry is expected and correct
    // (proof the payload created no new line) — the real check is that
    // exactly ONE line starts with "### [INC-", not the absence of the
    // substring (which would appear anyway, sanitized, inside the real entry).
    const incidentHeaders = content.match(/^### \[INC-/gm) || [];
    if (incidentHeaders.length !== 1) {
      throw new Error(`expected exactly 1 real entry (the injection would have created a 2nd "### [INC-9999]" line), found ${incidentHeaders.length}: ${content}`);
    }
  });
  rmSync(injectionProjectDir, { recursive: true, force: true });
}

console.log('--- 17. PROTECTED AUDIT DIR: .planning/audit, INCIDENTS.md, metrics_count.json not modifiable ---');
{
  // Dedicated instance with a real temp directory: relative paths resolve
  // inside the same root, so they exercise writeScope after containment.
  const guardAudit = await DelegationGuard({
    project: { id: 'test-project-audit-dir' }, client: mockClient, $: async () => {},
    directory: projectRoot('audit-dir'), worktree: projectRoot('audit-dir')
  });
  const beforeAudit = guardAudit['tool.execute.before'];
  const eventAudit = guardAudit['event'];
  const execSession = 'ses_sub_audit_executor';
  const explorerSession = 'ses_sub_audit_explorer';
  await eventAudit({ event: { type: 'session.created', properties: { sessionID: execSession, info: { agent: 'executor', parentID: 'ses_orch_audit' } } } });
  await eventAudit({ event: { type: 'session.created', properties: { sessionID: explorerSession, info: { agent: 'explorer', parentID: 'ses_orch_audit' } } } });
  function callAudit(tool, sessionID, args) {
    callID++;
    return beforeAudit({ tool, sessionID, callID: 'call_' + callID, args }, { args });
  }

  await expectBlock('write to .planning/audit/*.jsonl blocked', () =>
    callAudit('write', execSession, { filePath: '.planning/audit/audit-2026-01-01.jsonl', content: '{}' }), 'audit trail');
  await expectBlock('write to .planning/INCIDENTS.md blocked', () =>
    callAudit('write', execSession, { filePath: '.planning/INCIDENTS.md', content: 'x' }), 'audit trail');
  await expectBlock('write to .opencode/metrics_count.json blocked', () =>
    callAudit('write', execSession, { filePath: '.opencode/metrics_count.json', content: '{}' }), 'audit trail');

  // Regression: .planning/ as a whole must NOT become forbidden —
  // explorer legitimately has writeScope 'planning'.
  await expectPass('write to .planning/other-file.md (non-audit) stays allowed for explorer', () =>
    callAudit('write', explorerSession, { filePath: '.planning/analysis-note.md', content: 'x' }));
}

console.log('--- 18. MAX_SESSIONS LRU: the Orchestrator is never evicted even over the limit ---');
{
  const guardLru = await DelegationGuard({
    project: { id: 'test-project-lru' }, client: mockClient, $: async () => {},
    directory: projectRoot('lru'), worktree: projectRoot('lru')
  });
  const beforeLru = guardLru['tool.execute.before'];
  const eventLru = guardLru['event'];
  const orchSessionLru = 'ses_orch_lru';
  await eventLru({ event: { type: 'session.created', properties: { sessionID: orchSessionLru, info: { agent: 'orchestrator' } } } });
  callID++;
  await beforeLru(
    { tool: 'skill', sessionID: orchSessionLru, callID: 'call_' + callID },
    { args: { name: 'conductor-rules' } }
  );

  // Fill the Map well beyond MAX_SESSIONS (100) with other harmless sessions —
  // registered as subagents (verifier) via the event hook, otherwise with no
  // known identity they are mistaken for the Orchestrator itself (self-healing)
  // and blocked on direct 'read'.
  for (let i = 0; i < 120; i++) {
    const fillerSession = `ses_filler_${i}`;
    await eventLru({ event: { type: 'session.created', properties: { sessionID: fillerSession, info: { agent: 'verifier', parentID: orchSessionLru } } } });
    callID++;
    await beforeLru(
      { tool: 'read', sessionID: fillerSession, callID: 'call_' + callID, args: { filePath: `f${i}.txt` } },
      { args: { filePath: `f${i}.txt` } }
    );
  }

  await expectPass('the Orchestrator still delegates without reloading conductor-rules after 120 sessions', () => {
    callID++;
    return beforeLru(
      { tool: 'task', sessionID: orchSessionLru, callID: 'call_' + callID },
      { args: { subagent_type: 'executor', description: 'domain:implementation - test LRU', prompt: 'domain:implementation root cause known, test LRU' } }
    );
  });
}

console.log('--- 19. SECRET PATTERNS: OpenAI / Slack / Google coverage ---');
{
  const guardCoverage = await DelegationGuard({
    project: { id: 'test-project-secret-coverage' }, client: mockClient, $: async () => {},
    directory: projectRoot('secret-coverage'), worktree: projectRoot('secret-coverage')
  });
  const eventCov = guardCoverage['event'];
  const beforeCov = guardCoverage['tool.execute.before'];
  const afterCov = guardCoverage['tool.execute.after'];
  const subSessionCov = 'ses_sub_secret_coverage';
  await eventCov({ event: { type: 'session.created', properties: { sessionID: subSessionCov, info: { agent: 'debugger', parentID: 'ses_orch_secret_coverage' } } } });
  callID++;
  await beforeCov(
    { tool: 'read', sessionID: subSessionCov, callID: 'call_' + callID, args: { filePath: 'README.md' } },
    { args: { filePath: 'README.md' } }
  );

  const cases = [
    ['OpenAI', 'sk-' + 'a'.repeat(48)],
    ['Slack', 'xoxb-' + 'f'.repeat(20)], // deliberately unrealistic shape — avoids the GitHub push-protection scanner
    ['Google', 'AIza' + 'S'.repeat(35)],
  ];
  for (const [name, secret] of cases) {
    await expectPass(`${name} key in output gets redacted`, async () => {
      const output = { args: { filePath: 'config.txt' }, output: `value: ${secret}` };
      await afterCov({ tool: 'read', sessionID: subSessionCov }, output);
      if (!output.output.includes('REDACTED')) {
        throw new Error(`expected REDACTED for ${name}, found: ${output.output}`);
      }
    });
  }
}

console.log('--- 20. SLASHLESS SECRETS: bare file names (credentials, id_rsa) ---');
{
  const sess = await delegateAndCrystallize('executor', 'domain:implementation - test bare secrets', 'domain:implementation root cause known, test bare secrets');
  await expectBlock('reading a file named exactly "credentials" blocked', () =>
    call('read', sess, { filePath: 'credentials' }));
  await expectBlock('reading bare "id_rsa" (no .ssh/ prefix) blocked', () =>
    call('read', sess, { filePath: 'id_rsa' }));
  await expectPass('reading "credentialsfile.txt" NOT blocked (no false positive)', () =>
    call('read', sess, { filePath: 'credentialsfile.txt' }));
  await expectPass('reading "id_token" (common OIDC term) NOT blocked', () =>
    call('read', sess, { filePath: 'id_token' }));

  // Real incident on 2026-08-25: "private" as a folder inside node_modules —
  // React Native ships node_modules/react-native/src/private/... — blocked by the
  // secrets_directory pattern despite having nothing to do with secrets.
  await expectPass('Test-Path on node_modules/.../src/private/... NOT blocked', () =>
    call('bash', sess, { command: 'Test-Path node_modules/react-native/src/private/devsupport/devmenu/DevMenu.js' }));
  await expectPass('direct read of a file inside node_modules/.../private/ NOT blocked', () =>
    call('read', sess, { filePath: 'node_modules/some-pkg/private/index.js' }));
  // Regression: "private"/"secrets"/"credentials" in the PROJECT (outside
  // node_modules) stay blocked — the exclusion is specific to dependencies.
  await expectBlock('"private" folder in the project (not in node_modules) stays blocked', () =>
    call('read', sess, { filePath: 'app/private/user-notes.md' }));
}

console.log('--- 21. UNKNOWN MCP TOOLS: observability only, no blocking (explicit 2026-08-25 decision) ---');
{
  // FINDING left open (deliberately, per user choice): an MCP tool with a
  // dynamic name (e.g. supabase_apply_migration) goes through NO permission
  // check — bashAllowlist/readOnlyDespiteFullBash/allowEdit/writeScope do not
  // apply. The chosen fix is logging only (persistAuditEvent 'mcp_tool_usage'),
  // to gauge the real usage breadth before choosing an enforcement
  // policy. This test pins the CURRENT behavior (pass-through for
  // ALL agents, including the most restricted ones) — if enforcement is added
  // later, this test must be updated accordingly; it is not a
  // security guarantee.
  const guardMcp = await DelegationGuard({
    project: { id: 'test-project-mcp-observability' }, client: mockClient, $: async () => {},
    directory: projectRoot('mcp-observability'), worktree: projectRoot('mcp-observability')
  });
  const beforeMcp = guardMcp['tool.execute.before'];
  const eventMcp = guardMcp['event'];

  for (const agent of ['tester', 'verifier', 'debugger']) {
    const sess = `ses_sub_mcp_${agent}`;
    await eventMcp({ event: { type: 'session.created', properties: { sessionID: sess, info: { agent, parentID: 'ses_orch_mcp_observability' } } } });
    await expectPass(`unknown MCP tool passes without blocking for "${agent}" (deny-all/readOnly, current documented behavior)`, () => {
      callID++;
      return beforeMcp(
        { tool: 'supabase_apply_migration', sessionID: sess, callID: 'call_' + callID, args: { project_id: 'x', name: 'y', query: 'DROP TABLE users;' } },
        { args: { project_id: 'x', name: 'y', query: 'DROP TABLE users;' } }
      );
    });
  }
}

console.log(`\n=== RESULTS: ${pass} passed, ${fail} failed out of ${pass+fail} tests ===\n`);
if (failures.length) {
  console.log('FAILURES:');
  failures.forEach(f => console.log(' -', f));
}
