import assert from 'node:assert/strict';
import test from 'node:test';
import { hasConversationMessages } from './sessionPolicy';

test('an unused session remains reusable until the first conversation message', () => {
  assert.equal(hasConversationMessages(undefined), false);
  assert.equal(hasConversationMessages([]), false);
  assert.equal(hasConversationMessages([
    { id: 'system', role: 'system', content: 'instructions', createdAt: '' },
  ]), false);
  assert.equal(hasConversationMessages([
    { id: 'user', role: 'user', content: 'hello', createdAt: '' },
  ]), true);
});
