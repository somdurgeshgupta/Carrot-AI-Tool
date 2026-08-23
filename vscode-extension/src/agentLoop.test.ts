import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentLoop, requiresAgentTools, requiresLiveWeb } from './agentLoop';
import { ToolRegistry, OperationRisk } from './toolRegistry';

function registry(): ToolRegistry {
  const value = new ToolRegistry();
  value.register({
    name: 'inspect', description: 'inspect', inputSchema: {}, risk: OperationRisk.READ_ONLY, requiresApproval: false,
    validate: () => {}, execute: async () => ({ found: true }),
  });
  return value;
}

test('chains multiple model-requested tools before the final response', async () => {
  const responses = [
    '{"type":"tool_call","id":"1","tool":"inspect","arguments":{}}',
    '{"type":"tool_call","id":"2","tool":"inspect","arguments":{}}',
    '{"type":"final","content":"Complete"}',
  ];
  const loop = new AgentLoop({
    registry: registry(),
    turn: async () => responses.shift()!,
    context: { signal: new AbortController().signal, approve: async () => true },
  });
  const result = await loop.run('inspect project');
  assert.equal(result.final, 'Complete');
  assert.equal(result.toolResults.length, 2);
});

test('enforces iteration limits and cancellation', async () => {
  const controller = new AbortController();
  const endless = new AgentLoop({
    registry: registry(),
    turn: async () => '{"type":"tool_call","id":"1","tool":"inspect","arguments":{}}',
    context: { signal: controller.signal, approve: async () => true },
    maxIterations: 2,
  });
  await assert.rejects(() => endless.run('loop'), /iteration limit/);
  controller.abort();
  await assert.rejects(() => endless.run('cancel'), /cancelled/);
});

test('allows a larger configured tool budget for project-wide analysis', async () => {
  let calls = 0;
  const loop = new AgentLoop({
    registry: registry(),
    turn: async () => ++calls <= 9
      ? `{"type":"tool_call","id":"${calls}","tool":"inspect","arguments":{}}`
      : '{"type":"final","content":"Complete"}',
    context: { signal: new AbortController().signal, approve: async () => true },
    maxIterations: 20,
  });
  const result = await loop.run('analyze the entire project');
  assert.equal(result.toolResults.length, 9);
  assert.equal(result.final, 'Complete');
});

test('asks the model to repair malformed JSON before any tool executes', async () => {
  const responses = ['I want to inspect first.', '{"name":"inspect","parameters":{}}', '{"type":"final","content":"Recovered"}'];
  const activity: string[] = [];
  const loop = new AgentLoop({
    registry: registry(),
    turn: async (_system, messages) => {
      if (responses.length === 2) assert.match(messages.at(-1)?.content ?? '', /FORMAT CORRECTION/);
      return responses.shift()!;
    },
    context: { signal: new AbortController().signal, approve: async () => true },
    onActivity: item => activity.push(item.label),
  });
  const result = await loop.run('inspect project');
  assert.equal(result.final, 'Recovered');
  assert.equal(result.toolResults.length, 1);
  assert.match(activity[0], /format was invalid/);
});

test('rejects a prose tool description and performs a bounded corrective retry', async () => {
  const responses = [
    'You should use search_workspace to inspect the project.',
    '{"tool":"inspect","arguments":{}}',
    '{"type":"final","content":"Evidence-based answer"}',
  ];
  const loop = new AgentLoop({
    registry: registry(),
    turn: async (_system, messages) => {
      if (responses.length === 2) assert.match(messages.at(-1)?.content ?? '', /Workspace tools are available/);
      return responses.shift()!;
    },
    context: { signal: new AbortController().signal, approve: async () => true },
  });
  const result = await loop.run('analyze this project');
  assert.equal(result.toolResults.length, 1);
  assert.equal(result.final, 'Evidence-based answer');
});

