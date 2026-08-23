import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentCommand, parseValidatedCommand, validateAgentCommand } from './commandPolicy';

test('allows only bounded development validation commands', () => {
  for (const command of ['npm test', 'npm run build', 'npm run lint', 'npx tsc --noEmit']) {
    assert.doesNotThrow(() => validateAgentCommand(command));
  }
  assert.deepEqual(parseAgentCommand('npm run build', 'win32'), ['npm.cmd', 'run', 'build']);
  assert.doesNotThrow(() => validateAgentCommand('pnpm run build:backend'));
  assert.doesNotThrow(() => validateAgentCommand('yarn test:unit -- --watch=false'));
  assert.equal(parseValidatedCommand('npm run start:backend').risk, 'normal-write');
});

test('rejects destructive, deploy, migration, and shell-composed commands', () => {
  for (const command of ['rm -rf .', 'git reset --hard', 'npm run deploy', 'npm run migrate', 'npm test && del file']) {
    assert.throws(() => validateAgentCommand(command));
  }
});
