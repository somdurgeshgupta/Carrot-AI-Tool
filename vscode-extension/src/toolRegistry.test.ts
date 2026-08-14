import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry, OperationRisk } from './toolRegistry';

const signal = new AbortController().signal;

test('executes registered tools and rejects unknown tools', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'echo', description: 'echo', inputSchema: {}, risk: OperationRisk.READ_ONLY, requiresApproval: false,
    validate: args => { if (typeof args.value !== 'string') throw new Error('invalid value'); },
    execute: async args => args.value,
  });
  const context = { signal, approve: async () => true };
  assert.equal((await registry.execute({ type: 'tool_call', id: '1', tool: 'echo', arguments: { value: 'ok' } }, context)).result, 'ok');
  assert.match((await registry.execute({ type: 'tool_call', id: '2', tool: 'missing', arguments: {} }, context)).error!, /Unknown tool/);
});

test('does not execute a rejected write operation', async () => {
  let executed = false;
  const registry = new ToolRegistry();
  registry.register({
    name: 'write', description: 'write', inputSchema: {}, risk: OperationRisk.NORMAL_WRITE, requiresApproval: true,
    validate: () => {}, execute: async () => { executed = true; },
  });
  const result = await registry.execute(
    { type: 'tool_call', id: '1', tool: 'write', arguments: {} },
    { signal, approve: async () => false },
  );
  assert.equal(executed, false);
  assert.match(result.error!, /rejected/);
});

test('debug events omit edit content and report only safe arguments and counts', async () => {
  const events: any[] = [];
  const registry = new ToolRegistry(event => events.push(event));
  registry.register({
    name: 'search', description: 'search', inputSchema: {}, risk: OperationRisk.READ_ONLY, requiresApproval: false,
    validate: () => {},
    execute: async () => ({ matches: [{ path: 'src/auth.ts' }] }),
  });
  await registry.execute(
    { type: 'tool_call', id: '1', tool: 'search', arguments: { query: 'auth', oldText: 'SECRET-CONTENT' } },
    { signal, approve: async () => true },
  );
  assert.deepEqual(events[0].arguments, { query: 'auth' });
  assert.equal(JSON.stringify(events).includes('SECRET-CONTENT'), false);
  assert.equal(events.at(-1).resultCount, 1);
});