test('rejects a final answer before required workspace evidence', async () => {
  const responses = [
    '{"type":"final","content":"I assume it uses JWT"}',
    '{"tool":"inspect","arguments":{}}',
    '{"type":"final","content":"Inspected answer"}',
  ];
  const loop = new AgentLoop({
    registry: registry(), turn: async () => responses.shift()!,
    context: { signal: new AbortController().signal, approve: async () => true },
  });
  const result = await loop.run('explain authentication in this project');
  assert.equal(result.toolResults.length, 1);
  assert.equal(result.final, 'Inspected answer');
});

test('returns a clear compatibility error after repeated tool refusals', async () => {
  const loop = new AgentLoop({
    registry: registry(),
    turn: async () => 'I cannot access your files. Please use search_workspace manually.',
    context: { signal: new AbortController().signal, approve: async () => true },
    modelId: 'local:qwen3:8b', alternativeModels: ['local:qwen2.5-coder:7b'],
  });
  await assert.rejects(() => loop.run('inspect project'), /local:qwen3:8b failed.*Auto.*qwen2\.5-coder/s);
});

test('requires searches, multiple content reads, and grounded file references for project explanations', async () => {
  const value = new ToolRegistry();
  for (const name of ['search_workspace', 'search_files', 'read_file', 'read_file_range']) value.register({
    name, description: name, inputSchema: {}, risk: OperationRisk.READ_ONLY, requiresApproval: false,
    validate: () => {}, execute: async args => name.startsWith('search_')
      ? { matches: [{ path: 'backend/src/auth/auth.service.ts' }, { path: 'frontend/src/app/core/services/auth.service.ts' }] }
      : { path: args.path, content: 'authentication jwt login implementation' },
  });
  const responses = [
    '{"tool":"search_workspace","arguments":{"queries":["auth","jwt","login"]}}',
    '{"tool":"read_file","arguments":{"path":"backend/src/auth/auth.service.ts"}}',
    '{"type":"final","content":"Authentication uses JWT."}',
    '{"tool":"read_file","arguments":{"path":"frontend/src/app/core/services/auth.service.ts"}}',
    '{"type":"final","content":"Authentication hashes passwords with bcrypt during register/login, issues a JWT bearer token in backend/src/auth/auth.service.ts, sends it through an Authorization-header interceptor, and protects routes with a guard in frontend/src/app/core/services/auth.service.ts."}',
  ];
  const loop = new AgentLoop({ registry: value, turn: async () => responses.shift()!, context: { signal: new AbortController().signal, approve: async () => true } });
  const result = await loop.run('Explain how authentication works in this project.');
  assert.equal(result.toolResults.length, 7);
  assert.equal(result.metrics.correctiveRetries, 1);
});

test('reuses identical read-only tool results within one task', async () => {
  let executions = 0;
  const value = new ToolRegistry();
  value.register({
    name: 'get_project_info', description: 'info', inputSchema: {}, risk: OperationRisk.READ_ONLY, requiresApproval: false,
    validate: () => {}, execute: async () => { executions++; return { project: 'Carrot' }; },
  });
  const responses = [
    '{"tool":"get_project_info","arguments":{}}',
    '{"tool":"get_project_info","arguments":{}}',
    '{"type":"final","content":"Done"}',
  ];
  const loop = new AgentLoop({ registry: value, turn: async () => responses.shift()!, context: { signal: new AbortController().signal, approve: async () => true } });
  const result = await loop.run('inspect project');
  assert.equal(executions, 1);
  assert.equal(result.metrics.cacheHits, 1);
});

