import { parseAgentResponse, ToolResult } from './toolProtocol';
import { ToolContext, ToolRegistry } from './toolRegistry';
import { rankFilePaths, searchTerms } from './searchSemantics';

export interface AgentActivity { tool?: string; status: 'running' | 'complete' | 'failed' | 'cancelled'; label: string; }
export interface AgentLoopOptions {
  registry: ToolRegistry;
  turn: (systemPrompt: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>) => Promise<string>;
  context: ToolContext;
  onActivity?: (activity: AgentActivity) => void;
  onDebug?: (message: string) => void;
  modelId?: string;
  localOnly?: boolean;
  alternativeModels?: string[];
  requiresWorkspaceEvidence?: boolean;
  maxIterations?: number;
  maxContextCharacters?: number;
  maxDurationMs?: number;
}

export interface AgentRunMetrics {
  turns: number;
  modelDurationMs: number;
  toolDurationMs: number;
  cacheHits: number;
  correctiveRetries: number;
  peakContextCharacters: number;
}

export class AgentLoop {
  constructor(private readonly options: AgentLoopOptions) {}

  async run(prompt: string): Promise<{ final: string; toolResults: ToolResult[]; metrics: AgentRunMetrics }> {
    const maxIterations = this.options.maxIterations ?? 8;
    const maxContext = this.options.maxContextCharacters ?? 60_000;
    const deadline = Date.now() + (this.options.maxDurationMs ?? 300_000);
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [{ role: 'user', content: prompt }];
    const toolResults: ToolResult[] = [];
    const systemPrompt = this.systemPrompt(prompt);
    const evidenceRequired = this.options.requiresWorkspaceEvidence ?? requiresWorkspaceEvidence(prompt);
    const projectAnalysis = looksLikeProjectAnalysis(prompt) && hasEvidenceTools(this.options.registry);
    const editingTask = looksLikeEditingTask(prompt);
    const plannedTerms = projectSearchPlan(prompt);
    const cache = new Map<string, ToolResult>();
    const readPaths = new Set<string>();
    const discoveredPaths = new Set<string>();
    let successfulSearches = 0;
    let modelDurationMs = 0;
    let toolDurationMs = 0;
    let cacheHits = 0;
    let successfulWrites = 0;
    let diagnosticsChecks = 0;
    let validationCommands = 0;
    let peakContextCharacters = 0;
    this.options.onDebug?.(`agent start model=${this.options.modelId ?? 'unknown'} localOnly=${this.options.localOnly ?? 'unknown'} protocol=structured-json tools=${this.options.registry.definitions().length} evidenceRequired=${evidenceRequired}`);

    let formatFailures = 0;
    let evidenceCorrections = 0;
    let refusalCorrections = 0;
    let finalCorrections = 0;
    let totalCorrections = 0;
    let turnNumber = 0;
    if (projectAnalysis) {
      const searchCall = { type: 'tool_call' as const, id: 'planned_search', tool: 'search_workspace', arguments: { queries: plannedTerms, limit: 30 } };
      const searchStarted = Date.now();
      const searchResult = await this.options.registry.execute(searchCall, this.options.context);
      toolDurationMs += Date.now() - searchStarted;
      toolResults.push(searchResult);
      collectEvidence(searchCall.tool, searchCall.arguments, searchResult, readPaths, discoveredPaths);
      if (!searchResult.error) {
        successfulSearches++;
        cache.set(readOnlyCacheKey(searchCall.tool, searchCall.arguments)!, searchResult);
      }
      messages.push({ role: 'user', content: JSON.stringify({ ...searchResult, planned: true, instruction: 'Use these ranked topic matches. Relevant source excerpts are being collected before answering.' }) });
      const fileSearchCall = { type: 'tool_call' as const, id: 'planned_file_search', tool: 'search_files', arguments: { queries: plannedTerms, limit: 40 } };
      const fileSearchStarted = Date.now();
      const fileSearchResult = await this.options.registry.execute(fileSearchCall, this.options.context);
      toolDurationMs += Date.now() - fileSearchStarted;
      toolResults.push(fileSearchResult);
      collectEvidence(fileSearchCall.tool, fileSearchCall.arguments, fileSearchResult, readPaths, discoveredPaths);
      if (!fileSearchResult.error) {
        successfulSearches++;
        cache.set(readOnlyCacheKey(fileSearchCall.tool, fileSearchCall.arguments)!, fileSearchResult);
      }
      messages.push({ role: 'user', content: JSON.stringify({ ...fileSearchResult, planned: true }) });
      const candidatePaths = rankedEvidencePaths([searchResult.result, fileSearchResult.result], plannedTerms, 7);
      this.options.onDebug?.(`planned evidence files=${candidatePaths.join(',')}`);
      for (let index = 0; index < candidatePaths.length; index++) {
        const readCall = { type: 'tool_call' as const, id: `planned_read_${index + 1}`, tool: 'read_file_range', arguments: { path: candidatePaths[index], startLine: 1, endLine: 220 } };
        const readStarted = Date.now();
        const readResult = await this.options.registry.execute(readCall, this.options.context);
        toolDurationMs += Date.now() - readStarted;
        toolResults.push(readResult);
        collectEvidence(readCall.tool, readCall.arguments, readResult, readPaths, discoveredPaths);
        if (!readResult.error) cache.set(readOnlyCacheKey(readCall.tool, readCall.arguments)!, readResult);
        messages.push({ role: 'user', content: JSON.stringify({ ...readResult, planned: true }) });
      }
      messages.push({ role: 'user', content: 'PLANNED EVIDENCE READY: Relevant ranked search results and source excerpts are already available above. Do not request a project tree or repeat discovery. Read only a clearly missing relevant file, otherwise produce the grounded final answer now.' });
      this.options.onDebug?.(`planned evidence terms=${plannedTerms.join(',')} searches=${successfulSearches} reads=${readPaths.size}`);
    }
    while (toolResults.length < maxIterations) {
      if (this.options.context.signal.aborted) {
        this.options.onActivity?.({ status: 'cancelled', label: 'Agent task stopped' });
        throw new Error('Agent task was cancelled.');
      }
      if (Date.now() > deadline) throw new Error('Agent task exceeded its time limit.');
      turnNumber++;
      const contextCharacters = systemPrompt.length + messages.reduce((sum, message) => sum + message.content.length, 0);
      peakContextCharacters = Math.max(peakContextCharacters, contextCharacters);
      this.options.onDebug?.(`agent turn=${turnNumber} contextChars=${contextCharacters}`);
      const modelStarted = Date.now();
      const raw = await this.options.turn(systemPrompt, messages);
      const modelElapsed = Date.now() - modelStarted;
      modelDurationMs += modelElapsed;
      this.options.onDebug?.(`model response kind=${responseKind(raw)} chars=${raw.length} durationMs=${modelElapsed}`);
      let response: ReturnType<typeof parseAgentResponse>;
      try {
        response = parseAgentResponse(raw);
      } catch (error) {
        formatFailures++;
        totalCorrections++;
        const refusal = looksLikeToolRefusal(raw);
        this.options.onDebug?.(`tool parsed=no reason=${safeError(error)} correctiveRetry=${formatFailures}`);
        if (formatFailures > 2) throw this.compatibilityError();
        this.options.onActivity?.({ status: 'failed', label: refusal ? 'Model described tools instead of calling one; correcting…' : 'Model response format was invalid; correcting…' });
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: refusal
          ? 'TOOL CORRECTION: Workspace tools are available and executable by the extension. Call the appropriate tool now using one structured tool_call JSON object. Do not describe the tool, ask the user to run it, or claim you cannot access the workspace.'
          : 'FORMAT CORRECTION: Return only one valid JSON object using exactly one of the two response schemas in the system prompt. Do not add Markdown or commentary.' });
        trimContext(messages, maxContext);
        continue;
      }
      formatFailures = 0;
      this.options.onDebug?.(`tool parsed=${response.type === 'tool_call' ? 'yes' : 'no'} responseType=${response.type}${response.type === 'tool_call' ? ` tool=${response.tool}` : ''}`);
      messages.push({ role: 'assistant', content: raw });
      if (response.type === 'final') {
        if (evidenceRequired && toolResults.length === 0) {
          evidenceCorrections++;
          totalCorrections++;
          this.options.onDebug?.(`final rejected reason=no-workspace-evidence correctiveRetry=${evidenceCorrections}`);
          if (evidenceCorrections > 2) throw this.compatibilityError();
          this.options.onActivity?.({ status: 'failed', label: 'Workspace evidence is required; asking the model to use a tool…' });
          messages.push({ role: 'user', content: 'EVIDENCE CORRECTION: You have not inspected the workspace. This task requires project evidence. Call one available workspace tool now. Do not answer the user until relevant workspace results have been retrieved.' });
          continue;
        }
        const evidenceIssue = projectAnalysis
          ? validateProjectFinal(prompt, response.content, successfulSearches, readPaths, discoveredPaths)
          : undefined;
        const editIssue = editingTask ? validateEditingCompletion(successfulWrites, diagnosticsChecks, validationCommands) : undefined;
        const finalIssue = evidenceIssue ?? editIssue;
        if (finalIssue) {
          finalCorrections++;
          totalCorrections++;
          this.options.onDebug?.(`final rejected reason=${finalIssue} correctiveRetry=${finalCorrections}`);
          const correctionLimit = editingTask ? 3 : 1;
          if (finalCorrections > correctionLimit) throw new Error(`Agent final failed task validation: ${finalIssue}.`);
          this.options.onActivity?.({ status: 'failed', label: 'Answer needs stronger workspace evidence; correctingâ€¦' });
          messages.push({ role: 'user', content: editingTask
            ? `WORKFLOW CORRECTION: ${finalIssue}. Continue the requested edit workflow using one tool now. Do not finalize until a reviewed write is approved and applied, diagnostics are checked, and the smallest relevant allowlisted validation command passes.`
            : `EVIDENCE CORRECTION: ${finalIssue}. Continue with one bounded search or file read. Search plan: ${plannedTerms.join(', ')}. Only finalize after reading relevant source files, addressing the requested topic, and citing files you actually retrieved.` });
          continue;
        }
        if (looksLikeToolRefusal(response.content)) {
          refusalCorrections++;
          totalCorrections++;
          this.options.onDebug?.(`final rejected reason=workspace-access-refusal correctiveRetry=${refusalCorrections}`);
          if (refusalCorrections > 1) throw this.compatibilityError();
          this.options.onActivity?.({ status: 'failed', label: 'Model incorrectly refused workspace access; correcting…' });
          messages.push({ role: 'user', content: 'Workspace tools are available and executable by the extension. Continue using them or return an evidence-based final answer. Never ask the user to execute a registered tool.' });
          continue;
        }
        this.options.onDebug?.(`agent complete turns=${turnNumber} tools=${toolResults.length}`);
        return {
          final: response.content,
          toolResults,
          metrics: { turns: turnNumber, modelDurationMs, toolDurationMs, cacheHits, correctiveRetries: totalCorrections, peakContextCharacters },
        };
      }

