import assert from 'node:assert/strict';
import test from 'node:test';
import { commandForAction, detectProjectCommands } from './projectCommands';

test('discovers npm scripts and Angular, NestJS, and Nx project markers', () => {
  const result = detectProjectCommands({ scripts: {
    'build:backend': 'nx build backend',
    'test:backend': 'jest',
    lint: 'nx run-many -t lint',
    start: 'nest start',
  }, devDependencies: { nx: '1', '@angular/core': '1', '@nestjs/core': '1', typescript: '1' } }, ['package-lock.json', 'angular.json', 'nest-cli.json', 'nx.json', 'tsconfig.json']);
  assert.equal(result.packageManager, 'npm');
  assert.deepEqual(result.frameworks, ['Nx', 'Angular', 'NestJS']);
  assert.equal(commandForAction(result, 'build', 'backend')?.command, 'npm run build:backend');
  assert.equal(commandForAction(result, 'typecheck')?.command, 'npx tsc --noEmit');
});

test('honors declared pnpm and detected yarn package managers', () => {
  assert.equal(detectProjectCommands({ packageManager: 'pnpm@10.0.0', scripts: { build: 'ng build' } }, ['yarn.lock']).commands[0].command, 'pnpm build');
  assert.equal(detectProjectCommands({ scripts: { test: 'vitest' } }, ['yarn.lock']).commands[0].command, 'yarn test');
});

test('does not expose unrelated or arbitrary package scripts', () => {
  const result = detectProjectCommands({ scripts: { deploy: 'publish-production', cleanup: 'rm -rf .', dev: 'ng serve' } }, ['package.json']);
  assert.deepEqual(result.commands.map(item => item.command), ['npm run dev']);
});
