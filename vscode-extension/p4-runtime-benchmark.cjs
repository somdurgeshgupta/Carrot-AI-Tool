const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { AgentLoop } = require('./out/agentLoop');
const { ToolRegistry, OperationRisk } = require('./out/toolRegistry');
const { WorkspaceGuard, isSensitiveFile } = require('./out/workspacePolicy');
const { searchTerms, rankFilePaths, selectDiverseMatches, matchingTerms } = require('./out/searchSemantics');

const exec = promisify(execFile);
const root = path.resolve(__dirname, '..');
const guard = new WorkspaceGuard([root]);
const modelId = process.argv[2];
const editMode = process.argv.includes('--edit');
const prompt = editMode
  ? 'Find and fix one small user-visible text encoding issue in the VS Code extension. Inspect relevant files, propose the exact change, use the edit tool so its diff can be reviewed and approved, then check diagnostics and run the smallest relevant test. Modify only the approved file and report the final result.'
  : 'Explain how authentication works in this project. Inspect the actual workspace and reference the files you used.';
if (!modelId) throw new Error('model id required');

async function files() {
  const { stdout } = await exec('rg', ['--files', '-g', '!node_modules', '-g', '!dist', '-g', '!coverage', '-g', '!.git', '-g', '!.env*'], { cwd: root, maxBuffer: 2_000_000 });
  return stdout.split(/\r?\n/).filter(Boolean).filter(file => !isSensitiveFile(file));
}

function tool(registry, name, execute) {
  registry.register({ name, description: name, inputSchema: {}, risk: OperationRisk.READ_ONLY, requiresApproval: false, validate: () => {}, execute });
}