      this.options.onActivity?.({ tool: response.tool, status: 'running', label: activityLabel(response.tool, response.arguments) });
      const cacheKey = readOnlyCacheKey(response.tool, response.arguments);
      const cached = cacheKey ? cache.get(cacheKey) : undefined;
      const toolStarted = Date.now();
      const result = cached
        ? { ...cached, id: response.id }
        : await this.options.registry.execute(response, this.options.context);
      const toolElapsed = Date.now() - toolStarted;
      toolDurationMs += toolElapsed;
      if (cached) cacheHits++;
      else if (cacheKey && !result.error) cache.set(cacheKey, result);
      if (!cacheKey && !result.error) cache.clear();
      if (!result.error && ['apply_workspace_edit', 'edit_file', 'create_file'].includes(response.tool)) successfulWrites++;
      if (!result.error && response.tool === 'get_diagnostics') diagnosticsChecks++;
      if (!result.error && response.tool === 'run_command') validationCommands++;
      collectEvidence(response.tool, response.arguments, result, readPaths, discoveredPaths);
      if (!result.error && (response.tool === 'search_workspace' || response.tool === 'search_files')) successfulSearches++;
      this.options.onDebug?.(`tool result tool=${response.tool} durationMs=${toolElapsed} chars=${JSON.stringify(result).length} cached=${cached ? 'yes' : 'no'}`);
      toolResults.push(result);
      this.options.onActivity?.({ tool: response.tool, status: result.error ? 'failed' : 'complete', label: result.error ? `${response.tool}: ${result.error}` : completedLabel(response.tool, response.arguments, result.result) });
      messages.push({ role: 'user', content: JSON.stringify(cached ? { ...result, cached: true, instruction: 'This result was reused. Choose a different evidence step if more information is needed.' } : result) });
      trimContext(messages, maxContext);
    }
    throw new Error(`Agent stopped after the ${maxIterations}-tool iteration limit.`);
  }

  private systemPrompt(prompt: string): string {
    return `You are Carrot, a coding agent running inside VS Code. You have real workspace tools, executed for you by the extension host.
You cannot access the workspace directly, so when project information is required you MUST request the provided tools and use them until you have sufficient evidence.
Never tell the user to execute a registered tool. Never claim you lack workspace access while these tools are available. Never invent project details or paths.
Request exactly one extension-host tool per response.
Return ONLY valid JSON in one of these forms:
{"type":"tool_call","id":"unique_id","tool":"tool_name","arguments":{}}
{"type":"final","content":"your concise final answer"}
TOOL PHASE: If more workspace information is needed, return a tool_call JSON object only. Do not describe or narrate the call.
FINAL PHASE: Return final JSON only after enough actual tool results have been collected. Base all project claims and paths on those results.
Never place commentary outside the JSON. Never invent tool results. Inspect before editing. Use diagnostics and validation after edits.
For an editing task, do not return final until an approved edit tool succeeds, get_diagnostics runs after the edit, and run_command completes the smallest relevant test or build.
For filename or content discovery, pass one term in query or multiple independent terms in queries.
For project analysis, begin with focused content searches using this bounded term plan: ${projectSearchPlan(prompt).join(', ')}. Expand the user's topic into independent synonyms, then read the strongest source-file matches. Avoid repeated tree, search, and read calls.
If a project-level search returns zero results, retry at least two bounded alternatives such as a shorter synonym, search_files, and search_workspace before concluding the code is absent.
When a result includes rootIndex, pass the same rootIndex to subsequent read, edit, Git, or command tools.
For project explanations, reference the actual workspace-relative paths you inspected.
Available tools:
${JSON.stringify(this.options.registry.definitions())}`;
  }

  private compatibilityError(): Error {
    const model = this.options.modelId && this.options.modelId !== 'auto' ? this.options.modelId : 'The selected model';
    const alternatives = ['Auto', ...(this.options.alternativeModels ?? []).filter(value => value !== this.options.modelId)].slice(0, 4);
    return new Error(`${model} failed to produce a valid workspace tool request after 2 correction attempts. Try: ${alternatives.join(', ') || 'another configured tool-capable model'}, or enable carrot.debugAgent.`);
  }
}

