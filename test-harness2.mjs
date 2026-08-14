import { DelegationGuard } from './delegation-guard.js';

const mockClient = { tui: { showToast: async () => {} } };
const guard = await DelegationGuard({
  project: { id: 'test-project' },
  client: mockClient,
  $: async () => {},
  directory: '/home/claude/fake-project',
  worktree: '/'
});
const before = guard['tool.execute.before'];

let pass = 0, fail = 0;
const failures = [];
let callID = 0;
let subCounter = 0;

async function preloadConductorRules(guardObj, sessionID) {
  // Normalizza come fa internamente l'hook (input.sessionID || 'default') —
  // orchSession può arrivare undefined da chiamanti che lasciano il default.
  const sid = sessionID || 'default';
  // Registra sid come root session (Orchestratore) via l'event hook
  // "session.created" — stesso meccanismo di produzione (vedi guard4/event4
  // sotto) — così isOrchestrator risolve true per questa sessionID SUBITO,
  // senza dover passare da una vera task call (che self-heala solo DOPO,
  // troppo tardi per sbloccare il gate sulla task call stessa).
  const eventFn = guardObj['event'];
  if (eventFn) {
    await eventFn({ event: { type: 'session.created', properties: { sessionID: sid, info: { agent: 'orchestrator' } } } });
  }
  const beforeFn = guardObj['tool.execute.before'];
  callID++;
  return beforeFn(
    { tool: 'skill', sessionID: sid, callID: 'call_' + callID },
    { args: { name: 'conductor-rules' } }
  ).catch(() => {});
}

async function delegateAndCrystallize(subagentType, description, prompt, orchSession) {
  // 0. Precarica conductor-rules per non incappare nel gate 2.6 (non è il focus qui)
  await preloadConductorRules(guard, orchSession);
  // 1. L'Orchestratore delega (dalla sua sessione)
  callID++;
  await before(
    { tool: 'task', sessionID: orchSession, callID: 'call_' + callID },
    { args: { subagent_type: subagentType, description, prompt } }
  ).catch(() => {}); // ignoriamo eventuali blocchi qui, non è il focus del test
  // 2. Il subagent (nuova sessione) fa una prima tool call innocua per cristallizzare
  subCounter++;
  const subSession = 'ses_sub_' + subCounter;
  callID++;
  try {
    await before(
      { tool: 'read', sessionID: subSession, callID: 'call_' + callID, args: { filePath: '/home/claude/fake-project/README.md' } },
      { args: { filePath: '/home/claude/fake-project/README.md' } }
    );
  } catch (e) { /* ignora - non e' il focus */ }
  return subSession;
}

async function expectPass(name, fn) {
  try { await fn(); pass++; }
  catch (e) { fail++; failures.push(`[DOVEVA PASSARE] ${name} -> BLOCCATO: ${e.message.split('\n')[0]}`); }
}
async function expectBlock(name, fn, mustContain) {
  try {
    await fn();
    fail++; failures.push(`[DOVEVA BLOCCARE] ${name} -> PASSATO senza errori`);
  } catch (e) {
    if (mustContain && !e.message.includes(mustContain)) {
      fail++; failures.push(`[MESSAGGIO SBAGLIATO] ${name} -> "${e.message.split('\n')[0]}" (atteso contenesse "${mustContain}")`);
    } else pass++;
  }
}
function call(tool, sessionID, args) {
  callID++;
  return before({ tool, sessionID, callID: 'call_' + callID, args }, { args });
}
async function taskCall(subagentType, description, prompt, orchSession = 'ses_orch_' + (++subCounter)) {
  // Precarica conductor-rules per non incappare nel gate 2.6 (non è il focus qui)
  await preloadConductorRules(guard, orchSession);
  callID++;
  return before(
    { tool: 'task', sessionID: orchSession, callID: 'call_' + callID },
    { args: { subagent_type: subagentType, description, prompt } }
  );
}

