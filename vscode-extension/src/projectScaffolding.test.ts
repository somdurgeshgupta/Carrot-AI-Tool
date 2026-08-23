import assert from 'node:assert/strict';
import test from 'node:test';
import { angularCliArguments, angularCliInvocation, angularProjectOptions } from './projectScaffolding';

test('builds a non-interactive Angular CLI scaffold command with safe defaults', () => {
  const options = angularProjectOptions({});
  assert.deepEqual(options, { name: 'angular-app', routing: true, style: 'scss', standalone: true, skipGit: true });
  assert.deepEqual(angularCliArguments(options), [
    '@angular/cli@v21-lts', 'new', 'angular-app', '--defaults', '--routing', '--style=scss',
    '--standalone', '--skip-git', '--package-manager=npm',
  ]);
});

test('invokes the npx JavaScript entrypoint on Windows without spawning a cmd shim', () => {
  const options = angularProjectOptions({ name: 'shopping-app' });
  const invocation = angularCliInvocation(
    options,
    'win32',
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js',
  );
  assert.equal(invocation.executable, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(invocation.args[0], 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js');
  assert.deepEqual(invocation.args.slice(1), angularCliArguments(options));
});

test('uses npx directly on non-Windows platforms', () => {
  const options = angularProjectOptions({ name: 'shopping-app' });
  assert.deepEqual(angularCliInvocation(options, 'linux', '/usr/bin/node'), {
    executable: 'npx',
    args: angularCliArguments(options),
  });
});

test('rejects paths, shell syntax, and invalid Angular project options', () => {
  for (const name of ['../app', 'My App', 'app&&whoami', '-app', 'app--one']) {
    assert.throws(() => angularProjectOptions({ name }));
  }
  assert.throws(() => angularProjectOptions({ name: 'app', style: 'stylus' }));
  assert.throws(() => angularProjectOptions({ name: 'app', routing: 'yes' }));
});
