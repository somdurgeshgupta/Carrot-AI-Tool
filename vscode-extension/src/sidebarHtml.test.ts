import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getSidebarHtml } from './sidebarHtml';

const resources = { scriptUri: 'webview://sidebar.js', styleUri: 'webview://sidebar.css' };

test('generates the dedicated Carrot view with a restrictive nonce CSP', () => {
  const html = getSidebarHtml('fixed-nonce', 'vscode-webview:', resources);
  assert.match(html, /Carrot AI/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /script-src 'nonce-fixed-nonce'/);
  assert.doesNotMatch(html, /unsafe-eval|unsafe-inline/);
});

test('does not embed credentials or backend/provider secrets in Webview HTML', () => {
  const html = getSidebarHtml('nonce', 'vscode-webview:', resources);
  const script = fs.readFileSync(path.resolve(__dirname, '..', 'media', 'sidebar.js'), 'utf8');
  for (const forbidden of ['accessToken', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'SecretStorage', 'localhost:3000']) {
    assert.equal(html.includes(forbidden), false);
    assert.equal(script.includes(forbidden), false);
  }
});

test('escapes untrusted model output before the constrained Markdown transform', () => {
  const script = fs.readFileSync(path.resolve(__dirname, '..', 'media', 'sidebar.js'), 'utf8');
  assert.match(script, /replaceAll\('&', '&amp;'\)/);
  assert.match(script, /replaceAll\('<', '&lt;'\)/);
  assert.match(script, /holder\.innerHTML = safe/);
});

test('uses a conversation-first flexible layout and compact composer', () => {
  const html = getSidebarHtml('nonce', 'vscode-webview:', resources);
  const css = fs.readFileSync(path.resolve(__dirname, '..', 'media', 'sidebar.css'), 'utf8');
  assert.match(css, /\.main-view\s*\{[^}]*flex:\s*1 1 auto/);
  assert.match(css, /\.conversation\s*\{[^}]*height:\s*100%/);
  assert.match(css, /\.composer-area\s*\{[^}]*flex:\s*0 0 auto/);
  assert.match(css, /max-height:\s*140px/);
  assert.match(html, /id="workingState"/);
  assert.match(html, /id="webSearchToggle"/);
  assert.match(html, /id="localOnlyToggle"[^>]*role="switch"[^>]*aria-checked="true"/);
  assert.match(html, /Local Models Only/);
  assert.match(html, /ON uses only local models\. OFF allows available cloud models too\./);
  assert.match(html, /id="askMode"/);
  assert.match(html, /id="agentMode"/);
  assert.match(html, /Add current file/);
  assert.match(css, /var\(--vscode-/);
});

test('collapses successful activity while retaining explicit error rendering', () => {
  const script = fs.readFileSync(path.resolve(__dirname, '..', 'media', 'sidebar.js'), 'utf8');
  assert.match(script, /agentActivity\.hidden=true/);
  assert.match(script, /errorBanner\.hidden=false/);
  assert.doesNotMatch(script, /chain.of.thought|reasoning tokens/i);
});

test('dismisses menus outside and provides prompt copy/edit/resend actions', () => {
  const script = fs.readFileSync(path.resolve(__dirname, '..', 'media', 'sidebar.js'), 'utf8');
  assert.match(script, /document\.addEventListener\('pointerdown'/);
  assert.match(script, /Copy prompt/);
  assert.match(script, /Edit prompt/);
  assert.match(script, /Resend prompt/);
  assert.match(script, /el\.prompt\.value=content/);
});
