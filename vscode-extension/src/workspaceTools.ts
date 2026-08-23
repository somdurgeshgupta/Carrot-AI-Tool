import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { isSensitiveFile, WorkspaceGuard } from './workspacePolicy';
import { OperationRisk, RegisteredTool, schemas, requireString, optionalNumber, ToolDebugEvent, ToolRegistry } from './toolRegistry';
import { parseAgentCommand, validateAgentCommand } from './commandPolicy';
import { matchingTerms, rankFilePaths, searchTerms, selectDiverseMatches } from './searchSemantics';
import { registerWebSearchTool } from './webSearchTool';
import { detectProjectCommands } from './projectCommands';
import { executeBounded, startDetached } from './safeExecution';
import { checkPort, findProcess, killPort, terminateProcess } from './processTools';
import { commandForAction, ProjectAction } from './projectCommands';
import { checkHealth, HealthTarget } from './healthTools';

const execFileAsync = promisify(execFile);
const EXCLUDE = '{**/node_modules/**,**/dist/**,**/build/**,**/coverage/**,**/.git/**,**/.angular/**,**/.next/**,**/.cache/**}';
const MAX_FILE_BYTES = 100_000;
const MAX_FULL_READ_CHARACTERS = 20_000;
const MAX_RANGE_LINES = 300;
const MAX_RANGE_CHARACTERS = 6_000;
const MAX_SEARCH_FILES = 2_000;

