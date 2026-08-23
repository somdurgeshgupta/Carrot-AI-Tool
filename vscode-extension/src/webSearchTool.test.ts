import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry } from './toolRegistry';
import { registerWebSearchTool, validatePublicUrl } from './webSearchTool';

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

test('fetch_url is exposed with search and validates public URLs', async () => {
  const registry = new ToolRegistry(); let fetched = '';
  registerWebSearchTool(registry, async () => ({ results: [] }), async url => { fetched = url; return { text: 'docs', untrusted: true }; });
  assert.equal(registry.definitions().some(tool => tool.name === 'fetch_url'), true);
  const context = { signal: new AbortController().signal, approve: async () => true };
  await registry.execute({ type: 'tool_call', id: 'fetch', tool: 'fetch_url', arguments: { url: 'https://docs.nestjs.com/controllers' } }, context);
  assert.equal(fetched, 'https://docs.nestjs.com/controllers');
  assert.equal(validatePublicUrl('https://docs.nestjs.com/controllers').hostname, 'docs.nestjs.com');
  for (const url of ['http://localhost:3000', 'http://127.0.0.1/a', 'https://user:pass@example.com']) assert.throws(() => validatePublicUrl(url));
});
