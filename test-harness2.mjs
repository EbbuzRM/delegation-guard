import { DelegationGuard } from './delegation-guard.js';
import { readFileSync, existsSync, rmSync, mkdirSync, mkdtempSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

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

console.log('--- 22. neverDo enforcement + fallback safety-net (M2 regression) ---');
{
  // M2 (2026-09-10): neverDo/keywords/allowMentions live ONLY in guard-config.json
  // (single source of truth, migrated from the old 325-line inline fallback);
  // the fallback is now a MINIMAL safety-net (REV-03) — neverDo [], bashAllowlist []
  // (total deny), delegation_rules can_handle_directly ['*'] (routing stays
  // operational). VER-01: enforcement and fallback had ZERO regression coverage.
  // 22.1/22.2 exercise the real guard-config.json via the shared `guard` (loaded
  // from __dirname); 22.3/22.4 exercise the fallback via a COPY of the plugin in
  // an empty temp dir (its __dirname has no guard-config.json → safety-net).

  await expectBlock('22.1 executor "write documentation" blocked (neverDo from guard-config.json)', () =>
    taskCall('executor', 'domain:implementation - write documentation',
      'domain:implementation root cause known, write documentation'),
    'RULE: executor cannot do "write documentation"');

  await expectPass('22.2 executor "verify the fix and write report" passes (allowMention "report" + analytical verb bypass)', () =>
    taskCall('executor', 'domain:implementation - verify and report',
      'domain:implementation root cause known, verify the fix and write report'));

  // Fallback: copy delegation-guard.js to an empty temp dir and import THE COPY
  // (ESM dynamic import of a distinct URL = distinct module instance with its own
  // module-level state, so the cached guard-config.json profiles of the shared
  // guard cannot leak in; the copy's __dirname has no guard-config.json →
  // safety-net fallback). process.chdir(testRoot) at the top of this harness does
  // NOT matter: tryLoadGuardConfig only checks .opencode/plugins under the
  // project directory (the temp worktree, not the cwd) and __dirname.
  const fallbackDir = mkdtempSync(path.join(os.tmpdir(), 'delegation-guard-fallback-'));
  try {
    const copiedPlugin = path.join(fallbackDir, 'delegation-guard.js');
    copyFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'delegation-guard.js'),
      copiedPlugin
    );
    const { DelegationGuard: DelegationGuardFallback } = await import(pathToFileURL(copiedPlugin).href);
    const guardFallback = await DelegationGuardFallback({
      project: { id: 'test-project-neverdo-fallback' }, client: mockClient, $: async () => {},
      directory: fallbackDir, worktree: fallbackDir
    });
    const beforeFB = guardFallback['tool.execute.before'];
    const eventFB = guardFallback['event'];
    const orchSessionFB = 'ses_orch_fallback';
    const subSessionFB = 'ses_sub_fallback_executor';
    // Register the child identity via the event hook (production mechanism,
    // sections 10/12) so the bash check resolves 'executor' deterministically
    // from the registry, not only from the currentActiveAgent bridge.
    await eventFB({ event: { type: 'session.created', properties: { sessionID: subSessionFB, info: { agent: 'executor', parentID: orchSessionFB } } } });
    // Preload conductor-rules on the fallback instance (gate 2.6, not the focus here)
    callID++;
    await beforeFB(
      { tool: 'skill', sessionID: orchSessionFB, callID: 'call_' + callID },
      { args: { name: 'conductor-rules' } }
    );

    await expectPass('22.3a fallback (config missing): delegation to executor stays operational (can_handle_directly ["*"])', () => {
      callID++;
      return beforeFB(
        { tool: 'task', sessionID: orchSessionFB, callID: 'call_' + callID },
        { args: { subagent_type: 'executor', description: 'domain:implementation - fallback', prompt: 'domain:implementation root cause known, fallback' } }
      );
    });

    await expectBlock('22.3b fallback (config missing): bash total deny for executor (bashAllowlist [])', () => {
      callID++;
      return beforeFB(
        { tool: 'bash', sessionID: subSessionFB, callID: 'call_' + callID, args: { command: 'npm install' } },
        { args: { command: 'npm install' } }
      );
    }, 'total deny');

    await expectPass('22.4 fallback (config missing): "write documentation" NOT blocked (neverDo [] — policy lives only in guard-config.json)', () => {
      callID++;
      return beforeFB(
        { tool: 'task', sessionID: orchSessionFB, callID: 'call_' + callID },
        { args: { subagent_type: 'executor', description: 'domain:implementation - fallback neverdo', prompt: 'domain:implementation root cause known, write documentation' } }
      );
    });
  } finally {
    rmSync(fallbackDir, { recursive: true, force: true });
  }
}

