import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry } from './toolRegistry';
import { registerWebSearchTool } from './webSearchTool';

test('web_search is unavailable when the composer toggle is off', () => {
  const registry = new ToolRegistry();
  registerWebSearchTool(registry);
  assert.equal(registry.definitions().some(tool => tool.name === 'web_search'), false);
});

test('web_search is exposed and validated only when enabled', async () => {
  const registry = new ToolRegistry();
  let query = '';
  registerWebSearchTool(registry, async value => { query = value; return { results: 'current result' }; });
  assert.equal(registry.definitions().some(tool => tool.name === 'web_search'), true);
  const context = { signal: new AbortController().signal, approve: async () => true };
  const result = await registry.execute({ type: 'tool_call', id: '1', tool: 'web_search', arguments: { query: 'Angular latest' } }, context);
  assert.equal(result.error, undefined);
  assert.equal(query, 'Angular latest');
  const invalid = await registry.execute({ type: 'tool_call', id: '2', tool: 'web_search', arguments: { query: '' } }, context);
  assert.match(invalid.error ?? '', /Invalid query/);
});