export function createWorkspaceToolRegistry(
  debug?: (event: ToolDebugEvent) => void,
  webSearch?: (query: string, signal: AbortSignal) => Promise<unknown>,
  webFetch?: (url: string, signal: AbortSignal) => Promise<unknown>,
  commandMemory?: { get(): readonly RememberedCommand[]; set(commands: readonly RememberedCommand[]): PromiseLike<void> },
): ToolRegistry {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const guard = new WorkspaceGuard(folders.map(folder => folder.uri.fsPath));
  const registry = new ToolRegistry(debug);

  registry.register(tool('get_project_info', 'Inspect project metadata, scripts, dependencies, frameworks, and Git presence.', OperationRisk.READ_ONLY,
    schemas.object({}), false, () => {}, async () => {
      if (!folders.length) throw new Error('No workspace is open.');
      const projects = [];
      for (let rootIndex = 0; rootIndex < folders.length; rootIndex++) {
        const root = folders[rootIndex];
        const packageJson = await readJsonIfPresent(guard, 'package.json', rootIndex);
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '{package.json,nx.json,angular.json,nest-cli.json,tsconfig.json,pnpm-lock.yaml,yarn.lock,package-lock.json}'), EXCLUDE, 20);
        const names = new Set(files.map(uri => path.basename(uri.fsPath)));
        const discovery = detectProjectCommands(packageJson, names);
        let gitRepository = false;
        try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(root.uri, '.git')); gitRepository = true; } catch {}
        projects.push({
          root: root.name,
          rootIndex,
          languages: inferLanguages(await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*.{ts,tsx,js,jsx,html,css,scss,json,py,go,java}'), EXCLUDE, 300)),
          packageManager: discovery.packageManager,
          frameworks: discovery.frameworks,
          scripts: packageJson?.scripts ?? {},
          commands: discovery.commands,
          dependencies: Object.keys({ ...(packageJson?.dependencies ?? {}), ...(packageJson?.devDependencies ?? {}) }).slice(0, 100),
          gitRepository,
        });
      }
      return { workspace: vscode.workspace.name, roots: folders.map((folder, rootIndex) => ({ root: folder.name, rootIndex })), projects };
    }));

  registry.register(tool('detect_project_commands', 'Detect safe build, test, lint, typecheck, and start commands from project manifests and framework markers.', OperationRisk.READ_ONLY,
    schemas.object({ rootIndex: schemas.number, cwd: schemas.string }), false,
    args => { optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1)); if (args.cwd !== undefined) requireString(args, 'cwd', 1_000); },
    async args => {
      const rootIndex = optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1));
      const root = folders[rootIndex];
      if (!root) throw new Error('No workspace is open.');
      const cwd = args.cwd === undefined ? root.uri.fsPath : await guard.resolveRelativePath(requireString(args, 'cwd', 1_000), rootIndex);
      const cwdUri = vscode.Uri.file(cwd);
      const packageJson = await readJsonUriIfPresent(vscode.Uri.joinPath(cwdUri, 'package.json'));
      const markers = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'nx.json', 'angular.json', 'nest-cli.json', 'tsconfig.json'];
      const present: string[] = [];
      for (const marker of markers) {
        try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(cwdUri, marker)); present.push(marker); } catch {}
      }
      return { root: root.name, rootIndex, cwd: args.cwd ?? '.', ...detectProjectCommands(packageJson, present) };
    }));

  if (commandMemory) registry.register(tool('get_remembered_project_commands', 'Return previously successful project lifecycle commands for this workspace.', OperationRisk.READ_ONLY,
    schemas.object({}), false, () => {}, async () => ({ commands: commandMemory.get().slice(0, 20) })));

  registry.register(tool('get_workspace_tree', 'List a bounded, workspace-relative project tree.', OperationRisk.READ_ONLY,
    schemas.object({ depth: schemas.number, limit: schemas.number }), false,
    args => { optionalNumber(args, 'depth', 4, 1, 10); optionalNumber(args, 'limit', 300, 1, 1_000); },
    async args => {
      const depth = optionalNumber(args, 'depth', 4, 1, 10);
      const limit = optionalNumber(args, 'limit', 300, 1, 1_000);
      const results: Array<{ root: string; rootIndex: number; path: string }> = [];
      for (let rootIndex = 0; rootIndex < folders.length && results.length < limit; rootIndex++) {
        const root = folders[rootIndex];
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*'), EXCLUDE, Math.min(limit * 4, 4_000));
        for (const uri of files) {
          const relative = relativeToRoot(root, uri);
          if (isSensitiveFile(relative)) continue;
          if (relative.split('/').length <= depth) results.push({ root: root.name, rootIndex, path: relative });
          if (results.length >= limit) break;
        }
      }
      return { roots: folders.map((folder, rootIndex) => ({ root: folder.name, rootIndex })), entries: results, count: results.length, truncated: results.length >= limit };
    }));

  registry.register(tool('search_files', 'Find filenames by a case-insensitive name fragment.', OperationRisk.READ_ONLY,
    schemas.object({ query: schemas.string, queries: { type: 'array', items: schemas.string }, limit: schemas.number }), false,
    args => { requireSearchTerms(args); optionalNumber(args, 'limit', 30, 1, 100); },
    async args => {
      const terms = requireSearchTerms(args);
      const limit = optionalNumber(args, 'limit', 30, 1, 100);
      const candidates: Array<{ root: string; rootIndex: number; path: string }> = [];
      for (let rootIndex = 0; rootIndex < folders.length; rootIndex++) {
        const root = folders[rootIndex];
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*'), EXCLUDE, MAX_SEARCH_FILES);
        candidates.push(...files.map(uri => ({ root: root.name, rootIndex, path: relativeToRoot(root, uri) }))
          .filter(item => !isSensitiveFile(item.path)));
      }
      const ranked = rankFilePaths(candidates.map(item => item.path), terms, Math.max(limit * 4, limit));
      const results = ranked.map(match => {
        const owner = candidates.find(item => item.path === match.path)!;
        return { ...owner, matchedTerms: match.terms };
      }).slice(0, limit);
      return { terms, files: results, count: results.length, truncated: results.length >= limit };
    }));

  registry.register(tool('search_workspace', 'Search project text and return compact path, line, and snippet matches.', OperationRisk.READ_ONLY,
    schemas.object({ query: schemas.string, queries: { type: 'array', items: schemas.string }, limit: schemas.number }), false,
    args => { requireSearchTerms(args); optionalNumber(args, 'limit', 30, 1, 100); },
    async (args, context) => {
      const terms = requireSearchTerms(args);
      const limit = optionalNumber(args, 'limit', 30, 1, 100);
      const candidates: Array<{ root: string; rootIndex: number; path: string; line: number; snippet: string; matchedTerms: string[] }> = [];
      const candidateLimit = Math.min(2_000, Math.max(limit * 30, limit));
      for (let rootIndex = 0; rootIndex < folders.length; rootIndex++) {
        const root = folders[rootIndex];
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*.{ts,tsx,js,jsx,html,css,scss,json,md,py,go,java,yaml,yml}'), EXCLUDE, MAX_SEARCH_FILES);
        for (const uri of files) {
          if (context.signal.aborted) throw new Error('Agent task was cancelled.');
          const relative = relativeToRoot(root, uri);
          if (isSensitiveFile(relative)) continue;
          let resolved: string;
          try {
            resolved = await guard.resolveRelativePath(relative, rootIndex);
          } catch {
            continue;
          }
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(resolved));
          if (bytes.byteLength > MAX_FILE_BYTES) continue;
          const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
          let fileMatches = 0;
          for (let index = 0; index < lines.length && candidates.length < candidateLimit && fileMatches < 5; index++) {
            const found = matchingTerms(lines[index], terms);
            if (found.length) { candidates.push({ root: root.name, rootIndex, path: relative, line: index + 1, snippet: lines[index].trim().slice(0, 300), matchedTerms: found }); fileMatches++; }
          }
        }
      }
      const matches = selectDiverseMatches(candidates, terms, limit);
      return { terms, matches, count: matches.length, truncated: candidates.length > matches.length };
    }));

  registry.register(readTool('read_file', false));
  registry.register(readTool('read_file_range', true));

  registry.register(tool('get_current_file', 'Return the active editor file path and language without absolute paths.', OperationRisk.READ_ONLY,
    schemas.object({}), false, () => {}, async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') return {};
      const owned = ownedPath(folders, editor.document.uri);
      if (!owned || isSensitiveFile(owned.path)) return {};
      return { ...owned, language: editor.document.languageId };
    }));

  registry.register(tool('get_selection', 'Return the current editor selection when it is inside a non-sensitive workspace file.', OperationRisk.READ_ONLY,
    schemas.object({}), false, () => {}, async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) return {};
      const owned = ownedPath(folders, editor.document.uri);
      if (!owned || isSensitiveFile(owned.path)) return {};
      return { ...owned, text: editor.document.getText(editor.selection).slice(0, 20_000) };
    }));

  registry.register(tool('get_diagnostics', 'Return bounded VS Code diagnostics for workspace files.', OperationRisk.READ_ONLY,
    schemas.object({ limit: schemas.number }), false,
    args => { optionalNumber(args, 'limit', 100, 1, 300); },
    async args => {
      const limit = optionalNumber(args, 'limit', 100, 1, 300);
      return vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) => {
        const owned = ownedPath(folders, uri);
        if (!owned || isSensitiveFile(owned.path)) return [];
        return diagnostics.map(item => ({
          ...owned,
          line: item.range.start.line + 1,
          severity: vscode.DiagnosticSeverity[item.severity],
          message: item.message.slice(0, 500),
          source: item.source,
        }));
      }).slice(0, limit);
    }));

  registry.register(tool('get_git_status', 'Return the current branch and bounded modified/untracked file status.', OperationRisk.READ_ONLY,
    schemas.object({ rootIndex: schemas.number }), false,
    args => { optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1)); },
    async (args, context) => {
      const rootIndex = optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1));
      const root = folders[rootIndex]?.uri.fsPath;
      if (!root) throw new Error('No workspace is open.');
      const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '--branch'], {
        cwd: root, timeout: 10_000, maxBuffer: 100_000, signal: context.signal,
      });
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      return { root: folders[rootIndex].name, rootIndex, branch: lines[0]?.replace(/^## /, '') ?? '', files: lines.slice(1, 201) };
    }));

  registry.register(tool('get_git_diff', 'Return a bounded Git diff while excluding every path blocked by the workspace secret policy.', OperationRisk.READ_ONLY,
    schemas.object({ rootIndex: schemas.number }), false, args => { optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1)); },
    async (args, context) => {
      const names = (await runGit(args, context, ['diff', '--name-only', '--', '.'])).output.split(/\r?\n/).filter(value => value && !isSensitiveFile(value)).slice(0, 200);
      return names.length ? runGit(args, context, ['diff', '--', ...names]) : { output: '' };
    }));
  registry.register(gitReadTool('get_git_log', 'Return the latest bounded Git commit summaries.', ['log', '-n', '20', '--pretty=format:%h%x09%ad%x09%s', '--date=short']));

  registry.register(tool('git_pull', 'Pull the current branch using fast-forward only.', OperationRisk.NORMAL_WRITE,
    schemas.object({ rootIndex: schemas.number }), true, args => { optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1)); },
    async (args, context) => runGit(args, context, ['pull', '--ff-only']), () => 'Pull the current branch with --ff-only?'));

  registry.register(tool('git_add', 'Stage explicitly listed non-sensitive workspace files.', OperationRisk.NORMAL_WRITE,
    schemas.object({ paths: { type: 'array', items: schemas.string }, rootIndex: schemas.number }, ['paths']), true,
    args => {
      if (!Array.isArray(args.paths) || args.paths.length < 1 || args.paths.length > 50) throw new Error('paths must contain 1 to 50 files.');
      for (const item of args.paths) { if (typeof item !== 'string') throw new Error('Invalid Git path.'); assertNotSensitive(item); }
      optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1));
    }, async (args, context) => {
      const rootIndex = optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1));
      for (const item of args.paths as string[]) await guard.resolveRelativePath(item, rootIndex);
      return runGit(args, context, ['add', '--', ...(args.paths as string[])]);
    }, args => `Stage ${(args.paths as string[]).join(', ')}?`));

  registry.register(tool('git_commit', 'Create a Git commit from already staged changes with a bounded message.', OperationRisk.NORMAL_WRITE,
    schemas.object({ message: schemas.string, rootIndex: schemas.number }, ['message']), true,
    args => { const message = requireString(args, 'message', 200); if (/[\r\n]/.test(message)) throw new Error('Commit message must be one line.'); optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1)); },
    async (args, context) => runGit(args, context, ['commit', '-m', requireString(args, 'message', 200)]), args => `Commit staged changes as "${args.message}"?`));

  registry.register(tool('check_port', 'Check whether a TCP port is free and return its listening process IDs.', OperationRisk.READ_ONLY,
    schemas.object({ port: schemas.number }), false, args => { optionalNumber(args, 'port', 0, 1, 65_535); },
    (args, context) => checkPort(optionalNumber(args, 'port', 0, 1, 65_535), context.signal)));

  registry.register(tool('find_process', 'Resolve a Windows process ID to its executable name.', OperationRisk.READ_ONLY,
    schemas.object({ pid: schemas.number }), false, args => { optionalNumber(args, 'pid', 0, 1, 2_147_483_647); },
    (args, context) => findProcess(optionalNumber(args, 'pid', 0, 1, 2_147_483_647), context.signal)));

  registry.register(tool('health_check', 'Check local backend, frontend, Ollama, Redis, or PostgreSQL availability without reading credentials.', OperationRisk.READ_ONLY,
    schemas.object({ target: schemas.string }, ['target']), false, args => { if (!['backend', 'frontend', 'ollama', 'redis', 'postgresql'].includes(requireString(args, 'target', 20))) throw new Error('Invalid health target.'); },
    (args, context) => checkHealth(requireString(args, 'target', 20) as HealthTarget, context.signal)));

  registry.register(tool('kill_port', 'Kill the verified process currently listening on a port, then verify the port is free.', OperationRisk.HIGH_RISK,
    schemas.object({ port: schemas.number, expectedPid: schemas.number }, ['port', 'expectedPid']), true,
    args => { optionalNumber(args, 'port', 0, 1, 65_535); optionalNumber(args, 'expectedPid', 0, 1, 2_147_483_647); },
    (args, context) => killPort(optionalNumber(args, 'port', 0, 1, 65_535), optionalNumber(args, 'expectedPid', 0, 1, 2_147_483_647), context.signal),
    args => `Kill verified PID ${args.expectedPid} on port ${args.port}, then verify the port is free?`));

  registerWebSearchTool(registry, webSearch, webFetch);

  const applyEditTool = writeTool();
  registry.register(applyEditTool);
  registry.register({
    ...applyEditTool,
    name: 'edit_file',
    description: 'Preview and apply one exact replacement in an existing workspace source file.',
    inputSchema: schemas.object({ path: schemas.string, rootIndex: schemas.number, oldText: schemas.string, newText: schemas.string }, ['path', 'oldText', 'newText']),
    validate: args => {
      requireString(args, 'path', 1_000);
      optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1));
      requireString(args, 'oldText', 200_000);
      requireString(args, 'newText', 200_000);
    },
    execute: (args, context) => applyEditTool.execute({ edits: [{ ...args, create: false }] }, context),
    summarize: args => `Review changes to ${args.path}`,
  });
  registry.register({
    ...applyEditTool,
    name: 'create_file',
    description: 'Preview and create one new workspace source file.',
    inputSchema: schemas.object({ path: schemas.string, rootIndex: schemas.number, newText: schemas.string }, ['path', 'newText']),
    validate: args => {
      requireString(args, 'path', 1_000);
      optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1));
      requireString(args, 'newText', 200_000);
    },
    execute: (args, context) => applyEditTool.execute({ edits: [{ ...args, create: true }] }, context),
    summarize: args => `Review new file ${args.path}`,
  });
  registry.register(commandTool());
  registry.register(projectActionTool());
  registry.register(projectStartTool(false));
  registry.register(projectStartTool(true));
  return registry;

  function readTool(name: string, ranged: boolean): RegisteredTool {
    return tool(name, ranged ? 'Read a bounded line range from a workspace file.' : 'Read a bounded workspace file.', OperationRisk.READ_ONLY,
      schemas.object({ path: schemas.string, rootIndex: schemas.number, startLine: schemas.number, endLine: schemas.number }, ['path']), false,
      args => {
        requireString(args, 'path', 1_000);
        optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1));
        if (ranged) {
          optionalNumber(args, 'startLine', 1, 1, 1_000_000);
          optionalNumber(args, 'endLine', 200, 1, 1_000_000);
        }
      },
      async args => {
        const relative = requireString(args, 'path', 1_000);
        const rootIndex = optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1));
        assertNotSensitive(relative);
        const resolved = await guard.resolveRelativePath(relative, rootIndex);
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(resolved));
        if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('File exceeds the agent read limit.');
        const content = new TextDecoder().decode(bytes);
        if (!ranged) {
          const truncated = content.length > MAX_FULL_READ_CHARACTERS;
          return {
            root: folders[rootIndex].name,
            rootIndex,
            path: relative,
            content: truncated ? content.slice(0, MAX_FULL_READ_CHARACTERS) : content,
            truncated,
            instruction: truncated ? 'Large file preview only. Use read_file_range for the relevant symbols or lines.' : undefined,
          };
        }
        const start = optionalNumber(args, 'startLine', 1, 1, 1_000_000);
        // Small local models occasionally reverse the range. Treat that as a
        // one-line read instead of spending another slow model turn repairing it.
        const requestedEnd = optionalNumber(args, 'endLine', Math.min(start + 199, 1_000_000), 1, 1_000_000);
        const end = Math.min(Math.max(start, requestedEnd), start + MAX_RANGE_LINES - 1);
        const excerpt = content.split(/\r?\n/).slice(start - 1, end).join('\n');
        return { root: folders[rootIndex].name, rootIndex, path: relative, startLine: start, endLine: end, content: excerpt.slice(0, MAX_RANGE_CHARACTERS), truncated: requestedEnd > end || excerpt.length > MAX_RANGE_CHARACTERS };
      });
  }

  function gitReadTool(name: string, description: string, gitArgs: string[]): RegisteredTool {
    return tool(name, description, OperationRisk.READ_ONLY, schemas.object({ rootIndex: schemas.number }), false,
      args => { optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1)); },
      async (args, context) => runGit(args, context, gitArgs));
  }

  async function runGit(args: Record<string, unknown>, context: { signal: AbortSignal }, gitArgs: string[]): Promise<{ output: string }> {
    const rootIndex = optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1));
    const root = folders[rootIndex]?.uri.fsPath; if (!root) throw new Error('No workspace is open.');
    const { stdout, stderr } = await execFileAsync('git', gitArgs, { cwd: root, timeout: 60_000, maxBuffer: 200_000, signal: context.signal });
    return { output: `${stdout}\n${stderr}`.trim().slice(-50_000) };
  }

  function writeTool(): RegisteredTool {
    return tool('apply_workspace_edit', 'Preview and apply bounded exact-replacement or create-file edits across workspace files.', OperationRisk.NORMAL_WRITE,
      schemas.object({ edits: { type: 'array' } }, ['edits']), true,
      args => {
        if (!Array.isArray(args.edits) || args.edits.length < 1 || args.edits.length > 10) throw new Error('edits must contain 1 to 10 changes.');
      },
      async (args, context) => {
        const edits = args.edits as Array<Record<string, unknown>>;
        const workspaceEdit = new vscode.WorkspaceEdit();
        const changed: Array<{ path: string; status: 'M' | 'A' }> = [];
        const previews: Array<{ before: vscode.Uri; after: vscode.Uri; title: string }> = [];
        for (const edit of edits) {
          const relative = requireString(edit, 'path', 1_000);
          const rootIndex = optionalNumber(edit, 'rootIndex', 0, 0, Math.max(0, folders.length - 1));
          assertNotSensitive(relative);
          const resolved = await guard.resolveRelativePath(relative, rootIndex);
          const uri = vscode.Uri.file(resolved);
          const create = edit.create === true;
          const newText = requireString(edit, 'newText', 200_000);
          if (create) {
            try { await vscode.workspace.fs.stat(uri); throw new Error(`File already exists: ${relative}`); } catch (error: any) {
              if (error?.code !== 'FileNotFound' && error?.code !== 'ENOENT') throw error;
            }
            workspaceEdit.createFile(uri, { ignoreIfExists: false });
            workspaceEdit.insert(uri, new vscode.Position(0, 0), newText);
            const before = await vscode.workspace.openTextDocument({ content: '' });
            const after = await vscode.workspace.openTextDocument({ content: newText });
            previews.push({ before: before.uri, after: after.uri, title: `Carrot preview: ${relative} (new)` });
            changed.push({ path: folders.length > 1 ? `${folders[rootIndex].name}/${relative}` : relative, status: 'A' });
          } else {
            const document = await vscode.workspace.openTextDocument(uri);
            const oldText = requireString(edit, 'oldText', 200_000);
            const content = document.getText();
            const first = content.indexOf(oldText);
            if (first < 0 || content.indexOf(oldText, first + oldText.length) >= 0) throw new Error(`oldText must match exactly once in ${relative}`);
            const start = document.positionAt(first);
            const end = document.positionAt(first + oldText.length);
            workspaceEdit.replace(uri, new vscode.Range(start, end), newText);
            const nextContent = content.slice(0, first) + newText + content.slice(first + oldText.length);
            const after = await vscode.workspace.openTextDocument({ content: nextContent, language: document.languageId });
            previews.push({ before: uri, after: after.uri, title: `Carrot preview: ${relative}` });
            changed.push({ path: folders.length > 1 ? `${folders[rootIndex].name}/${relative}` : relative, status: 'M' });
          }
        }
        for (const preview of previews) {
          await vscode.commands.executeCommand('vscode.diff', preview.before, preview.after, preview.title, { preview: true });
        }
        const confirmed = await context.approve(
          { name: 'apply_workspace_edit', description: 'Apply reviewed workspace changes.', inputSchema: {}, risk: OperationRisk.NORMAL_WRITE, requiresApproval: true },
          `Apply changes to ${changed.map(item => item.path).join(', ')}?`,
        );
        if (!confirmed) throw new Error('User rejected the final edit confirmation.');
        if (!await vscode.workspace.applyEdit(workspaceEdit)) throw new Error('VS Code rejected the workspace edit.');
        return { changedFiles: changed };
      },
      args => `Review changes to ${(args.edits as any[]).map(edit => edit.path).join(', ')}`);
  }

  function commandTool(): RegisteredTool {
    return tool('run_command', 'Run one allowlisted build, test, lint, or TypeScript validation command.', OperationRisk.NORMAL_WRITE,
      schemas.object({ command: schemas.string, cwd: schemas.string, rootIndex: schemas.number, timeoutMs: schemas.number }, ['command']), true,
      args => { requireString(args, 'command', 200); if (args.cwd !== undefined) requireString(args, 'cwd', 1_000); optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1)); optionalNumber(args, 'timeoutMs', 120_000, 1_000, 300_000); validateAgentCommand(args.command as string); },
      async (args, context) => {
        const command = requireString(args, 'command', 200);
        const timeout = optionalNumber(args, 'timeoutMs', 120_000, 1_000, 300_000);
        const [executable, ...commandArgs] = parseAgentCommand(command);
        const rootIndex = optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1));
        const root = folders[rootIndex]?.uri.fsPath;
        const cwd = args.cwd === undefined ? root : await guard.resolveRelativePath(requireString(args, 'cwd', 1_000), rootIndex);
        return executeBounded(executable, commandArgs, { cwd, timeoutMs: timeout, outputLimit: 50_000, signal: context.signal });
      },
      args => `Run "${args.command}" in ${args.cwd ?? 'the workspace root'}?`);
  }

  function projectActionTool(): RegisteredTool {
    return tool('run_project_action', 'Detect and run a high-level build, test, lint, or typecheck action.', OperationRisk.NORMAL_WRITE,
      schemas.object({ action: schemas.string, project: schemas.string, cwd: schemas.string, rootIndex: schemas.number, timeoutMs: schemas.number }, ['action']), true,
      args => {
        const action = requireString(args, 'action', 20);
        if (!['build', 'test', 'lint', 'typecheck'].includes(action)) throw new Error('Invalid project action. Use start_project for services.');
        if (args.project !== undefined) requireString(args, 'project', 100);
        if (args.cwd !== undefined) requireString(args, 'cwd', 1_000);
        optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1)); optionalNumber(args, 'timeoutMs', 120_000, 1_000, 300_000);
      },
      async (args, context) => {
        const rootIndex = optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1));
        const root = folders[rootIndex]; if (!root) throw new Error('No workspace is open.');
        const cwd = args.cwd === undefined ? root.uri.fsPath : await guard.resolveRelativePath(requireString(args, 'cwd', 1_000), rootIndex);
        const cwdUri = vscode.Uri.file(cwd); const packageJson = await readJsonUriIfPresent(vscode.Uri.joinPath(cwdUri, 'package.json'));
        const markers: string[] = [];
        for (const marker of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'nx.json', 'angular.json', 'nest-cli.json', 'tsconfig.json']) { try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(cwdUri, marker)); markers.push(marker); } catch {} }
        const selected = commandForAction(detectProjectCommands(packageJson, markers), requireString(args, 'action', 20) as ProjectAction, typeof args.project === 'string' ? args.project : undefined);
        if (!selected) throw new Error(`No detected ${args.action} command is available in this project.`);
        const [executable, ...commandArgs] = parseAgentCommand(selected.command);
        const result = await executeBounded(executable, commandArgs, { cwd, timeoutMs: optionalNumber(args, 'timeoutMs', 120_000, 1_000, 300_000), outputLimit: 50_000, signal: context.signal });
        if (result.exitCode === 0 && commandMemory) {
          const record: RememberedCommand = { action: args.action as string, project: typeof args.project === 'string' ? args.project : undefined, cwd: typeof args.cwd === 'string' ? args.cwd : '.', command: selected.command, lastSucceededAt: new Date().toISOString() };
          const next = [record, ...commandMemory.get().filter(item => !(item.action === record.action && item.project === record.project && item.cwd === record.cwd))].slice(0, 20);
          await commandMemory.set(next);
        }
        return { action: args.action, command: selected.command, ...result };
      }, args => `Detect and run the ${args.action} command${args.project ? ` for ${args.project}` : ''}?`);
  }

  function projectStartTool(restart: boolean): RegisteredTool {
    const name = restart ? 'restart_project' : 'start_project';
    return tool(name, `${restart ? 'Restart' : 'Start'} a detected project service and verify its TCP port.`, restart ? OperationRisk.HIGH_RISK : OperationRisk.NORMAL_WRITE,
      schemas.object({ port: schemas.number, expectedPid: schemas.number, project: schemas.string, cwd: schemas.string, rootIndex: schemas.number }, restart ? ['port', 'expectedPid'] : ['port']), true,
      args => {
        optionalNumber(args, 'port', 0, 1, 65_535); if (restart) optionalNumber(args, 'expectedPid', 0, 1, 2_147_483_647);
        if (args.project !== undefined) requireString(args, 'project', 100); if (args.cwd !== undefined) requireString(args, 'cwd', 1_000);
        optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1));
      }, async (args, context) => {
        const port = optionalNumber(args, 'port', 0, 1, 65_535);
        if (restart) await killPort(port, optionalNumber(args, 'expectedPid', 0, 1, 2_147_483_647), context.signal);
        else if (!(await checkPort(port, context.signal)).free) throw new Error(`Port ${port} is already occupied. Inspect it before starting.`);
        const rootIndex = optionalNumber(args, 'rootIndex', 0, 0, Math.max(0, folders.length - 1)); const root = folders[rootIndex]; if (!root) throw new Error('No workspace is open.');
        const cwd = args.cwd === undefined ? root.uri.fsPath : await guard.resolveRelativePath(requireString(args, 'cwd', 1_000), rootIndex); const cwdUri = vscode.Uri.file(cwd);
        const packageJson = await readJsonUriIfPresent(vscode.Uri.joinPath(cwdUri, 'package.json')); const markers: string[] = [];
        for (const marker of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'nx.json', 'angular.json', 'nest-cli.json', 'tsconfig.json']) { try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(cwdUri, marker)); markers.push(marker); } catch {} }
        const selected = commandForAction(detectProjectCommands(packageJson, markers), 'start', typeof args.project === 'string' ? args.project : undefined); if (!selected) throw new Error('No detected start command is available.');
        const [executable, ...commandArgs] = parseAgentCommand(selected.command); const pid = startDetached(executable, commandArgs, cwd);
        try {
          for (let attempt = 0; attempt < 20; attempt++) { await new Promise(resolve => setTimeout(resolve, 500)); const status = await checkPort(port, context.signal); if (!status.free) return { action: restart ? 'restart' : 'start', command: selected.command, pid, port, listening: true, owners: status.owners }; }
          throw new Error(`Started PID ${pid}, but port ${port} did not become ready within 10 seconds.`);
        } catch (error) {
          try { await terminateProcess(pid, new AbortController().signal); } catch {}
          throw error;
        }
      }, args => `${restart ? `Kill verified PID ${args.expectedPid}, then restart` : 'Start'} the detected project service and verify port ${args.port}?`);
  }
}