async function main() {
  const email = `p4-loop-${Date.now()}@local.test`;
  const authResponse = await fetch('http://127.0.0.1:3000/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'P4Audit-Local-Only-2026' }) });
  if (!authResponse.ok) throw new Error(`auth ${authResponse.status}`);
  const token = (await authResponse.json()).accessToken;
  const registry = new ToolRegistry();
  const approvals = [];
  const previews = [];
  const changedFiles = [];
  tool(registry, 'get_project_info', async () => ({ workspace: 'Carrot AI', projects: [
    { path: 'backend', framework: 'NestJS', manifest: 'backend/package.json' },
    { path: 'frontend', framework: 'Angular', manifest: 'frontend/package.json' },
    { path: 'vscode-extension', framework: 'VS Code Extension', manifest: 'vscode-extension/package.json' },
  ] }));
  tool(registry, 'get_workspace_tree', async args => { const all = await files(); const limit = Number(args.limit) || 250; return { entries: all.slice(0, limit).map(file => ({ path: file })), count: Math.min(all.length, limit), truncated: all.length > limit }; });
  tool(registry, 'search_files', async args => { const terms = searchTerms(args); const all = await files(); const ranked = rankFilePaths(all, terms, Number(args.limit) || 30); return { terms, files: ranked, count: ranked.length }; });
  tool(registry, 'search_workspace', async args => {
    const terms = searchTerms(args); const all = (await files()).filter(file => /\.(ts|js|html|css|json|md)$/.test(file)); const candidates = [];
    for (const file of all.slice(0, 2_000)) {
      const full = await guard.resolveRelativePath(file); const stat = await fs.stat(full); if (stat.size > 100_000) continue;
      const lines = (await fs.readFile(full, 'utf8')).split(/\r?\n/);
      let fileMatches = 0;
      for (let index = 0; index < lines.length && candidates.length < 2_000 && fileMatches < 5; index++) { const found = matchingTerms(lines[index], terms); if (found.length) { candidates.push({ path: file, line: index + 1, snippet: lines[index].trim().slice(0, 240), matchedTerms: found }); fileMatches++; } }
    }
    const matches = selectDiverseMatches(candidates, terms, Number(args.limit) || 30); return { terms, matches, count: matches.length, truncated: candidates.length > matches.length };
  });
  for (const name of ['read_file', 'read_file_range']) tool(registry, name, async args => {
    const relative = String(args.path || ''); if (isSensitiveFile(relative)) throw new Error('Sensitive files are excluded.');
    const full = await guard.resolveRelativePath(relative); const content = await fs.readFile(full, 'utf8');
    if (name === 'read_file') return { path: relative, content: content.slice(0, 20_000), truncated: content.length > 20_000 };
    const lines = content.split(/\r?\n/); const start = Math.max(1, Number(args.startLine) || 1); const requested = Math.max(start, Number(args.endLine) || start + 199); const end = Math.min(requested, start + 299, lines.length);
    const excerpt = lines.slice(start - 1, end).join('\n');
    return { path: relative, startLine: start, endLine: end, content: excerpt.slice(0, 6_000), truncated: requested > end || excerpt.length > 6_000 };
  });
  tool(registry, 'get_git_status', async () => { const { stdout } = await exec('git', ['status', '--short'], { cwd: root }); return { files: stdout.split(/\r?\n/).filter(Boolean) }; });
  tool(registry, 'get_diagnostics', async () => ({ diagnostics: [], count: 0, note: 'Compilation diagnostics are checked separately by production builds.' }));
  if (editMode) {
    const edit = async args => {
      const edits = Array.isArray(args.edits) ? args.edits : [args];
      if (edits.length !== 1) throw new Error('Benchmark permits exactly one file edit.');
      const item = edits[0]; const relative = String(item.path || '');
      if (!relative.startsWith('vscode-extension/') || isSensitiveFile(relative)) throw new Error('Benchmark edit is restricted to one non-sensitive VS Code extension file.');
      const full = await guard.resolveRelativePath(relative); const before = await fs.readFile(full, 'utf8');
      const oldText = String(item.oldText || ''); const newText = String(item.newText ?? '');
      const first = before.indexOf(oldText); if (!oldText || first < 0 || before.indexOf(oldText, first + oldText.length) >= 0) throw new Error('oldText must match exactly once.');
      const after = before.slice(0, first) + newText + before.slice(first + oldText.length);
      const preview = { path: relative, before: oldText, after: newText }; previews.push(preview);
      const approved = await benchmarkContext.approve({ name: 'apply_workspace_edit', risk: OperationRisk.NORMAL_WRITE }, `Apply reviewed diff to ${relative}?`);
      if (!approved) throw new Error('Final diff approval rejected.');
      await fs.writeFile(full, after, 'utf8'); changedFiles.push(relative); return { changedFiles: [{ path: relative, status: 'M' }], preview };
    };
    for (const name of ['apply_workspace_edit', 'edit_file']) registry.register({
      name, description: name === 'edit_file' ? 'Preview and apply one exact replacement. Arguments: path, oldText, newText.' : 'Preview and apply exact replacements. Arguments: edits array with path, oldText, newText.',
      inputSchema: name === 'edit_file'
        ? { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['path', 'oldText', 'newText'], additionalProperties: false }
        : {
          type: 'object',
          properties: { edits: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['path', 'oldText', 'newText'] } } },
          required: ['edits'], additionalProperties: false,
        },
      risk: OperationRisk.NORMAL_WRITE, requiresApproval: true, validate: () => {}, execute: edit,
    });
    registry.register({
      name: 'run_command', description: 'Run one allowlisted validation command in a guarded workspace-relative directory. Arguments: command, cwd.', inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'], additionalProperties: false }, risk: OperationRisk.NORMAL_WRITE, requiresApproval: true,
      validate: args => require('./out/commandPolicy').validateAgentCommand(String(args.command || '')),
      execute: async args => { const parts = require('./out/commandPolicy').parseAgentCommand(String(args.command)); const cwd = args.cwd ? await guard.resolveRelativePath(String(args.cwd)) : root; const { stdout, stderr } = await exec(parts[0], parts.slice(1), { cwd, timeout: 180_000, maxBuffer: 200_000 }); return { exitCode: 0, output: `${stdout}\n${stderr}`.slice(-20_000) }; },
    });
  }

  const debug = [];
  const benchmarkContext = { signal: new AbortController().signal, approve: async (definition, summary) => { approvals.push({ tool: definition.name, summary }); return true; } };
  const loop = new AgentLoop({ registry, modelId, localOnly: true, requiresWorkspaceEvidence: true, maxIterations: 14, maxDurationMs: 480_000,
    context: benchmarkContext, onDebug: line => debug.push(line),
    turn: async (systemPrompt, messages) => {
      const response = await fetch('http://127.0.0.1:3000/api/agent/turn', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ modelId, localOnly: true, systemPrompt, messages }), signal: AbortSignal.timeout(300_000) });
      const body = await response.json(); if (!response.ok) throw new Error(body.message || `agent ${response.status}`); return body.choices?.[0]?.message?.content;
    },
  });
  const started = Date.now();
  try {
    const result = await loop.run(prompt);
    const diffs = [];
    for (const file of changedFiles) { const { stdout } = await exec('git', ['diff', '--', file], { cwd: root, maxBuffer: 100_000 }); diffs.push({ file, diff: stdout }); }
    process.stdout.write(JSON.stringify({ modelId, mode: editMode ? 'edit' : 'read', passed: true, elapsedMs: Date.now() - started, metrics: result.metrics, tools: result.toolResults.map(item => item.tool), approvals, previews, changedFiles, diffs, final: result.final, debug }, null, 2));
  } catch (error) {
    process.stdout.write(JSON.stringify({ modelId, passed: false, elapsedMs: Date.now() - started, error: error.message, debug }, null, 2));
    process.exitCode = 2;
  }
}

main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