console.log('--- 23. --continue identity fallback: pre-existing session without identity sources (M5 regression) ---');
{
  // M5 (2026-09-10): __injectedAgent/__isOrchestrator removed from the identity
  // chain (dead code — never populated by upstream, see REV-06). This section pins
  // the REAL behavior of the reduced chain (registryAgent || state.lastAgent ||
  // getCurrentActiveAgent()) for a session reopened with --continue when the plugin
  // was loaded AFTER the session was born: no session.created ever observed by this
  // plugin instance, no state.lastAgent, no delegation yet in this instance
  // (currentActiveAgent = null).
  // Observed behavior (probe 2026-09-10): caller = null → isOrchestrator fallback
  // (!caller && !state.lastAgent) = true → check 2.5 blocks ALL mutative tools as
  // orchestrator_direct_tool (fail-closed), while read stays allowed (safe
  // gray-zone). REV-06: currentActiveAgent/lastAgent fallbacks are KEPT and are
  // the only identity recovery for --continue — pinned in 23.2.
  const guardCont = await DelegationGuard({
    project: { id: 'test-project-continue-fallback' }, client: mockClient, $: async () => {},
    directory: projectRoot('continue-fallback'), worktree: projectRoot('continue-fallback')
  });
  const beforeCont = guardCont['tool.execute.before'];
  const preExistingSession = 'ses_pre_existing_child'; // born BEFORE this plugin instance

  await expectBlock('23.1a pre-existing session (--continue), no identity source: bash BLOCKED (fail-closed, orchestrator_direct_tool)', () => {
    callID++;
    return beforeCont(
      { tool: 'bash', sessionID: preExistingSession, callID: 'call_' + callID, args: { command: 'npm install' } },
      { args: { command: 'npm install' } }
    );
  }, 'Delegate instead of using bash directly');

  await expectBlock('23.1b pre-existing session (--continue), no identity source: edit BLOCKED', () => {
    callID++;
    return beforeCont(
      { tool: 'edit', sessionID: preExistingSession, callID: 'call_' + callID, args: { filePath: 'app.js', oldString: 'a', newString: 'b' } },
      { args: { filePath: 'app.js', oldString: 'a', newString: 'b' } }
    );
  }, 'Delegate instead of using edit directly');

  await expectBlock('23.1c pre-existing session (--continue), no identity source: write BLOCKED', () => {
    callID++;
    return beforeCont(
      { tool: 'write', sessionID: preExistingSession, callID: 'call_' + callID, args: { filePath: 'notes.md', content: 'x' } },
      { args: { filePath: 'notes.md', content: 'x' } }
    );
  }, 'Delegate instead of using write directly');

  await expectPass('23.1d pre-existing session (--continue), no identity source: read allowed (safe gray-zone, pinned current behavior)', () => {
    callID++;
    return beforeCont(
      { tool: 'read', sessionID: preExistingSession, callID: 'call_' + callID, args: { filePath: 'README.md' } },
      { args: { filePath: 'README.md' } }
    );
  });

  // 23.2 — bridge fallback (REV-06: kept as a VALID fallback): after a delegation,
  // currentActiveAgent resolves the pre-existing session's identity even without
  // registry/lastAgent. Mutative tools are then governed by the delegated agent's
  // profile (executor bashAllowlist ["*"]) instead of being fail-closed.
  const orchSessionCont = 'ses_orch_continue_fallback';
  await preloadConductorRules(guardCont, orchSessionCont);
  callID++;
  await beforeCont(
    { tool: 'task', sessionID: orchSessionCont, callID: 'call_' + callID },
    { args: { subagent_type: 'executor', description: 'domain:implementation - continue fallback', prompt: 'domain:implementation root cause known, continue fallback' } }
  );
  await expectPass('23.2 pre-existing session AFTER a delegation: currentActiveAgent bridge resolves executor, bash passes per its profile (fallback pinned)', () => {
    callID++;
    return beforeCont(
      { tool: 'bash', sessionID: preExistingSession, callID: 'call_' + callID, args: { command: 'npm install' } },
      { args: { command: 'npm install' } }
    );
  });
}

console.log('--- 24. Unknown identity: write + webfetch fail-closed (M1 + REV-05 regression) ---');
{
  // M1 + REV-05 (2026-09-10): at unknown identity bash/edit/rm were already
  // blocked downstream (bash_block/edit_block/tool_phase), but WRITE fell
  // through to checkWritePath("unknown", ...) — the only real mutative hole
  // (REV-01) — and webfetch passed with a 'grey_zone' allow entry and NO
  // check (REV-05). Both are now fail-closed in the dispatcher, specular to
  // the edit pattern.
  // Fresh instance: the shared `guard` has currentActiveAgent set by earlier
  // delegations (TTL 5 min), which would "heal" an unknown session's identity
  // and hide the hole. Here the only identity source is the ROOT
  // session.created (sets orchestratorSessionID, sets NO currentActiveAgent),
  // so the unknown session resolves: subagentType=null, isOrchestrator=false
  // (its sessionID differs from the orchestrator's) → the real gray zone.
  const guardU = await DelegationGuard({
    project: { id: 'test-project-unknown-identity' }, client: mockClient, $: async () => {},
    directory: projectRoot('unknown-identity'), worktree: projectRoot('unknown-identity')
  });
  const beforeU = guardU['tool.execute.before'];
  const eventU = guardU['event'];
  const orchSess24 = 'ses_orch_unknown_identity';
  await eventU({ event: { type: 'session.created', properties: { sessionID: orchSess24, info: { agent: 'orchestrator' } } } });
  const unknownSess = 'ses_unknown_gray_24';

  await expectBlock('24.1 unknown identity: write on a clean new file BLOCKED (was the M1 hole — passed via checkWritePath("unknown"))', () => {
    callID++;
    return beforeU(
      { tool: 'write', sessionID: unknownSess, callID: 'call_' + callID, args: { filePath: 'out-test.txt', content: 'x' } },
      { args: { filePath: 'out-test.txt', content: 'x' } }
    );
  }, 'WRITE: unknown identity');

  await expectBlock('24.2 unknown identity: webfetch BLOCKED (was a grey_zone allow entry with no check, REV-05)', () => {
    callID++;
    return beforeU(
      { tool: 'webfetch', sessionID: unknownSess, callID: 'call_' + callID, args: { url: 'https://example.com' } },
      { args: { url: 'https://example.com' } }
    );
  }, 'WEBFETCH: unknown identity');

  // 24.3/24.4 — regressions: a legitimate REGISTERED child stays operational.
  // executor: writeScope "all" + canWebfetch true (guard-config.json) → both
  // the write and the webfetch must keep passing after the fail-closed fix.
  const subSess24 = 'ses_sub_unknown_identity_executor';
  await eventU({ event: { type: 'session.created', properties: { sessionID: subSess24, info: { agent: 'executor', parentID: orchSess24 } } } });

  await expectPass('24.3 registered executor: write on a clean new in-project file stays allowed', () => {
    callID++;
    return beforeU(
      { tool: 'write', sessionID: subSess24, callID: 'call_' + callID, args: { filePath: 'out-test-2.txt', content: 'x' } },
      { args: { filePath: 'out-test-2.txt', content: 'x' } }
    );
  });

  await expectPass('24.4 registered executor (canWebfetch: true): webfetch stays allowed', () => {
    callID++;
    return beforeU(
      { tool: 'webfetch', sessionID: subSess24, callID: 'call_' + callID, args: { url: 'https://example.com' } },
      { args: { url: 'https://example.com' } }
    );
  });
}