test('does not accept an editing final before write, diagnostics, and validation succeed', async () => {
  const value = new ToolRegistry();
  for (const name of ['edit_file', 'get_diagnostics', 'run_command']) value.register({
    name, description: name, inputSchema: {}, risk: name === 'get_diagnostics' ? OperationRisk.READ_ONLY : OperationRisk.NORMAL_WRITE,
    requiresApproval: name !== 'get_diagnostics', validate: () => {}, execute: async () => name === 'edit_file' ? { changedFiles: [{ path: 'src/a.ts' }] } : name === 'run_command' ? { exitCode: 0 } : {},
  });
  const responses = [
    '{"type":"final","content":"Done"}',
    '{"tool":"edit_file","arguments":{}}',
    '{"type":"final","content":"Edited"}',
    '{"tool":"get_diagnostics","arguments":{}}',
    '{"tool":"run_command","arguments":{}}',
    '{"type":"final","content":"Edited, checked diagnostics, and tests passed."}',
  ];
  const loop = new AgentLoop({ registry: value, turn: async () => responses.shift()!, context: { signal: new AbortController().signal, approve: async () => true } });
  const result = await loop.run('Fix one small issue in this file.');
  assert.equal(result.final, 'Edited, checked diagnostics, and tests passed.');
  assert.equal(result.metrics.correctiveRetries, 2);
});

test('requires a passing rerun after a failed validation command', async () => {
  const value = new ToolRegistry(); let runs = 0;
  for (const name of ['edit_file', 'get_diagnostics', 'run_project_action']) value.register({
    name, description: name, inputSchema: {}, risk: name === 'get_diagnostics' ? OperationRisk.READ_ONLY : OperationRisk.NORMAL_WRITE,
    requiresApproval: name !== 'get_diagnostics', validate: () => {}, execute: async () => name === 'edit_file' ? { changedFiles: [{}] } : name === 'run_project_action' ? { exitCode: runs++ ? 0 : 1, output: 'compile error' } : {},
  });
  const responses = ['{"tool":"edit_file","arguments":{}}', '{"tool":"get_diagnostics","arguments":{}}', '{"tool":"run_project_action","arguments":{}}', '{"type":"final","content":"done"}', '{"tool":"run_project_action","arguments":{}}', '{"type":"final","content":"verified"}'];
  const loop = new AgentLoop({ registry: value, turn: async () => responses.shift()!, context: { signal: new AbortController().signal, approve: async () => true } });
  assert.equal((await loop.run('Fix this issue.')).final, 'verified');
  assert.equal(runs, 2);
});

test('requires live search, a fetched page, and a cited retrieved URL', async () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'web_search', description: 'search', inputSchema: {}, risk: OperationRisk.READ_ONLY, requiresApproval: false, validate: () => {}, execute: async () => ({ results: [{ url: 'https://angular.dev/press-kit' }] }) });
  registry.register({ name: 'fetch_url', description: 'fetch', inputSchema: {}, risk: OperationRisk.READ_ONLY, requiresApproval: false, validate: () => {}, execute: async () => ({ url: 'https://angular.dev/press-kit', text: 'current', untrusted: true }) });
  const responses = ['{"type":"final","content":"I cannot access current data"}', '{"tool":"web_search","arguments":{}}', '{"tool":"fetch_url","arguments":{}}', '{"type":"final","content":"Current information: https://angular.dev/press-kit"}'];
  const loop = new AgentLoop({ registry, turn: async () => responses.shift()!, context: { signal: new AbortController().signal, approve: async () => true }, requiresLiveWeb: true });
  assert.match((await loop.run('latest Angular updates')).final, /https:\/\/angular\.dev/);
});

test('detects prompts that require current internet information', () => {
  for (const prompt of ['latest Angular updates', 'current news', 'search the internet for this NestJS error', 'recent product ideas']) assert.equal(requiresLiveWeb(prompt), true);
  assert.equal(requiresLiveWeb('explain this local function'), false);
});

test('routes clear-port and computer-control requests to agent tools', () => {
  for (const prompt of ['clear port 3000', 'kill the process on port 4200', 'check port 8080', 'restart backend', 'git status']) assert.equal(requiresAgentTools(prompt), true);
  assert.equal(requiresAgentTools('write a poem about carrots'), false);
});