// ============================================================
console.log('--- 1. ROUTING / DOMAIN ---');
await expectPass('domain corretto: executor/implementation con diagnosi', async () => {
  await taskCall('executor', 'domain:implementation - fix bug X', 'domain:implementation causa root identificata, applica fix a bug X');
  await call('read', 'ses_sub_r1', { filePath: '/home/claude/fake-project/a.txt' });
});

await expectBlock('domain mancante', () =>
  taskCall('executor', 'fix bug X senza domain', 'Applica fix a bug X'), 'Dominio del task non dichiarato');

await expectPass('domain alias: architecture -> architecture_analysis', async () => {
  await taskCall('codebase-mapper', 'domain:architecture - mappa progetto', 'domain:architecture Mappa architettura');
  await call('read', 'ses_sub_r2', { filePath: '/home/claude/fake-project/b.txt' });
});

await expectBlock('domain sbagliato per agente (review su code-reviewer)', () =>
  taskCall('code-reviewer', 'domain:review - analisi', 'domain:review Analizza il piano'), 'esiste ma è gestito da');

await expectPass('domain corretto per code-reviewer: quality_analysis', async () => {
  await taskCall('code-reviewer', 'domain:quality_analysis - analisi codice', 'domain:quality_analysis Analizza qualità del codice');
  await call('read', 'ses_sub_r3', { filePath: '/home/claude/fake-project/c.txt' });
});

console.log('--- 2. WORKFLOW: fix richiede diagnosi ---');
await expectBlock('executor fix senza diagnosi precedente', () =>
  taskCall('executor', 'domain:implementation - fix bug Y', 'domain:implementation Fix del bug Y'), 'Fix richiede diagnosi prima');

await expectPass('executor fix con causa root nel prompt', async () => {
  await taskCall('executor', 'domain:implementation - fix bug Y', 'domain:implementation La causa root è: fix del bug Y');
  await call('read', 'ses_sub_r4', { filePath: '/home/claude/fake-project/d.txt' });
});

console.log('--- 3. SENSITIVE FILES (read/grep/glob/edit/write/bash) ---');
for (const tool of ['read', 'grep', 'glob']) {
  const sess = await delegateAndCrystallize('executor', 'domain:implementation - leggi config', 'domain:implementation causa root nota, leggi config');
  await expectBlock(`sensitive file via ${tool}`, () => call(tool, sess, { filePath: 'C:\\App\\project\\.env' }));
}
{
  const sess = await delegateAndCrystallize('executor', 'domain:implementation - leggi file', 'domain:implementation causa root nota, leggi app.py');
  await expectPass('read file normale', () => call('read', sess, { filePath: 'C:\\App\\project\\app.py' }));
}
{
  const sess = await delegateAndCrystallize('executor', 'domain:implementation - edit config', 'domain:implementation causa root nota, modifica config');
  await expectBlock('sensitive file via edit', () => call('edit', sess, { filePath: 'C:\\App\\project\\.env', oldString: 'a', newString: 'b' }));
}
{
  const sess = await delegateAndCrystallize('executor', 'domain:implementation - write config', 'domain:implementation causa root nota, scrivi config');
  await expectBlock('sensitive file via write', () => call('write', sess, { filePath: 'C:\\App\\project\\.env', content: 'x' }));
}
{
  const sess = await delegateAndCrystallize('executor', 'domain:implementation - bash config', 'domain:implementation causa root nota, leggi con bash');
  await expectBlock('sensitive file via bash Get-Content', () => call('bash', sess, { command: 'Get-Content "C:\\Users\\test\\.env"' }));
}
{
  const sess = await delegateAndCrystallize('executor', 'domain:implementation - npm install', 'domain:implementation causa root nota, installa dipendenze');
  await expectPass('bash comando normale (npm install)', () => call('bash', sess, { command: 'npm install' }));
}