console.log('--- 25. Webfetch schema check: single point in dispatcher (M3 dedup, REV-02) ---');
{
  // M3/REV-02 (2026-09-10): the URL schema check (http/https only) existed in
  // TWO places — the dispatcher (runs for EVERY identity branch: orchestrator,
  // unknown, profile) and a duplicate INSIDE checkWebfetch. The duplicate is
  // removed; these tests pin that the dispatcher check alone protects all
  // three paths. Fresh instance: the only identity source is session.created,
  // so currentActiveAgent residue from earlier sections cannot heal anything.
  const guardS = await DelegationGuard({
    project: { id: 'test-project-webfetch-schema' }, client: mockClient, $: async () => {},
    directory: projectRoot('webfetch-schema'), worktree: projectRoot('webfetch-schema')
  });
  const beforeS = guardS['tool.execute.before'];
  const eventS = guardS['event'];

  // 25.1 — ORCHESTRATOR identity: schema check runs BEFORE the orchestrator
  // allow branch, so file:// is blocked even for the orchestrator. Pins the
  // REV-02 direction: removing the checkWebfetch duplicate must NOT open
  // non-http schemes to orchestrator sessions.
  const orchSess25 = 'ses_orch_webfetch_schema';
  await eventS({ event: { type: 'session.created', properties: { sessionID: orchSess25, info: { agent: 'orchestrator' } } } });
  await expectBlock('25.1 orchestrator: webfetch file:///etc/passwd BLOCKED by dispatcher schema check', () => {
    callID++;
    return beforeS(
      { tool: 'webfetch', sessionID: orchSess25, callID: 'call_' + callID, args: { url: 'file:///etc/passwd' } },
      { args: { url: 'file:///etc/passwd' } }
    );
  }, 'WEBFETCH: URL scheme not allowed');

  // 25.2 — UNKNOWN identity: dispatcher schema check runs BEFORE the unknown
  // branch (webfetch_block REV-05), so the real message is the SCHEMA one,
  // not the unknown-identity one. Pins the order.
  const unknownSess25 = 'ses_unknown_webfetch_schema';
  await expectBlock('25.2 unknown identity: webfetch file:///C:/Windows/win.ini BLOCKED by schema (schema check precedes unknown branch)', () => {
    callID++;
    return beforeS(
      { tool: 'webfetch', sessionID: unknownSess25, callID: 'call_' + callID, args: { url: 'file:///C:/Windows/win.ini' } },
      { args: { url: 'file:///C:/Windows/win.ini' } }
    );
  }, 'WEBFETCH: URL scheme not allowed');

  // 25.3 — REGISTERED profiled agent (executor, canWebfetch: true): the
  // removed duplicate used to be the only schema check this path had AFTER
  // canWebfetch... it never was — the dispatcher check also ran first here.
  // Post-dedup ftp:// must stay blocked: dispatcher is now the ONLY line of
  // defense for this path, and it holds.
  const subSess25 = 'ses_sub_webfetch_schema_executor';
  await eventS({ event: { type: 'session.created', properties: { sessionID: subSess25, info: { agent: 'executor', parentID: orchSess25 } } } });
  await expectBlock('25.3 registered executor (canWebfetch: true): webfetch ftp://example.com BLOCKED by dispatcher schema check', () => {
    callID++;
    return beforeS(
      { tool: 'webfetch', sessionID: subSess25, callID: 'call_' + callID, args: { url: 'ftp://example.com' } },
      { args: { url: 'ftp://example.com' } }
    );
  }, 'WEBFETCH: URL scheme not allowed');

  // 25.4 — REGRESSION: legitimate https webfetch for a registered canWebfetch
  // agent still passes through the full post-dedup flow (dispatcher schema
  // check → checkWebfetch → canWebfetch allow) with no duplicate in between.
  await expectPass('25.4 registered executor: https webfetch still passes (full flow post-dedup, no duplicates)', () => {
    callID++;
    return beforeS(
      { tool: 'webfetch', sessionID: subSess25, callID: 'call_' + callID, args: { url: 'https://example.com' } },
      { args: { url: 'https://example.com' } }
    );
  });
}

