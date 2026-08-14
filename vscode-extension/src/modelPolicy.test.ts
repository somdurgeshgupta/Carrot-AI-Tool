import assert from 'node:assert/strict';
import test from 'node:test';
import { CarrotModel, selectableChatModels, validateModelSelection } from './modelPolicy';

const models: CarrotModel[] = [
  { id: 'local:qwen3:8b', model: 'qwen3:8b', name: 'Qwen', provider: 'ollama', location: 'local', type: 'chat', available: true },
  { id: 'local:nomic-embed-text', model: 'nomic-embed-text', name: 'Nomic', provider: 'ollama', location: 'local', type: 'embedding', available: true },
  { id: 'groq:llama', model: 'llama', name: 'Llama', provider: 'groq', location: 'cloud', type: 'chat', available: true },
];

test('embedding models are excluded from chat selection', () => {
  assert.deepEqual(selectableChatModels(models, false).map((model) => model.id), ['local:qwen3:8b', 'groq:llama']);
});

test('local-only selection excludes and blocks cloud models', () => {
  assert.deepEqual(selectableChatModels(models, true).map((model) => model.id), ['local:qwen3:8b']);
  assert.throws(() => validateModelSelection(models, 'groq:llama', true), /Local-only/);
});

test('Auto remains valid for deterministic backend routing', () => {
  assert.doesNotThrow(() => validateModelSelection(models, 'auto', true));
});