console.log('--- 4. NO TEST EXECUTION per executor ---');
{
  const sess = await delegateAndCrystallize('executor', 'domain:implementation - run tests', 'domain:implementation causa root nota, verifica');
  await expectBlock('executor non può eseguire npm test', () => call('bash', sess, { command: 'npm test' }), 'TEST EXECUTION');
  await expectBlock('executor non può eseguire pytest', () => call('bash', sess, { command: 'pytest tests/' }), 'TEST EXECUTION');
}
{
  const sess = await delegateAndCrystallize('verifier', 'domain:verification - run tests', 'domain:verification esegui la suite di test');
  await expectPass('verifier PUO eseguire npm test', () => call('bash', sess, { command: 'npm test' }));
}

console.log('--- 5. SHELL MUTATION per agenti readOnlyDespiteFullBash ---');
{
  const sess = await delegateAndCrystallize('verifier', 'domain:verification - fix rapido', 'domain:verification verifica il file');
  await expectBlock('verifier non può scrivere via Set-Content', () => call('bash', sess, { command: 'Set-Content -Path file.py -Value "x"' }), 'SHELL MUTATION');
  await expectPass('verifier redirection 2>&1 non bloccata', () => call('bash', sess, { command: 'npx jest --runInBand 2>&1' }));
}
{
  const sess = await delegateAndCrystallize('debugger', 'domain:debugging - diagnosi', 'domain:debugging diagnostica il problema');
  await expectBlock('debugger non può scrivere via sed -i', () => call('bash', sess, { command: 'sed -i "s/old/new/" file.py' }), 'SHELL MUTATION');
}

console.log('--- 6. ORCHESTRATOR non può usare tool direttamente ---');
{
  const orchSession = 'ses_orch_direct_test';
  // Stabilisce orchSession come Orchestratore riconosciuto (self-healing) con
  // una vera delega, prima di testare i blocchi diretti — altrimenti isOrchestrator
  // risulta false per questa sessione (nessuno l'ha mai vista delegare).
  await taskCall('executor', 'domain:implementation - stabilisci orchestratore', 'domain:implementation causa root nota, stabilisci', orchSession).catch(() => {});
  for (const tool of ['bash', 'edit', 'write', 'read', 'grep', 'glob']) {
    await expectBlock(`orchestratore non può usare ${tool} direttamente`, () =>
      call(tool, orchSession, tool === 'bash' ? { command: 'echo hi' } : { filePath: 'x.txt' }));
  }
  await expectPass('orchestratore PUO usare webfetch direttamente', () =>
    call('webfetch', orchSession, { url: 'https://example.com' }));
  await expectPass('orchestratore PUO usare websearch direttamente', () =>
    call('websearch', orchSession, { query: 'test' }));
  await expectPass('orchestratore PUO usare todowrite', () =>
    call('todowrite', orchSession, { todos: [] }));
}

