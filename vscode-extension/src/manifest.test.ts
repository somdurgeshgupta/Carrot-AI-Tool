import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

test('manifest contributes and activates the dedicated Carrot Activity Bar Webview', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
  const container = manifest.contributes.viewsContainers.activitybar.find((item: any) => item.id === 'carrot');
  const view = manifest.contributes.views.carrot.find((item: any) => item.id === 'carrot.sidebar');
  assert.deepEqual(container, { id: 'carrot', title: 'Carrot AI', icon: 'resources/carrot.svg' });
  assert.equal(view.type, 'webview');
  assert.ok(manifest.activationEvents.includes('onView:carrot.sidebar'));
  assert.ok(manifest.contributes.commands.some((item: any) => item.command === 'carrot.open'));
  assert.ok(manifest.contributes.commands.some((item: any) => item.command === 'carrot.testAgentTools'));
  assert.deepEqual(manifest.contributes.menus, {});
  assert.ok(manifest.contributes.commands.every((item: any) => typeof item.shortTitle === 'string'));
});
