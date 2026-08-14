import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentResponse } from './toolProtocol';

test('parses strict tool calls and final responses', () => {
  assert.deepEqual(parseAgentResponse('{"type":"tool_call","id":"call_1","tool":"read_file","arguments":{"path":"src/a.ts"}}'), {
    type: 'tool_call', id: 'call_1', tool: 'read_file', arguments: { path: 'src/a.ts' },
  });
  assert.deepEqual(parseAgentResponse('```json\n{"type":"final","content":"Done"}\n```'), { type: 'final', content: 'Done' });
});

test('rejects malformed and natural-language tool requests', () => {
  assert.throws(() => parseAgentResponse('run rm -rf now'), /malformed/);
  assert.throws(() => parseAgentResponse('I will run this: {"tool":"read_file","arguments":{"path":"src/a.ts"}}'), /malformed/);
  assert.throws(() => parseAgentResponse('{"type":"tool_call","id":"bad id","tool":"read_file","arguments":{}}'), /invalid/);
});

test('normalizes common safe model tool-call variants', () => {
  const response = parseAgentResponse('<think>I should inspect.</think>\n```json\n{"name":"read_file","parameters":{"path":"src/a.ts"}}\n```');
  assert.equal(response.type, 'tool_call');
  if (response.type === 'tool_call') {
    assert.match(response.id, /^call_[a-f0-9]+$/);
    assert.equal(response.tool, 'read_file');
    assert.deepEqual(response.arguments, { path: 'src/a.ts' });
  }
  assert.deepEqual(parseAgentResponse('{"type":"final","answer":"Done safely"}'), { type: 'final', content: 'Done safely' });
});

test('accepts a complete fenced tool call without permitting surrounding prose', () => {
  const call = parseAgentResponse('```json\n{"tool":"search_workspace","arguments":{"query":"auth"}}\n```');
  assert.equal(call.type, 'tool_call');
  if (call.type === 'tool_call') {
    assert.equal(call.tool, 'search_workspace');
    assert.deepEqual(call.arguments, { query: 'auth' });
  }
  assert.throws(() => parseAgentResponse('Use this:\n```json\n{"tool":"search_workspace","arguments":{"query":"auth"}}\n```'), /malformed/);
});

test('parses nested tool calls without executing invalid structures', () => {
  assert.deepEqual(parseAgentResponse('{"tool_call":{"id":"nested_1","name":"inspect","input":{}}}'), {
    type: 'tool_call', id: 'nested_1', tool: 'inspect', arguments: {},
  });
  assert.throws(() => parseAgentResponse('{"tool":"bad tool","arguments":{}}'), /invalid/);
});

test('accepts one known wrapper around a structured call', () => {
  const response = parseAgentResponse('{"response":{"tool":"search_workspace","arguments":{"query":"auth"}}}');
  assert.equal(response.type, 'tool_call');
  if (response.type === 'tool_call') assert.deepEqual(response.arguments, { query: 'auth' });
});
