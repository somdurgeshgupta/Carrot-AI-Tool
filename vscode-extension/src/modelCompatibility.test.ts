import assert from 'node:assert/strict';
import test from 'node:test';
import { completedCompatibility, failedCompatibility, withCompatibility } from './modelCompatibility';

test('records passed, degraded, and failed agent compatibility without selecting another model', () => {
  const passed = completedCompatibility({ turns: 4, modelDurationMs: 10_000, toolDurationMs: 50, cacheHits: 0, correctiveRetries: 0, peakContextCharacters: 2_000 });
  const degraded = completedCompatibility({ turns: 6, modelDurationMs: 20_000, toolDurationMs: 50, cacheHits: 1, correctiveRetries: 1, peakContextCharacters: 4_000 });
  assert.equal(passed.status, 'passed');
  assert.equal(degraded.status, 'degraded');
  assert.equal(failedCompatibility(new Error('bad protocol')).status, 'failed');
  assert.deepEqual(Object.keys(withCompatibility(undefined, 'local:model', passed)), ['local:model']);
});