console.log('--- 26. SUB-DELEGATION backstop pinned (M4/REV-04) ---');
{
  // M4/REV-04 (2026-09-10): checkTaskSubDelegation (:2215) and checkDelegationLoop
  // (:737) were candidate dead code — unreachable via the native task:deny on
  // child sessions (OpenCode 1.18.30) — but are KEPT as a defensive backstop:
  // an agent-level allow (permission task:allow) can structurally bypass the
  // native deny (evidence D4), and no agent profile today carries task:allow.
  // These tests PIN the backstop so a future drift (a permissive custom agent
  // config, a regression in the sub_delegation gate ordering) cannot silently
  // remove the last line of defense. Invariant documented in docs/SECURITY.md.
  //
  // Fresh instance: identity resolution uses ONLY the session.created registry
  // (no currentActiveAgent residue from earlier sections).
  const guard26 = await DelegationGuard({
    project: { id: 'test-project-subdelegation-backstop' }, client: mockClient, $: async () => {},
    directory: projectRoot('subdelegation-backstop'), worktree: projectRoot('subdelegation-backstop')
  });
  const before26 = guard26['tool.execute.before'];
  const event26 = guard26['event'];

  const orchSess26 = 'ses_orch_subdeleg_backstop';
  // Root session: registers orchestratorSessionID via the production mechanism.
  await event26({ event: { type: 'session.created', properties: { sessionID: orchSess26, info: { agent: 'orchestrator' } } } });

  // Conductor-rules gate (2.6): preload on the root session — not the focus
  // of this section, same pattern as every other section (see section 8/9).
  await preloadConductorRules(guard26, orchSess26);

  // The Orchestrator legitimately delegates to verifier (in canDelegateTo of
  // nothing needed here — the ROOT is exempt from the sub-delegation gate:
  // the gate requires state.lastAgent to be set, which only happens on a
  // crystallized CHILD session).
  callID++;
  await before26(
    { tool: 'task', sessionID: orchSess26, callID: 'call_' + callID },
    { args: { subagent_type: 'verifier', description: 'domain:verification - setup verifier child', prompt: 'domain:verification verify the applied fix' } }
  );

  // Child verifier session registered via session.created (registry identity,
  // same production mechanism) and crystallized with a real tool call
  // (state.lastAgent = 'verifier') — the exact state in which the
  // sub_delegation backstop becomes reachable.
  const verifierSess26 = 'ses_sub_verifier_backstop';
  await event26({ event: { type: 'session.created', properties: { sessionID: verifierSess26, info: { parentID: orchSess26, agent: 'verifier' } } } });
  callID++;
  await before26(
    { tool: 'read', sessionID: verifierSess26, callID: 'call_' + callID, args: { filePath: 'report.txt' } },
    { args: { filePath: 'report.txt' } }
  );

  // 26.1 — verifier -> sketcher: NOT in verifier.canDelegateTo
  // ["executor","doc-writer"] → BLOCK by checkTaskSubDelegation. Prompt
  // engineered to reach the sub_delegation check clean (no earlier throw):
  //   - domain:ui_prototyping → sketcher.can_handle_directly (delegation_rules OK
  //     for the TARGET profile — the caller's rules are not evaluated here)
  //   - no .md/.txt mention + no write verb of isDocumentationTask → routing OK
  //   - no verifier/sketcher neverDo phrase → neverdo OK
  //   - delegationStack empty (root delegation resets it) → anti_loop OK
  //   - no "fix" in the text → workflow OK (only executor has a workflow rule anyway)
  await expectBlock('26.1 crystallized verifier delegates to sketcher (NOT in canDelegateTo) BLOCKED by sub-delegation backstop', () => {
    callID++;
    return before26(
      { tool: 'task', sessionID: verifierSess26, callID: 'call_' + callID },
      { args: { subagent_type: 'sketcher', description: 'domain:ui_prototyping - draft a wireframe', prompt: 'domain:ui_prototyping draft a wireframe for the settings panel' } }
    );
  }, 'SUB-DELEGATION: verifier cannot delegate to sketcher');

  // 26.2 — root Orchestrator -> executor: the legitimate delegation path must
  // NOT be caught by the backstop (regression guard: the gate keys on
  // state.lastAgent of the CALLER session, which is null for the root).
  // domain:implementation + "root cause known" satisfies executor's workflow
  // rule (requiresAnyOf) — full clean path to the delegation being executed.
  await expectPass('26.2 orchestrator root delegates executor domain:implementation PASSES (legitimate delegation not blocked by the backstop)', () => {
    callID++;
    return before26(
      { tool: 'task', sessionID: orchSess26, callID: 'call_' + callID },
      { args: { subagent_type: 'executor', description: 'domain:implementation - apply fix', prompt: 'domain:implementation root cause: misaligned handler, apply fix to the handler module' } }
    );
  });
}