const READ_ONLY_CACHE_TOOLS = new Set([
  'get_project_info', 'get_workspace_tree', 'search_files', 'search_workspace', 'read_file', 'read_file_range',
  'get_current_file', 'get_selection', 'get_diagnostics', 'get_git_status',
]);

function readOnlyCacheKey(tool: string, args: Record<string, unknown>): string | undefined {
  if (!READ_ONLY_CACHE_TOOLS.has(tool)) return undefined;
  return `${tool}:${stableJson(args)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function hasEvidenceTools(registry: ToolRegistry): boolean {
  const names = new Set(registry.definitions().map(tool => tool.name));
  return names.has('search_workspace') && (names.has('read_file') || names.has('read_file_range'));
}

function looksLikeProjectAnalysis(prompt: string): boolean {
  return /\b(explain|how|analy[sz]e|understand|architecture|flow|works?)\b/i.test(prompt) && requiresWorkspaceEvidence(prompt);
}

function looksLikeEditingTask(prompt: string): boolean {
  return /\b(fix|edit|modify|change|implement|refactor|improve)\b/i.test(prompt);
}

function validateEditingCompletion(writes: number, diagnostics: number, commands: number): string | undefined {
  if (writes < 1) return 'no approved workspace edit was applied';
  if (diagnostics < 1) return 'diagnostics were not checked after the edit';
  if (commands < 1) return 'no relevant test or build was run after the edit';
  return undefined;
}

export function projectSearchPlan(prompt: string, maxTerms = 8): string[] {
  const base = searchTerms({ query: prompt }, maxTerms);
  const genericAliases: Record<string, string[]> = {
    auth: ['auth', 'jwt', 'login', 'bcrypt', 'interceptor', 'guard', 'secretstorage'],
    authentication: ['auth', 'jwt', 'login', 'bcrypt', 'interceptor', 'guard', 'secretstorage'],
    database: ['database', 'repository', 'entity', 'typeorm'],
    routing: ['route', 'router', 'controller', 'guard'],
    session: ['session', 'message', 'history', 'owner'],
  };
  const priority = Object.entries(genericAliases).flatMap(([topic, aliases]) => new RegExp(`\\b${topic}\\b`, 'i').test(prompt) ? aliases : []);
  const expanded = [...priority, ...base.flatMap(term => genericAliases[term] ?? [term])];
  return [...new Set(expanded)].slice(0, maxTerms);
}

function collectEvidence(tool: string, args: Record<string, unknown>, result: ToolResult, readPaths: Set<string>, discoveredPaths: Set<string>): void {
  if (result.error) return;
  const requestedPath = typeof args.path === 'string' ? normalizePath(args.path) : undefined;
  if ((tool === 'read_file' || tool === 'read_file_range') && requestedPath && resultHasContent(result.result)) readPaths.add(requestedPath);
  collectPaths(result.result, discoveredPaths);
  if (requestedPath) discoveredPaths.add(requestedPath);
}

function resultHasContent(result: unknown): boolean {
  return !!result && typeof result === 'object' && typeof (result as Record<string, unknown>).content === 'string' && ((result as Record<string, unknown>).content as string).trim().length > 0;
}

function collectPaths(value: unknown, paths: Set<string>): void {
  if (Array.isArray(value)) { for (const item of value) collectPaths(item, paths); return; }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.path === 'string') paths.add(normalizePath(record.path));
  for (const key of ['matches', 'files', 'entries']) collectPaths(record[key], paths);
}

function rankedEvidencePaths(result: unknown, terms: readonly string[], limit: number): string[] {
  if (Array.isArray(result)) {
    const combined = result.flatMap(item => evidenceItems(item));
    return rankEvidenceItems(combined, terms, limit);
  }
  return rankEvidenceItems(evidenceItems(result), terms, limit);
}

function evidenceItems(result: unknown): unknown[] {
  if (!result || typeof result !== 'object') return [];
  const record = result as Record<string, unknown>;
  return Array.isArray(record.matches) ? record.matches : Array.isArray(record.files) ? record.files : [];
}

function rankEvidenceItems(items: unknown[], terms: readonly string[], limit: number): string[] {
  const paths = items.map(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).path === 'string' ? (item as Record<string, unknown>).path as string : undefined)
    .filter((value): value is string => !!value)
    .filter(value => !/\.(spec|test)\.[^.]+$/i.test(value) && !/(^|[\\/])(test|tests|fixtures|generated|dist|build)([\\/]|$)/i.test(value));
  const unique = [...new Set(paths)];
  const ranked = rankFilePaths(unique, terms, Math.max(limit * 3, limit)).map(item => item.path);
  const selected: string[] = [];
  for (const layer of ['backend/', 'frontend/']) {
    const match = ranked.find(value => normalizePath(value).startsWith(layer));
    if (match) selected.push(match);
  }
  for (const filePath of ranked) if (!selected.includes(filePath)) selected.push(filePath);
  return selected.slice(0, limit);
}

function validateProjectFinal(prompt: string, final: string, searches: number, readPaths: Set<string>, discoveredPaths: Set<string>): string | undefined {
  if (searches < 1) return 'no relevant workspace search has completed';
  if (readPaths.size < 2) return 'fewer than two relevant source files were read';
  const normalizedFinal = final.toLowerCase().replaceAll('\\', '/');
  const topics = projectSearchPlan(prompt).filter(term => term.length > 2);
  if (topics.length && !topics.some(term => normalizedFinal.includes(term))) return 'the answer does not address the requested topic';
  if (/\bauth(?:entication)?\b/i.test(prompt)) {
    const concepts = [
      /\b(?:bcrypt|password hash|hashed password)\b/i,
      /\b(?:jwt|bearer token)\b/i,
      /\b(?:login|sign[ -]?in|register)\b/i,
      /\b(?:guard|protected route)\b/i,
      /\b(?:interceptor|authorization header|token storage|localstorage)\b/i,
    ];
    if (concepts.filter(pattern => pattern.test(final)).length < 4) return 'the authentication flow is incomplete; cover credentials, JWT issuance, token transport, and route protection';
  }
  if (![...readPaths].some(filePath => normalizedFinal.includes(filePath) || normalizedFinal.includes(filePath.split('/').pop()!))) {
    return 'the answer does not reference a file that was actually read';
  }
  const mentioned = final.match(/(?:backend|frontend|vscode-extension|src)[/\\][a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+/g) ?? [];
  const known = new Set([...discoveredPaths, ...readPaths].map(normalizePath));
  if (mentioned.some(filePath => !known.has(normalizePath(filePath)))) return 'the answer references a file that was not found';
  if (mentioned.some(filePath => !readPaths.has(normalizePath(filePath)))) return 'the answer references a file whose contents were not read';
  const readBasenames = new Set([...readPaths].map(filePath => filePath.split('/').pop()!));
  const mentionedBasenames = final.match(/\b[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.(?:ts|tsx|js|jsx|html|css|scss|py|go|java)\b/g) ?? [];
  if (mentionedBasenames.some(fileName => !readBasenames.has(fileName.toLowerCase()))) return 'the answer cites a source file whose contents were not read';
  return undefined;
}

function normalizePath(value: string): string { return value.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase(); }

export function looksLikeProjectTask(prompt: string): boolean {
  return /\b(fix|add|implement|change|modify|refactor|debug|project|codebase|file|build|test|diagnostic|authentication|api|component|service)\b/i.test(prompt);
}

export function requiresWorkspaceEvidence(prompt: string): boolean {
  return /\b(project|workspace|codebase|repository|repo|file|where|find|inspect|analy[sz]e|authentication|implementation|diagnostic|fix|build|test)\b/i.test(prompt);
}

function looksLikeToolRefusal(value: string): boolean {
  return /\b(i (?:can(?:not|'t)|am unable to) (?:access|inspect|read|execute)|manually (?:search|inspect|run)|(?:you|please) (?:should |can )?(?:use|run|execute) (?:the )?(?:search_workspace|search_files|read_file|workspace tool)|limitations? in my capabilities)\b/i.test(value);
}

function responseKind(value: string): string {
  const trimmed = value.trim();
  if (/^<think>/i.test(trimmed)) return 'thinking-plus-output';
  if (/^```/i.test(trimmed)) return 'fenced';
  if (trimmed.startsWith('{')) return 'json-object';
  return 'text';
}