console.log('--- 7. SWARM MODE: parallelo stesso agente OK, tipi diversi bloccati ---');
{
  // Istanza fresca per evitare pendingAgentTypes residui dalle sezioni precedenti
  const guard2 = await DelegationGuard({
    project: { id: 'test-project-swarm' }, client: mockClient, $: async () => {},
    directory: '/home/claude/fake-project-swarm', worktree: '/'
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
  await expectPass('primo executor in parallelo', () =>
    taskCall2('executor', 'domain:implementation - step1', 'domain:implementation causa root nota, step1', orchSessionA));
  await expectPass('secondo executor in parallelo (swarm, stesso tipo OK)', () =>
    taskCall2('executor', 'domain:implementation - step2', 'domain:implementation causa root nota, step2', orchSessionA));

  const orchSessionB = 'ses_orch_swarm_testB';
  const guard3 = await DelegationGuard({
    project: { id: 'test-project-swarm2' }, client: mockClient, $: async () => {},
    directory: '/home/claude/fake-project-swarm2', worktree: '/'
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
  await expectPass('prima delega explorer', () =>
    taskCall3('explorer', 'domain:exploration - ctx', 'domain:exploration raccogli contesto', orchSessionB));
  await expectBlock('delega parallela tipo diverso bloccata (explorer ancora pending)', () =>
    taskCall3('codebase-mapper', 'domain:architecture - mappa', 'domain:architecture mappa architettura', orchSessionB),
    'PARALLEL CONFLICT');
}

console.log('--- 8. ORCHESTRATOR HIJACK GUARD: subagent auto-delega prima di cristallizzare ---');
{
  // Regressione per il bug 2026-08-05: una sessione subagent la cui identità non è
  // ancora cristallizzata (nessuna tool call reale fatta) e la cui prima azione è una
  // delega diretta (es. verifier->executor via canDelegateTo) veniva scambiata per un
  // nuovo Orchestratore, dirottando orchestratorSessionID e lasciando il VERO
  // Orchestratore senza protezione. Fix: subagentRegistry (session.created) impedisce
  // il dirottamento quando il registry ha già confermato che la sessione è una FIGLIA.
  const guard4 = await DelegationGuard({
    project: { id: 'test-project-hijack' }, client: mockClient, $: async () => {},
    directory: '/home/claude/fake-project-hijack', worktree: '/'
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
    { args: { subagent_type: 'verifier', description: 'domain:verification - verifica fix', prompt: 'domain:verification verifica il fix applicato' } }
  ).catch(() => {});

  const verifierSession = 'ses_sub_verifier_hijack_test';
  // Simula session.created (registry) per verifier PRIMA che lui faccia qualsiasi
  // tool call reale — libera pendingAgentTypes (fast-release) ma NON cristallizza
  // state.lastAgent (quello richiede una tool call non-task).
  await event4({ event: { type: 'session.created', properties: { sessionID: verifierSession, info: { parentID: orchSession, agent: 'verifier' } } } });

  await expectPass('verifier (non cristallizzato) delega direttamente executor', () => {
    callID++;
    return before4(
      { tool: 'task', sessionID: verifierSession, callID: 'call_' + callID },
      { args: { subagent_type: 'executor', description: 'domain:implementation - applica fix', prompt: 'domain:implementation causa root: verifica fallita, applica fix' } }
    );
  });

  await expectBlock('Orchestratore resta protetto (non dirottato) dopo l\'auto-delega di verifier', () =>
    call4('read', orchSession, { filePath: '/home/claude/fake-project-hijack/x.txt' }),
    'Delega invece di usare read direttamente');

  await expectPass('verifier NON scambiato per Orchestratore dopo aver delegato', () =>
    call4('read', verifierSession, { filePath: '/home/claude/fake-project-hijack/y.txt' }));
}

console.log('--- 9. CONDUCTOR-RULES GATE: skill deve essere caricata prima della prima delega ---');
{
  const guardGateBlock = await DelegationGuard({
    project: { id: 'test-project-gate-block' }, client: mockClient, $: async () => {},
    directory: '/home/claude/fake-project-gate-block', worktree: '/'
  });
  const beforeGB = guardGateBlock['tool.execute.before'];
  await expectBlock('orchestratore delega senza aver caricato conductor-rules', () => {
    callID++;
    return beforeGB(
      { tool: 'task', sessionID: 'ses_orch_gate_block', callID: 'call_' + callID },
      { args: { subagent_type: 'executor', description: 'domain:implementation - test gate', prompt: 'domain:implementation causa root nota, test gate' } }
    );
  }, 'conductor-rules');
}
{
  const guardGateAllow = await DelegationGuard({
    project: { id: 'test-project-gate-allow' }, client: mockClient, $: async () => {},
    directory: '/home/claude/fake-project-gate-allow', worktree: '/'
  });
  const beforeGA = guardGateAllow['tool.execute.before'];
  await expectPass('orchestratore carica conductor-rules poi delega con successo', async () => {
    callID++;
    await beforeGA(
      { tool: 'skill', sessionID: 'ses_orch_gate_allow', callID: 'call_' + callID },
      { args: { name: 'conductor-rules' } }
    );
    callID++;
    await beforeGA(
      { tool: 'task', sessionID: 'ses_orch_gate_allow', callID: 'call_' + callID },
      { args: { subagent_type: 'executor', description: 'domain:implementation - test gate ok', prompt: 'domain:implementation causa root nota, test gate ok' } }
    );
  });
}
{
  const guardGateSub = await DelegationGuard({
    project: { id: 'test-project-gate-sub' }, client: mockClient, $: async () => {},
    directory: '/home/claude/fake-project-gate-sub', worktree: '/'
  });
  const beforeGS = guardGateSub['tool.execute.before'];
  const orchSessionGS = 'ses_orch_gate_sub_setup';
  callID++;
  await beforeGS(
    { tool: 'task', sessionID: orchSessionGS, callID: 'call_' + callID },
    { args: { subagent_type: 'verifier', description: 'domain:verification - setup subagent', prompt: 'domain:verification setup subagent per gate test' } }
  ).catch(() => {});

  const subSessionGS = 'ses_sub_gate_nonorch';
  // Cristallizza l'identità del subagent (lastAgent=verifier) con una tool call reale,
  // come nelle altre sezioni (es. delegateAndCrystallize).
  callID++;
  await beforeGS(
    { tool: 'read', sessionID: subSessionGS, callID: 'call_' + callID, args: { filePath: '/home/claude/fake-project-gate-sub/x.txt' } },
    { args: { filePath: '/home/claude/fake-project-gate-sub/x.txt' } }
  );

  await expectPass('subagent (non orchestratore) delega senza essere soggetto al gate conductor-rules', () => {
    callID++;
    return beforeGS(
      { tool: 'task', sessionID: subSessionGS, callID: 'call_' + callID },
      { args: { subagent_type: 'executor', description: 'domain:implementation - delega da subagent', prompt: 'domain:implementation causa root nota, delega da subagent' } }
    );
  });
}
{
  // Simula riavvio del processo del plugin (es. chiusura/riapertura di OpenCode)
  // sulla STESSA sessionID: una nuova istanza di DelegationGuard parte con
  // sessionState (Map in-memory) vuota, ma lo storico messaggi della sessione
  // (via client.session.messages) contiene già una chiamata a Skill('conductor-rules').
  // Il gate non deve richiedere di ricaricarla una seconda volta.
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
    directory: '/home/claude/fake-project-gate-restart', worktree: '/'
  });
  const beforeGR = guardGateRestart['tool.execute.before'];
  await expectPass('dopo riavvio plugin (Map vuota) sulla stessa sessione, storico conferma conductor-rules già caricata', () => {
    callID++;
    return beforeGR(
      { tool: 'task', sessionID: restartSessionID, callID: 'call_' + callID },
      { args: { subagent_type: 'executor', description: 'domain:implementation - test gate restart', prompt: 'domain:implementation causa root nota, test gate restart' } }
    );
  });
}

console.log('--- 10. SCOPE VIOLATION REPEAT-TARGET ESCALATION: stesso path fuori scope ripetuto ---');
{
  // NOTA: usiamo process.cwd() come project directory (invece di un path fittizio
  // stile /home/claude/...) e filePath RELATIVI — riflette come funzionano davvero
  // normalizePathForCheck (strip di un solo "/" iniziale, non del prefisso progetto)
  // e validatePathZone (containment via path.resolve). Con un project dir fittizio
  // e filePath assoluti "prefissati", il check SCOPE (che si aspetta "spikes/...")
  // fallirebbe sempre indipendentemente dallo scope reale, invalidando il test.
  const guardScope = await DelegationGuard({
    project: { id: 'test-project-scope-escalate' }, client: mockClient, $: async () => {},
    directory: process.cwd(), worktree: '/'
  });
  const beforeSE = guardScope['tool.execute.before'];
  const eventSE = guardScope['event'];
  const orchSessionSE = 'ses_orch_scope_escalate';
  const subSessionSE = 'ses_sub_scope_escalate';

  // Registra la sessione root come Orchestratore e la sessione figlia come spiker,
  // via l'event hook session.created — stesso meccanismo di produzione (vedi sezione 9).
  await eventSE({ event: { type: 'session.created', properties: { sessionID: orchSessionSE, info: { agent: 'orchestrator' } } } });
  await eventSE({ event: { type: 'session.created', properties: { sessionID: subSessionSE, info: { agent: 'spiker', parentID: orchSessionSE } } } });

  const outOfScopePath = 'src/real-fix.ts';

  await expectBlock('1° tentativo su path fuori scope: errore SCOPE generico, non escalation', () => {
    callID++;
    return beforeSE(
      { tool: 'write', sessionID: subSessionSE, callID: 'call_' + callID, args: { filePath: outOfScopePath, content: 'x' } },
      { args: { filePath: outOfScopePath, content: 'x' } }
    );
  }, 'SCOPE');

  await expectBlock('2° tentativo sullo STESSO path fuori scope: escalation a ROUTING/redelega', () => {
    callID++;
    return beforeSE(
      { tool: 'write', sessionID: subSessionSE, callID: 'call_' + callID, args: { filePath: outOfScopePath, content: 'y' } },
      { args: { filePath: outOfScopePath, content: 'y' } }
    );
  }, 'ROUTING');

  const otherOutOfScopePath = 'src/other-file.ts';
  await expectBlock('tentativo su un path DIVERSO, mai visto prima: errore SCOPE generico (no escalation prematura)', () => {
    callID++;
    return beforeSE(
      { tool: 'write', sessionID: subSessionSE, callID: 'call_' + callID, args: { filePath: otherOutOfScopePath, content: 'z' } },
      { args: { filePath: otherOutOfScopePath, content: 'z' } }
    );
  }, 'SCOPE');

  await expectPass('scrittura dentro il proprio writeScope resta permessa', () => {
    callID++;
    return beforeSE(
      { tool: 'write', sessionID: subSessionSE, callID: 'call_' + callID, args: { filePath: 'spikes/ok.js', content: 'x' } },
      { args: { filePath: 'spikes/ok.js', content: 'x' } }
    );
  });
}

console.log('--- 11. FASE PRE-DELEGATION: tool "question" (domande interattive) sempre permesso ---');
{
  const guardPreDeleg = await DelegationGuard({
    project: { id: 'test-project-pre-delegation' }, client: mockClient, $: async () => {},
    directory: '/home/claude/fake-project-pre-delegation', worktree: '/'
  });
  const beforePD = guardPreDeleg['tool.execute.before'];
  const orchSessionPD = 'ses_orch_pre_delegation';

  // Preload conductor-rules (gate 2.6) sulla sessione dell'Orchestratore.
  callID++;
  await beforePD(
    { tool: 'skill', sessionID: orchSessionPD, callID: 'call_' + callID },
    { args: { name: 'conductor-rules' } }
  );

  // Delega a explorer (canPreDelegate: true) → mette l'Orchestratore in fase 'pre-delegation'.
  callID++;
  await beforePD(
    { tool: 'task', sessionID: orchSessionPD, callID: 'call_' + callID },
    { args: { subagent_type: 'explorer', description: 'domain:exploration - mappa il modulo auth', prompt: 'domain:exploration mappa il modulo auth prima di delegare il fix' } }
  );

  await expectPass('tool "question" permesso in fase pre-delegation (domanda interattiva all\'utente)', () => {
    callID++;
    return beforePD(
      { tool: 'question', sessionID: orchSessionPD, callID: 'call_' + callID, args: { text: 'Vuoi che proceda con l\'opzione A o B?' } },
      { args: { text: 'Vuoi che proceda con l\'opzione A o B?' } }
    );
  });

  await expectBlock('bash resta vietato in fase pre-delegation (nessun allentamento indesiderato)', () => {
    callID++;
    return beforePD(
      { tool: 'bash', sessionID: orchSessionPD, callID: 'call_' + callID, args: { command: 'ls' } },
      { args: { command: 'ls' } }
    );
  }, 'Delega');
}

console.log(`\n=== RISULTATI: ${pass} passati, ${fail} falliti su ${pass+fail} test ===\n`);
if (failures.length) {
  console.log('FALLIMENTI:');
  failures.forEach(f => console.log(' -', f));
}