console.log('--- 27. REV-09 trustedForSecrets: explicit trust flag, never derived ---');
{
  // REV-09 (2026-09-10): the checkSecretsInOutput skip previously derived
  // from canDelegateTo:["*"] — any permissive custom agent would inherit
  // the secret-scan exemption without a real trust decision. Trust is now
  // an EXPLICIT per-agent flag (`trustedForSecrets: true` in
  // guard-config.json; the M2 safety-net fallback never sets it).
  // Pin: 27.1 executor (has the flag) → output NOT redacted (skip active);
  // 27.2 verifier (canDelegateTo ["executor"] — NOT the flag) → same
  // output gets redacted (scan active). Same simulation style as sections
  // 18/19: tool.execute.after with a real secret pattern in output.
  const guard27 = await DelegationGuard({
    project: { id: 'test-project-rev09-trusted-secrets' }, client: mockClient, $: async () => {},
    directory: projectRoot('rev09-trusted-secrets'), worktree: projectRoot('rev09-trusted-secrets')
  });
  const event27 = guard27['event'];
  const before27 = guard27['tool.execute.before'];
  const after27 = guard27['tool.execute.after'];

  const realSecret = 'sk-' + 'a'.repeat(48); // same shape as section 19 (OpenAI)
  const makeOutput = () => ({ args: { filePath: 'config.txt' }, output: `value: ${realSecret}` });
  // Crystallize state.lastAgent for a child session via the production
  // mechanism (registry from session.created + a first harmless tool call —
  // same pattern as section 19, lines ~860).
  const crystallize27 = async (sess) => {
    callID++;
    await before27(
      { tool: 'read', sessionID: sess, callID: 'call_' + callID, args: { filePath: 'README.md' } },
      { args: { filePath: 'README.md' } }
    );
  };

  // 27.1 — executor: trustedForSecrets:true → skip active, output untouched.
  {
    const sess = 'ses_sub_rev09_executor';
    await event27({ event: { type: 'session.created', properties: { sessionID: sess, info: { agent: 'executor', parentID: 'ses_orch_rev09' } } } });
    await crystallize27(sess);
    const out = makeOutput();
    await after27({ tool: 'read', sessionID: sess }, out);
    await expectPass('27.1 executor (trustedForSecrets:true) output with a real secret is NOT redacted (explicit trust pinned)', () => {
      if (out.output.includes('REDACTED')) {
        throw new Error(`expected NO redaction for the trusted agent, found: ${out.output}`);
      }
    });
  }

  // 27.2 — verifier: canDelegateTo:["executor"] (no "*", no flag) → scan
  // active. Pin del flusso already-scanned: identical block/redact path.
  {
    const sess = 'ses_sub_rev09_verifier';
    await event27({ event: { type: 'session.created', properties: { sessionID: sess, info: { agent: 'verifier', parentID: 'ses_orch_rev09' } } } });
    await crystallize27(sess);
    const out = makeOutput();
    await after27({ tool: 'read', sessionID: sess }, out);
    await expectPass('27.2 verifier (NOT trusted) same output gets REDACTED (scan active for all non-trusted agents)', () => {
      if (!out.output.includes('REDACTED')) {
        throw new Error(`expected REDACTED for the non-trusted agent, found: ${out.output}`);
      }
    });
  }

  // 27.3 — regression pin of the REV-09 semantics itself: NO agent without
  // the explicit flag can reach the skip, even with a wildcard-looking
  // capability elsewhere. debugger has bashAllowlist-free read-only
  // profile — scan must stay active (same expectation as 19.x).
  {
    const sess = 'ses_sub_rev09_debugger';
    await event27({ event: { type: 'session.created', properties: { sessionID: sess, info: { agent: 'debugger', parentID: 'ses_orch_rev09' } } } });
    await crystallize27(sess);
    const out = makeOutput();
    await after27({ tool: 'read', sessionID: sess }, out);
    await expectPass('27.3 debugger (NOT trusted) scan stays active — trust never derived from other capabilities', () => {
      if (!out.output.includes('REDACTED')) {
        throw new Error(`expected REDACTED for the non-trusted agent, found: ${out.output}`);
      }
    });
  }
}

// ============================================================
// 28. VER-M2-02: currentActiveAgent bridge on the FALLBACK instance
// ============================================================
console.log('--- 28. Bridge fallback (currentActiveAgent) on the FALLBACK instance (VER-M2-02) ---');
{
  // GAP closed here: 22.3 exercised the fallback instance with REGISTRY
  // identity (session.created), 23.2 exercised the currentActiveAgent
  // bridge but ONLY on the NORMAL instance (guard-config.json profiles).
  // The bridge path on the fallback instance (safety-net profiles,
  // bashAllowlist []) was never covered. 28.1 pins exactly that
  // intersection: identity resolvable ONLY via the bridge (a delegation
  // happened, no session.created for the child session) on an instance
  // whose profiles are the M2 safety-net.
  const fallbackDir28 = mkdtempSync(path.join(os.tmpdir(), 'delegation-guard-fallback-bridge-'));
  try {
    const copiedPlugin28 = path.join(fallbackDir28, 'delegation-guard.js');
    copyFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'delegation-guard.js'),
      copiedPlugin28
    );
    const { DelegationGuard: DelegationGuardFallback28 } = await import(pathToFileURL(copiedPlugin28).href);
    const guardFB28 = await DelegationGuardFallback28({
      project: { id: 'test-project-bridge-fallback-28' }, client: mockClient, $: async () => {},
      directory: fallbackDir28, worktree: fallbackDir28
    });
    const beforeFB28 = guardFB28['tool.execute.before'];
    const eventFB28 = guardFB28['event'];
    const orchSession28 = 'ses_orch_fallback_bridge_28';
    // Register ONLY the root orchestrator session via session.created —
    // the child session below gets NO session.created (that is the point:
    // the bridge is its only identity source).
    await eventFB28({ event: { type: 'session.created', properties: { sessionID: orchSession28, info: { agent: 'orchestrator' } } } });
    // Preload conductor-rules on the root (gate 2.6, not the focus here —
    // same pattern as 22.3: the skill preload also flips
    // state.conductorRulesLoaded for the root session).
    callID++;
    await beforeFB28(
      { tool: 'skill', sessionID: orchSession28, callID: 'call_' + callID },
      { args: { name: 'conductor-rules' } }
    );

    // 28.1 — the delegation to executor: the ONLY identity write for the
    // child session is the currentActiveAgent bridge (pendingAgentTypes.set
    // + currentActiveAgent = 'executor' in the task dispatcher). The
    // routing itself must stay operational on the fallback
    // (delegation_rules can_handle_directly ['*'], REV-03).
    await expectPass('28.1a fallback instance: delegation to executor stays operational (bridge setup, can_handle_directly ["*"])', () => {
      callID++;
      return beforeFB28(
        { tool: 'task', sessionID: orchSession28, callID: 'call_' + callID },
        { args: { subagent_type: 'executor', description: 'domain:implementation - fallback bridge', prompt: 'domain:implementation root cause known, fallback bridge test' } }
      );
    });

    // The child session never gets a session.created event — its identity
    // is resolvable ONLY via the currentActiveAgent bridge. The first
    // non-task tool call crystallizes state.lastAgent from the bridge
    // (identity lock, source=currentActive) and the bash check then runs
    // against the FALLBACK executor profile: bashAllowlist [] → total deny.
    // Pin the REAL bridge+fallback behavior: the block comes from
    // checkBashWhitelist with the safety-net role — NOT from the unknown
    // branch ("The Orchestrator cannot use the shell"), which is what a
    // null bridge would produce.
    const bridgeSession28 = 'ses_sub_fallback_bridge_never_registered';
    await expectBlock('28.1b bridge on FALLBACK instance: bash via currentActiveAgent-only identity BLOCKED by total deny (bashAllowlist [])', () => {
      callID++;
      return beforeFB28(
        { tool: 'bash', sessionID: bridgeSession28, callID: 'call_' + callID, args: { command: 'npm install' } },
        { args: { command: 'npm install' } }
      );
    }, 'total deny');

    // 28.2 — same intersection, read side: read-only tools stay allowed
    // for a bridge-resolved identity even on the fallback instance (safe
    // gray-zone semantics, same expectation as 23.1d/22.3 flows).
    await expectPass('28.2 bridge on FALLBACK instance: read via bridge-resolved executor stays allowed', () => {
      callID++;
      return beforeFB28(
        { tool: 'read', sessionID: bridgeSession28, callID: 'call_' + callID, args: { filePath: 'README.md' } },
        { args: { filePath: 'README.md' } }
      );
    });
  } finally {
    rmSync(fallbackDir28, { recursive: true, force: true });
  }
}

