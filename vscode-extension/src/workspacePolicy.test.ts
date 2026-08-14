import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isSensitiveFile, WorkspaceGuard } from './workspacePolicy';

test('workspace guard allows relative paths inside an opened root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'carrot-workspace-'));
  const guard = new WorkspaceGuard([root]);
  assert.equal(await guard.resolveRelativePath('src/app.ts'), path.join(await fs.realpath(root), 'src', 'app.ts'));
});

test('workspace guard accepts Windows-style project folder names containing spaces', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'carrot-parent-'));
  const root = path.join(parent, 'Carrot AI');
  await fs.mkdir(root);
  const guard = new WorkspaceGuard([root]);
  assert.equal(await guard.resolveRelativePath('backend/src/auth/auth.service.ts'), path.join(await fs.realpath(root), 'backend', 'src', 'auth', 'auth.service.ts'));
});

test('workspace guard blocks traversal and unrelated absolute paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'carrot-workspace-'));
  const guard = new WorkspaceGuard([root]);
  await assert.rejects(() => guard.resolveRelativePath('../../secret.txt'), /outside/);
  await assert.rejects(() => guard.resolveRelativePath(path.resolve(root, '..', 'other.txt')), /relative/);
});

test('workspace guard supports only explicitly configured multi-root folders', async () => {
  const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'carrot-root-a-'));
  const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'carrot-root-b-'));
  const guard = new WorkspaceGuard([rootA, rootB]);
  assert.equal(await guard.resolveRelativePath('file.ts', 1), path.join(await fs.realpath(rootB), 'file.ts'));
  await assert.rejects(() => guard.resolveRelativePath('file.ts', 2), /unavailable/);
});

test('workspace guard blocks symlinks that resolve outside the opened root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'carrot-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'carrot-outside-'));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside workspace');
  await fs.symlink(outside, path.join(root, 'linked-outside'), 'junction');

  const guard = new WorkspaceGuard([root]);
  await assert.rejects(() => guard.resolveRelativePath('linked-outside/secret.txt'), /outside/);
});

test('sensitive file policy detects credential material', () => {
  for (const name of ['.env', '.env.production', 'private.key', 'server.pem', 'id_rsa', 'id_ed25519', 'credentials.json', 'secrets.yaml']) {
    assert.equal(isSensitiveFile(name), true, name);
  }
  assert.equal(isSensitiveFile('src/app.ts'), false);
});