function safeError(error: unknown): string { return (error instanceof Error ? error.message : 'invalid response').replace(/[\r\n]+/g, ' ').slice(0, 160); }

function trimContext(messages: Array<{ role: 'user' | 'assistant'; content: string }>, max: number): void {
  let total = messages.reduce((sum, message) => sum + message.content.length, 0);
  while (total > max && messages.length > 3) {
    const removed = messages.splice(1, 2);
    total -= removed.reduce((sum, message) => sum + message.content.length, 0);
  }
  if (total > max) throw new Error('Agent context budget exceeded.');
}

function activityLabel(tool: string, args: Record<string, unknown>): string {
  const query = typeof args.query === 'string' ? args.query : Array.isArray(args.queries) ? args.queries.filter(value => typeof value === 'string').join(', ') : undefined;
  const filePath = typeof args.path === 'string' ? args.path : undefined;
  if (tool === 'search_workspace') return `Searching workspace for "${query ?? ''}"…`;
  if (tool === 'search_files') return `Searching files for "${query ?? ''}"…`;
  if ((tool === 'read_file' || tool === 'read_file_range') && filePath) return `Reading ${filePath}…`;
  const labels: Record<string, string> = { get_project_info: 'Inspecting project', get_workspace_tree: 'Reading workspace tree', search_workspace: 'Searching workspace…', search_files: 'Finding files…', read_file: 'Reading files…', read_file_range: 'Reading files…', web_search: 'Searching the web…', get_current_file: 'Inspecting current file', get_selection: 'Reading selection', get_diagnostics: 'Checking diagnostics', get_git_status: 'Checking Git status', apply_workspace_edit: 'Preparing changes', run_command: 'Running validation' };
  return labels[tool] ?? `Running ${tool}`;
}