console.log('--- 29. Blocked delegation must not arm the identity bridge (REV-01) ---');
{
  // A delegation rejected by ANY task-handler check (routing / unknown_agent /
  // neverDo / delegation_rules) must leave NO residue in currentActiveAgent.
  // Before the fix, :1159 armed the bridge BEFORE validation and the rollback
  // (:1563) cleared only pendingAgentTypes, so the next unregistered session
  // resolved the rejected target, crystallized it permanently (:1052) and got
  // its full profile — write via checkWritePath (validatePathZone never reads
  // agentProfiles), bash via checkBashWhitelist. Fail-closed inverted.
  const guard29 = await DelegationGuard({
    project: { id: 'test-project-residue-29' }, client: mockClient, $: async () => {},
    directory: projectRoot('residue29'), worktree: projectRoot('residue29')
  });
  const before29 = guard29['tool.execute.before'];
  const event29 = guard29['event'];
  const orch29 = 'ses_orch_residue_29';
  await event29({ event: { type: 'session.created', properties: { sessionID: orch29, info: { agent: 'orchestrator' } } } });
  await preloadConductorRules(guard29, orch29);
  const unknown29 = 'ses_unknown_residue_29';

  await expectBlock('29.1 baseline (no residue yet): unknown identity write BLOCKED', () => {
    callID++;
    return before29(
      { tool: 'write', sessionID: unknown29, callID: 'call_' + callID, args: { filePath: 'out-29.txt', content: 'x' } },
      { args: { filePath: 'out-29.txt', content: 'x' } }
    );
  }, 'WRITE: unknown identity');

  // Real-world trigger: routing block on a documentation-ish prompt
  // (isDocumentationTask false positive — documented recurring case).
  await expectBlock('29.2 delegation to executor BLOCKED by routing', () => {
    callID++;
    return before29(
      { tool: 'task', sessionID: orch29, callID: 'call_' + callID },
      { args: { subagent_type: 'executor', description: 'write the README.md documentation text file', prompt: 'please write and update the README.md documentation notes file only' } }
    );
  }, 'Documentation task detected');

  await expectBlock('29.3 unknown identity AFTER a blocked delegation: write STILL BLOCKED (no executor residue)', () => {
    callID++;
    return before29(
      { tool: 'write', sessionID: unknown29, callID: 'call_' + callID, args: { filePath: 'src/app-29.js', content: 'x' } },
      { args: { filePath: 'src/app-29.js', content: 'x' } }
    );
  }, 'WRITE: unknown identity');

  await expectBlock('29.4 unknown identity AFTER a blocked delegation: bash STILL BLOCKED', () => {
    callID++;
    return before29(
      { tool: 'bash', sessionID: unknown29, callID: 'call_' + callID, args: { command: 'npm install' } },
      { args: { command: 'npm install' } }
    );
  });

  // 29.5 regression guard: the LEGITIMATE bridge (successful delegation) must
  // keep working — pins the same behavior as 23.2/28.1b on a fresh session.
  const bridge29 = 'ses_bridge_residue_29';
  await expectPass('29.5a successful executor delegation stays operational', () => {
    callID++;
    return before29(
      { tool: 'task', sessionID: orch29, callID: 'call_' + callID },
      { args: { subagent_type: 'executor', description: 'domain:implementation - residue', prompt: 'domain:implementation root cause known, residue test' } }
    );
  });
  await expectPass('29.5b legitimate bridge intact: unregistered child resolves executor, bash passes per profile', () => {
    callID++;
    return before29(
      { tool: 'bash', sessionID: bridge29, callID: 'call_' + callID, args: { command: 'npm install' } },
      { args: { command: 'npm install' } }
    );
  });
}

