import assert from 'node:assert/strict';
import test from 'node:test';
import { matchingTerms, rankFilePaths, searchTerms, selectDiverseMatches } from './searchSemantics';

const fixturePaths = [
  'backend/src/auth/auth.service.ts',
  'backend/src/auth/auth.controller.ts',
  'backend/src/auth/jwt.guard.ts',
  'frontend/src/login/login.component.ts',
  'vscode-extension/src/auth.ts',
  'node_modules/package/index.js',
];

test('multi-term natural language finds authentication fixture files', () => {
  const terms = searchTerms({ query: 'authentication, JWT, login, guards, session ownership and VS Code SecretStorage' });
  const matches = rankFilePaths(fixturePaths.filter(path => !path.startsWith('node_modules/')), terms, 20);
  assert.ok(matches.some(match => match.path === 'backend/src/auth/auth.service.ts'));
  assert.ok(matches.some(match => match.path === 'backend/src/auth/jwt.guard.ts'));
  assert.ok(matches.some(match => match.path === 'frontend/src/login/login.component.ts'));
  assert.equal(matches.some(match => match.path.startsWith('node_modules/')), false);
});

test('structured query arrays and content terms match JWT and SecretStorage independently', () => {
  const terms = searchTerms({ queries: ['JWT', 'SecretStorage'] });
  assert.deepEqual(matchingTerms('export class JwtAuthGuard {}', terms), ['jwt']);
  assert.ok(matchingTerms('context.secrets uses VS Code SecretStorage', terms).includes('secretstorage'));
});

test('Windows-style workspace names containing spaces do not alter relative matching', () => {
  const paths = ['F:\\Carrot AI\\backend\\src\\auth\\auth.service.ts'];
  assert.equal(rankFilePaths(paths, searchTerms({ query: 'auth' }), 10).length, 1);
});

test('multi-term content results retain coverage for later query terms', () => {
  const matches = [
    ...Array.from({ length: 20 }, () => ({ matchedTerms: ['auth'], value: 'auth' })),
    { matchedTerms: ['jwt'], value: 'jwt' },
    { matchedTerms: ['secretstorage'], value: 'secret' },
  ];
  const selected = selectDiverseMatches(matches, ['auth', 'jwt', 'secretstorage'], 3);
  assert.deepEqual(selected.map(match => match.value), ['auth', 'jwt', 'secret']);
});