function completedLabel(tool: string, args: Record<string, unknown>, result: unknown): string {
  const count = countResult(result);
  if (tool === 'search_workspace') return count ? `Found ${count} workspace match${count === 1 ? '' : 'es'}` : 'No workspace matches';
  if (tool === 'search_files') return count ? `Found ${count} file${count === 1 ? '' : 's'}` : 'No matching files';
  if (tool === 'get_workspace_tree') return `Read workspace tree (${count ?? 0} entries)`;
  if (tool === 'get_project_info') return 'Inspected project';
  if (tool === 'read_file' || tool === 'read_file_range') return `Read ${(typeof args.path === 'string' ? args.path : 'file').split(/[\\/]/).pop()}`;
  const labels: Record<string, string> = { get_current_file: 'Inspected current file', get_selection: 'Read selection', get_diagnostics: 'Checked diagnostics', get_git_status: 'Checked Git status', apply_workspace_edit: 'Applied workspace changes', edit_file: 'Edited file', create_file: 'Created file', run_command: 'Completed validation command' };
  return labels[tool] ?? `Completed ${tool}`;
}

function countResult(result: unknown): number | undefined {
  if (Array.isArray(result)) return result.length;
  if (!result || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  if (typeof record.count === 'number') return record.count;
  for (const key of ['matches', 'files', 'entries']) if (Array.isArray(record[key])) return record[key].length;
  return undefined;
}