// 30.1c scenario note (VER-LOW-01): the `parallel_identity_conflict` gate
// (:1145) filters `t !== targetAgent`, so a same-type swarm (executor×2)
// NEVER triggers it — the second delegation arms and only the routing check
// inside the task-handler try can throw, exercising the catch rollback.
console.log('--- 30. Same-type swarm rollback must not clobber the sibling bridge (VER-LOW-01) + unified targetAgent extraction (VER-LOW-02) ---');
{
  const guard30 = await DelegationGuard({
    project: { id: 'test-project-residue-30' }, client: mockClient, $: async () => {},
    directory: projectRoot('residue30'), worktree: projectRoot('residue30')
  });
  const before30 = guard30['tool.execute.before'];
  const event30 = guard30['event'];
  const orch30 = 'ses_orch_residue_30';
  await event30({ event: { type: 'session.created', properties: { sessionID: orch30, info: { agent: 'orchestrator' } } } });
  await preloadConductorRules(guard30, orch30);
  const unknown30 = 'ses_unknown_residue_30';

  // 30.1 — VER-LOW-01: two PARALLEL delegations to the SAME type (executor×2,
  // Swarm Mode — legitimate fan-out, see section 7), the first one valid, the
  // second one blocked by routing. Before the fix, the catch's rollback
  // matched `currentActiveAgent === targetAgent` (true — same type) and
  // nulled the bridge the FIRST delegation had legitimately armed: the
  // sibling child in flight degraded to unknown identity (fail-closed, but a
  // wrongful clobber of a legitimate delegation's bridge).
  await expectPass('30.1a parallel delegation 1 to executor SUCCEEDS (arms the bridge, like 29.5a)', () => {
    callID++;
    return before30(
      { tool: 'task', sessionID: orch30, callID: 'call_' + callID },
      { args: { subagent_type: 'executor', description: 'domain:implementation - swarm step1', prompt: 'domain:implementation root cause known, swarm step1' } }
    );
  });

  await expectBlock('30.1b parallel delegation 2 SAME TYPE blocked by routing (arming + throw inside the try)', () => {
    callID++;
    return before30(
      { tool: 'task', sessionID: orch30, callID: 'call_' + callID },
      { args: { subagent_type: 'executor', description: 'write the README.md documentation text file', prompt: 'please write and update the README.md documentation notes file only' } }
    );
  }, 'Documentation task detected');

  // THE RED: pre-fix, the 30.1b catch nulls the bridge armed by 30.1a, so
  // this unregistered sibling session resolves unknown identity and bash
  // falls into the orchestrator_block branch ("cannot use the shell").
  // Post-fix: the bridge owner (30.1a's callID) does not match 30.1b's, the
  // sibling bridge survives, identity resolves executor (bashAllowlist ["*"]).
  const bridge30 = 'ses_sub_swarm_sibling_30';
  await expectPass('30.1c sibling bridge INTACT after same-type blocked rollback: unregistered session still resolves executor', () => {
    callID++;
    return before30(
      { tool: 'bash', sessionID: bridge30, callID: 'call_' + callID, args: { command: 'npm install' } },
      { args: { command: 'npm install' } }
    );
  });
  // 30.1d intentionally omitted: the proprietary rollback (delegation that
  // DID arm the bridge, then gets blocked) is already pinned by 29.3/29.4;
  // a "post-30.1b write" pin would pass under BOTH bug and fix (executor
  // bridge intact → write per profile), adding no discriminating coverage.

  // 30.2 — VER-LOW-02: the task handler extracted targetAgent ONLY from
  // output.args (:1399) while the arming block also read input.args (:1139).
  // A delegation with subagent_type ONLY in input.args armed the bridge and
  // then hit the early return — no validation, no rollback, TTL-bounded
  // residue. The unified extractor routes it through the full validation.
  await expectBlock('30.2a delegation with subagent_type ONLY in input.args to a NON-EXISTENT agent: BLOCKED (unknown_agent), not silently passed', () => {
    callID++;
    return before30(
      { tool: 'task', sessionID: orch30, callID: 'call_' + callID, args: { subagent_type: 'bogus-agent-30', description: 'domain:implementation - bogus', prompt: 'domain:implementation root cause known, bogus agent test' } },
      { args: { description: 'domain:implementation - bogus', prompt: 'domain:implementation root cause known, bogus agent test' } }
    );
  }, 'does not exist in guard-config.json');

  // Residue pin: pre-fix 30.2a silently early-returned leaving a stale
  // pendingAgentTypes entry for 'bogus-agent-30' — no rollback ever fired.
  // Side effect observable in the SAME fresh instance: the residue is a
  // DIFFERENT type from any legit delegation, so the next delegation to a
  // different agent must NOT trigger PARALLEL CONFLICT. (Pre-fix this test
  // fails with PARALLEL CONFLICT — direct symptom of the VER-LOW-02 residue.)
  await expectPass('30.2b no stale pending residue after input.args-only delegation flow: different-type delegation unaffected', () => {
    callID++;
    return before30(
      { tool: 'task', sessionID: orch30, callID: 'call_' + callID },
      { args: { subagent_type: 'verifier', description: 'domain:verification - verify residue', prompt: 'domain:verification verify the residue behavior' } }
    );
  });
  // Fast-release the verifier pending (realistic production flow, same
  // pattern as section 8: the child's session.created clears the pending
  // entry) so the next DIFFERENT-type delegation does not hit the
  // parallel_identity_conflict gate for reasons unrelated to these pins.
  const verifierSession30 = 'ses_sub_verifier_residue_30';
  await event30({ event: { type: 'session.created', properties: { sessionID: verifierSession30, info: { parentID: orch30, agent: 'verifier' } } } });

  // 30.2c — no over-block: a LEGITIMATE delegation with subagent_type only
  // in input.args (output.args carries description/prompt, the realistic
  // split between the two sources) must pass the unified flow. Pre-fix this
  // fails with PARALLEL CONFLICT against the stale 'bogus-agent-30' pending.
  await expectPass('30.2c legitimate input.args-only delegation to executor passes the unified extraction', () => {
    callID++;
    return before30(
      { tool: 'task', sessionID: orch30, callID: 'call_' + callID, args: { subagent_type: 'executor', description: 'domain:implementation - step2', prompt: 'domain:implementation root cause known, input-args step2' } },
      { args: { description: 'domain:implementation - step2', prompt: 'domain:implementation root cause known, input-args step2' } }
    );
  });
}

