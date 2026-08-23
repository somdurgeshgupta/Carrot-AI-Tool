import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverDocumentationTargets, discoverWorkspaceDocumentationTargets, DocumentationResourceStore, requestsDocumentationRefresh } from './documentationResources';

test('detects supported frameworks and their project versions', () => {
  const targets = discoverDocumentationTargets([
    { dependencies: { '@angular/core': '^21.2.1', next: '^17.0.0', lodash: '4.0.0' }, devDependencies: { typescript: '~5.9.2' } },
    { packages: { 'node_modules/next': { version: '17.0.3' } } },
  ]);
  assert.deepEqual(targets.map(item => [item.framework, item.version, item.major]), [['Next.js', '17.0.3', 17], ['Angular', '^21.2.1', 21], ['TypeScript', '~5.9.2', 5]]);
});

test('distinguishes current workspace language from an explicit documentation refresh', () => {
  assert.equal(requestsDocumentationRefresh('Explain the current file'), false);
  assert.equal(requestsDocumentationRefresh('Fetch the latest Angular documentation'), true);
  assert.equal(requestsDocumentationRefresh('Refresh docs for this project'), true);
});

test('detects versions across Java, Python, Go, Rust, .NET, PHP, Ruby, and Dart projects', () => {
  const targets = discoverWorkspaceDocumentationTargets([
    { path: 'pom.xml', content: '<properties><java.version>21</java.version></properties>' },
    { path: 'pyproject.toml', content: 'requires-python = ">=3.12"' },
    { path: 'go.mod', content: 'module example.test\ngo 1.24\n' },
    { path: 'Cargo.toml', content: 'rust-version = "1.85"' },
    { path: 'App.csproj', content: '<TargetFramework>net9.0</TargetFramework>' },
    { path: 'composer.json', content: '{"require":{"php":"^8.4"}}' },
    { path: 'Gemfile', content: 'ruby "3.4.1"' },
    { path: 'pubspec.yaml', content: 'environment:\n  sdk: ">=3.7.0"' },
  ]);
  assert.deepEqual(targets.map(item => [item.framework, item.major]), [
    ['Java', 21], ['Python', 3], ['Go', 1], ['Rust', 1], ['.NET', 9], ['PHP', 8], ['Ruby', 3], ['Dart', 3],
  ]);
});

test('reuses cached versioned docs and replaces them after an explicit refresh', async () => {
  let state: Record<string, any> = {}; let fetches = 0;
  const store = new DocumentationResourceStore({ get: () => state, update: async value => { state = value; } }, async url => ({ url, text: `Angular component signals reference ${++fetches}` }));
  const manifests = [{ dependencies: { '@angular/core': '^21.2.1' } }];
  assert.equal((await store.contextFor(manifests, 'Explain this Angular component')).refreshed, 1);
  const reused = await store.contextFor(manifests, 'Explain this Angular component');
  assert.equal(reused.reused, 1); assert.match(reused.context, /reference 1/);
  const refreshed = await store.contextFor(manifests, 'Fetch current documentation for Angular');
  assert.equal(refreshed.refreshed, 1); assert.match(refreshed.context, /reference 2/);
});

test('keeps the last verified snapshot when a refresh fails', async () => {
  let state: Record<string, any> = {}; let fail = false;
  const store = new DocumentationResourceStore({ get: () => state, update: async value => { state = value; } }, async url => { if (fail) throw new Error('offline'); return { url, text: 'verified Angular docs' }; });
  const manifests = [{ dependencies: { '@angular/core': '21.0.0' } }];
  await store.contextFor(manifests, 'Angular help'); fail = true;
  const result = await store.contextFor(manifests, 'Refresh current docs');
  assert.match(result.context, /verified Angular docs/); assert.deepEqual(result.unavailable, []);
});