export interface RememberedCommand { action: string; project?: string; cwd: string; command: string; lastSucceededAt: string; }

function tool(
  name: string,
  description: string,
  risk: OperationRisk,
  inputSchema: Record<string, unknown>,
  requiresApproval: boolean,
  validate: RegisteredTool['validate'],
  execute: RegisteredTool['execute'],
  summarize?: RegisteredTool['summarize'],
): RegisteredTool {
  return { name, description, risk, inputSchema, requiresApproval, validate, execute, summarize };
}

async function readJsonIfPresent(guard: WorkspaceGuard, relative: string, rootIndex: number): Promise<any> {
  try {
    const resolved = await guard.resolveRelativePath(relative, rootIndex);
    return JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(resolved))));
  } catch { return undefined; }
}

async function readJsonUriIfPresent(uri: vscode.Uri): Promise<any> {
  try { return JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))); } catch { return undefined; }
}

function relativeToRoot(root: vscode.WorkspaceFolder, uri: vscode.Uri): string {
  const relative = path.relative(root.uri.fsPath, uri.fsPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('VS Code returned a file outside its owning workspace root.');
  }
  return relative.replaceAll('\\', '/');
}

function ownedPath(folders: readonly vscode.WorkspaceFolder[], uri: vscode.Uri): { root: string; rootIndex: number; path: string } | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return undefined;
  const rootIndex = folders.findIndex(candidate => candidate.uri.toString() === folder.uri.toString());
  if (rootIndex < 0) return undefined;
  return { root: folder.name, rootIndex, path: relativeToRoot(folder, uri) };
}

function requireSearchTerms(args: Record<string, unknown>): string[] {
  const terms = searchTerms(args, 12);
  if (!terms.length) throw new Error('Provide query or queries with at least one searchable term.');
  return terms;
}

function inferLanguages(files: vscode.Uri[]): string[] {
  const mapping: Record<string, string> = { '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.py': 'Python', '.go': 'Go', '.java': 'Java', '.html': 'HTML', '.scss': 'SCSS', '.css': 'CSS' };
  return [...new Set(files.map(uri => mapping[path.extname(uri.fsPath).toLowerCase()]).filter(Boolean))];
}

function assertNotSensitive(relative: string): void {
  if (isSensitiveFile(relative)) throw new Error('Sensitive files are excluded from agent tools.');
}