// 31. REV-02: the single orchestratorSessionID slot is overwritten
// unconditionally at every session.created root (:1750) and by any
// unregistered session calling task (:1204). With two roots in the same
// plugin instance, the FIRST loses orchestrator status: check 2.5 stops
// covering it AND the anti-crystallization guard (:1079) stops protecting
// it — it crystallizes the bridge residue (executor after a successful
// delegation) and gets permanent write/bash PASS-THROUGH with the
// delegated agent's profile (reviewer scenario S7). Fix: rootSessions Set —
// every root keeps orchestrator status; the legacy slot stays (first root)
// for the other consumers.
console.log('--- 31. Multi-root: every root session stays Orchestrator (REV-02) ---');
{
  const guard31 = await DelegationGuard({
    project: { id: 'test-project-root31' }, client: mockClient, $: async () => {},
    directory: projectRoot('root31'), worktree: projectRoot('root31')
  });
  const before31 = guard31['tool.execute.before'];
  const event31 = guard31['event'];
  const orchA = 'ses_orch_root31_A';
  await event31({ event: { type: 'session.created', properties: { sessionID: orchA, info: { agent: 'orchestrator' } } } });
  await preloadConductorRules(guard31, orchA);

  // 31.1a — S7 setup: successful delegation from A arms the executor bridge.
  await expectPass('31.1a root A delegates to executor SUCCEEDS (arms the bridge)', () => {
    callID++;
    return before31(
      { tool: 'task', sessionID: orchA, callID: 'call_' + callID },
      { args: { subagent_type: 'executor', description: 'domain:implementation - root31', prompt: 'domain:implementation root cause known, multi-root test' } }
    );
  });

  // Second root session B in the SAME plugin instance. Pre-fix this steals
  // the single slot from A.
  const orchB = 'ses_orch_root31_B';
  await event31({ event: { type: 'session.created', properties: { sessionID: orchB, info: { agent: 'orchestrator' } } } });

  // THE RED: pre-fix, A is no longer the Orchestrator, crystallizes the
  // executor bridge residue on its first direct tool call and bash/write
  // pass with the executor profile.
  await expectBlock('31.1c root A bash after second root: STILL Orchestrator, must delegate', () => {
    callID++;
    return before31(
      { tool: 'bash', sessionID: orchA, callID: 'call_' + callID, args: { command: 'node --version' } },
      { args: { command: 'node --version' } }
    );
  }, 'Delegate instead of using bash directly');

  await expectBlock('31.1d root A write after second root: STILL Orchestrator, must delegate', () => {
    callID++;
    return before31(
      { tool: 'write', sessionID: orchA, callID: 'call_' + callID, args: { filePath: 'src/app-31.js', content: 'x' } },
      { args: { filePath: 'src/app-31.js', content: 'x' } }
    );
  }, 'Delegate instead of using write directly');

  // No over-scope: B is an Orchestrator too. Already true pre-fix via the
  // stolen slot — must STAY true post-fix via the Set.
  await expectBlock('31.1e root B bash: also an Orchestrator, blocked (no over-scope)', () => {
    callID++;
    return before31(
      { tool: 'bash', sessionID: orchB, callID: 'call_' + callID, args: { command: 'node --version' } },
      { args: { command: 'node --version' } }
    );
  }, 'Delegate instead of using bash directly');

  // Anti-over-block regression: an unregistered child session still resolves
  // the executor bridge — the fix must not block children.
  await expectPass('31.1f unregistered child bash npm install: resolves executor via bridge, passes', () => {
    callID++;
    return before31(
      { tool: 'bash', sessionID: 'ses_bridge_root31', callID: 'call_' + callID, args: { command: 'npm install' } },
      { args: { command: 'npm install' } }
    );
  });

  // 31.2 — hijack/--continue path (:1204): an UNREGISTERED session calling
  // task self-promotes to root. Pre-fix it hijacked the single slot (X kept
  // orchestrator status only until Y stole it in turn); post-fix it joins
  // rootSessions permanently. 31.2a/31.2b were already green pre-fix (X
  // owns the slot right after its own task) — pins of non-regression.
  const sesX = 'ses_unregistered_X_31';
  await expectPass('31.2a unregistered X delegates legitimately to executor: PASS', () => {
    callID++;
    return before31(
      { tool: 'task', sessionID: sesX, callID: 'call_' + callID },
      { args: { subagent_type: 'executor', description: 'domain:implementation - x31', prompt: 'domain:implementation root cause known, unregistered X delegation' } }
    );
  });
  await expectBlock('31.2b X write after its own task: X is now a root/Orchestrator, must delegate', () => {
    callID++;
    return before31(
      { tool: 'write', sessionID: sesX, callID: 'call_' + callID, args: { filePath: 'src/app-31x.js', content: 'x' } },
      { args: { filePath: 'src/app-31x.js', content: 'x' } }
    );
  }, 'Delegate instead of using write directly');

  const sesY = 'ses_unregistered_Y_31';
  await expectPass('31.2c second unregistered Y delegates: must not disarm X', () => {
    callID++;
    return before31(
      { tool: 'task', sessionID: sesY, callID: 'call_' + callID },
      { args: { subagent_type: 'executor', description: 'domain:implementation - y31', prompt: 'domain:implementation root cause known, unregistered Y delegation' } }
    );
  });
  // THE RED (:1204 hijack): pre-fix, Y's task steals the slot from X — X
  // is left uncovered by check 2.5, crystallizes the executor residue and
  // write passes with the executor profile.
  await expectBlock('31.2d X write STILL blocked after Y took the hijack path', () => {
    callID++;
    return before31(
      { tool: 'write', sessionID: sesX, callID: 'call_' + callID, args: { filePath: 'src/app-31x2.js', content: 'x' } },
      { args: { filePath: 'src/app-31x2.js', content: 'x' } }
    );
  }, 'Delegate instead of using write directly');
}

console.log(`\n=== RESULTS: ${pass} passed, ${fail} failed out of ${pass+fail} tests ===\n`);
if (failures.length) {
  console.log('FAILURES:');
  failures.forEach(f => console.log(' -', f));
}
