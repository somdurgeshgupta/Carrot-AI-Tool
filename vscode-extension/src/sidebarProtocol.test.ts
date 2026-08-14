import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSidebarMessage } from './sidebarProtocol';

test('accepts the bounded chat and model message protocol', () => {
  assert.deepEqual(parseSidebarMessage({ type: 'sendMessage', prompt: 'hello', mode: 'agent', webSearch: true }), { type: 'sendMessage', prompt: 'hello', mode: 'agent', webSearch: true });
  assert.deepEqual(parseSidebarMessage({ type: 'selectModel', modelId: 'local:qwen3:8b' }), { type: 'selectModel', modelId: 'local:qwen3:8b' });
  assert.deepEqual(parseSidebarMessage({ type: 'refreshModels' }), { type: 'refreshModels' });
  assert.deepEqual(parseSidebarMessage({ type: 'addContext', kind: 'selection' }), { type: 'addContext', kind: 'selection' });
  assert.deepEqual(parseSidebarMessage({ type: 'setWebSearch', enabled: false }), { type: 'setWebSearch', enabled: false });
});

test('does not provide Webview filesystem or secret-reading operations', () => {
  assert.equal(parseSidebarMessage({ type: 'readFile', path: 'C:\\Users\\secret.env' }), undefined);
  assert.equal(parseSidebarMessage({ type: 'getSecret', key: 'carrot.accessToken' }), undefined);
  assert.equal(parseSidebarMessage({ type: 'request', url: 'http://localhost:3000/api' }), undefined);
});

test('rejects malformed values and non-http external links', () => {
  assert.equal(parseSidebarMessage({ type: 'sendMessage', prompt: '' }), undefined);
  assert.equal(parseSidebarMessage({ type: 'openExternal', url: 'javascript:alert(1)' }), undefined);
  assert.equal(parseSidebarMessage({ type: 'toggleLocalOnly', enabled: 'yes' }), undefined);
  assert.equal(parseSidebarMessage({ type: 'sendMessage', prompt: 'hello', mode: 'unsafe', webSearch: true }), undefined);
  assert.equal(parseSidebarMessage({ type: 'addContext', kind: '../../secret' }), undefined);
});
