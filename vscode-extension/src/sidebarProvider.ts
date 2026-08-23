import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { CarrotClient, CarrotClientError } from './carrotClient';
import { selectableChatModels, validateModelSelection } from './modelPolicy';
import { getSidebarHtml } from './sidebarHtml';
import { parseSidebarMessage, SidebarMessage } from './sidebarProtocol';
import { hasConversationMessages } from './sessionPolicy';
import { AgentLoop, requiresAgentTools, requiresLiveWeb } from './agentLoop';
import { createWorkspaceToolRegistry } from './workspaceTools';
import { OperationRisk } from './toolRegistry';
import { AgentCompatibilityMap, completedCompatibility, failedCompatibility, withCompatibility } from './modelCompatibility';
import { ToolDefinition } from './toolProtocol';
import { ToolDebugEvent } from './toolRegistry';
import { isSensitiveFile } from './workspacePolicy';

export const CARROT_VIEW_ID = 'carrot.sidebar';
export const MODEL_KEY = 'carrot.selectedModel';
export const SESSION_KEY = 'carrot.currentSessionId';
export const TOKEN_KEY = 'carrot.accessToken';
export const MODE_KEY = 'carrot.composerMode';
export const DEFAULT_EXTENSION_MODEL_ID = 'local:qwen2.5-coder:7b';
const WEB_SEARCH_KEY = 'carrot.webSearchEnabled';

interface PendingContext { id: string; label: string; content: string; }

export class CarrotSidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private newChatInFlight?: Promise<void>;
  private currentAgent?: AbortController;
  private outputChannel?: vscode.OutputChannel;
  private pendingContexts: PendingContext[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: () => CarrotClient,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    view.webview.html = getSidebarHtml(
      crypto.randomBytes(24).toString('base64url'),
      view.webview.cspSource,
      {
        scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'sidebar.js')).toString(),
        styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'sidebar.css')).toString(),
      },
    );
    view.webview.onDidReceiveMessage((raw) => this.handleMessage(parseSidebarMessage(raw)), undefined, this.context.subscriptions);
  }

  async refresh(forceModels = false): Promise<void> {
    if (!this.view) return;
    const authenticated = Boolean(await this.context.secrets.get(TOKEN_KEY));
    const configuration = vscode.workspace.getConfiguration('carrot');
    const selectedModelId = this.context.globalState.get<string>(MODEL_KEY)
      ?? configuration.get<string>('modelId', DEFAULT_EXTENSION_MODEL_ID);
    const mode = this.context.globalState.get<'ask' | 'agent'>(MODE_KEY, 'ask');
    const localOnly = configuration.get<boolean>('localOnly', true);
    if (!authenticated) {
      await this.postState({ authenticated, selectedModelId, mode, localOnly, models: [], sessions: [], error: false });
      return;
    }

    let activeModelId: string | undefined;
    try {
      const api = this.client();
      const [models, sessions] = await Promise.all([api.getModels(forceModels), api.getSessions()]);
      let sessionId = this.context.workspaceState.get<string>(SESSION_KEY);
      if (sessionId && !sessions.some((session) => session.id === sessionId)) {
        sessionId = undefined;
        await this.context.workspaceState.update(SESSION_KEY, undefined);
      }
      const session = sessionId ? await api.getSession(sessionId) : undefined;
      await this.postState({
        authenticated,
        selectedModelId,
        mode,
        localOnly,
        models,
        sessions,
        sessionId,
        session,
        status: 'Connected',
        error: false,
        webSearch: this.context.workspaceState.get<boolean>(WEB_SEARCH_KEY, false),
        contexts: this.contextLabels(),
      });
    } catch (error) {
      await this.postState({
        authenticated,
        selectedModelId,
        mode,
        localOnly,
        models: [],
        sessions: [],
        error: true,
        status: formatError(error),
      });
    }
  }

  private async handleMessage(message: SidebarMessage | undefined): Promise<void> {
    if (!message) {
      await this.post({ type: 'error', message: 'Carrot rejected an unsupported sidebar request.' });
      return;
    }
    try {
      switch (message.type) {
        case 'ready':
          await this.refresh();
          break;
        case 'signIn':
          await vscode.commands.executeCommand('carrot.login');
          await this.refresh();
          break;
        case 'signOut':
          await vscode.commands.executeCommand('carrot.logout');
          await this.refresh();
          break;
        case 'refreshModels':
          await this.refresh(true);
          break;
        case 'testAgentTools':
          await this.testAgentTools();
          break;
        case 'selectModel':
          await this.selectModel(message.modelId);
          break;
        case 'toggleLocalOnly':
          await this.toggleLocalOnly(message.enabled);
          break;
        case 'sendMessage':
          await this.sendMessage(message.prompt, message.mode, message.webSearch);
          break;
        case 'setWebSearch':
          await this.context.workspaceState.update(WEB_SEARCH_KEY, message.enabled);
          await this.post({ type: 'webSearchState', enabled: message.enabled });
          break;
        case 'setMode':
          await this.context.globalState.update(MODE_KEY, message.mode);
          await this.postState({ mode: message.mode });
          break;
        case 'addContext':
          await this.addContext(message.kind);
          break;
        case 'removeContext':
          this.pendingContexts = this.pendingContexts.filter(item => item.id !== message.contextId);
          await this.postContextState();
          break;
        case 'stopAgent':
          this.currentAgent?.abort();
          await this.post({ type: 'agentStopped' });
          break;
        case 'newChat':
          await this.startNewChat();
          break;
        case 'openSession':
          this.cancelCurrentAgent();
          await this.post({ type: 'conversationReset' });
          await this.context.workspaceState.update(SESSION_KEY, message.sessionId);
          await this.refresh();
          break;
        case 'deleteSession':
          await this.deleteSession(message.sessionId);
          break;
        case 'clearHistory':
          await this.clearHistory();
          break;
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:carrot-ai-local.carrot-vscode');
          break;
        case 'copyCode':
          await vscode.env.clipboard.writeText(message.code);
          break;
        case 'openExternal':
          await vscode.env.openExternal(vscode.Uri.parse(message.url));
          break;
      }
    } catch (error) {
      await this.post({ type: 'error', message: formatError(error) });
    }
  }

  private async selectModel(modelId: string): Promise<void> {
    const localOnly = vscode.workspace.getConfiguration('carrot').get<boolean>('localOnly', true);
    validateModelSelection(await this.client().getModels(), modelId, localOnly);
    await this.context.globalState.update(MODEL_KEY, modelId);
    await this.context.workspaceState.update(SESSION_KEY, undefined);
    await this.refresh();
  }

  private async toggleLocalOnly(enabled: boolean): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('carrot');
    await configuration.update('localOnly', enabled, vscode.ConfigurationTarget.Global);
    if (enabled) {
      const models = await this.client().getModels();
      const current = this.context.globalState.get<string>(MODEL_KEY) ?? 'auto';
      try {
        validateModelSelection(models, current, true);
      } catch {
        const firstLocal = selectableChatModels(models, true)[0];
        await this.context.globalState.update(MODEL_KEY, firstLocal?.id ?? 'auto');
        await this.context.workspaceState.update(SESSION_KEY, undefined);
      }
    }
    await this.refresh();
  }

  private async sendMessage(prompt: string, mode: 'ask' | 'agent', webSearch: boolean): Promise<void> {
    const useWeb = webSearch || requiresLiveWeb(prompt);
    await this.context.globalState.update(MODE_KEY, mode);
    await this.context.workspaceState.update(WEB_SEARCH_KEY, webSearch);
    const selectedContext = this.contextText();
    this.pendingContexts = [];
    await this.postContextState();
    if (mode === 'agent' || requiresAgentTools(prompt)) {
      await this.sendAgentMessage(prompt, useWeb, selectedContext);
      return;
    }
    if (this.currentAgent) throw new Error('A Carrot request is already running.');
    const controller = new AbortController();
    this.currentAgent = controller;
    await this.post({ type: 'busy', value: true });
    try {
      const api = this.client();
      const configuration = vscode.workspace.getConfiguration('carrot');
      const modelId = this.context.globalState.get<string>(MODEL_KEY) ?? configuration.get<string>('modelId', DEFAULT_EXTENSION_MODEL_ID);
      const localOnly = configuration.get<boolean>('localOnly', true);
      validateModelSelection(await api.getModels(), modelId, localOnly);
      let sessionId = this.context.workspaceState.get<string>(SESSION_KEY);
      if (!sessionId) {
        sessionId = await api.createSession(modelId);
        await this.context.workspaceState.update(SESSION_KEY, sessionId);
      }
      await this.post({ type: 'streamStart', prompt });
      await api.sendChatStream(prompt, { modelId, sessionId, localOnly, webSearchEnabled: useWeb, context: selectedContext, signal: controller.signal },
        chunk => { void this.post({ type: 'streamChunk', chunk }); });
      await this.refresh();
    } catch (error) {
      if (controller.signal.aborted) await this.post({ type: 'error', message: 'Carrot request stopped.' });
      else throw error;
    } finally {
      this.currentAgent = undefined;
      await this.post({ type: 'busy', value: false });
    }
  }

  private async sendAgentMessage(prompt: string, webSearch = false, selectedContext = ''): Promise<void> {
    if (this.currentAgent) throw new Error('A Carrot agent task is already running.');
    const controller = new AbortController();
    let activeModelId: string | undefined;
    this.currentAgent = controller;
    await this.post({ type: 'busy', value: true });
    await this.post({ type: 'streamStart', prompt });
    await this.post({ type: 'agentReset' });
    await this.post({ type: 'agentActivity', activity: { status: 'running', label: 'Analyzing your request…' } });
    try {
      const api = this.client();
      const configuration = vscode.workspace.getConfiguration('carrot');
      const modelId = this.context.globalState.get<string>(MODEL_KEY) ?? configuration.get<string>('modelId', DEFAULT_EXTENSION_MODEL_ID);
      activeModelId = modelId;
      const localOnly = configuration.get<boolean>('localOnly', true);
      const debugAgent = configuration.get<boolean>('debugAgent', false);
      const maxIterations = configuration.get<number>('agentMaxToolCalls', 20);
      const maxDurationMs = configuration.get<number>('agentTimeoutMinutes', 15) * 60_000;
      const models = await api.getModels();
      validateModelSelection(models, modelId, localOnly);
      if (debugAgent) {
        this.debugLine(`agent start model=${modelId} localOnly=${localOnly} workspace=${vscode.workspace.name ?? 'none'}`);
        for (const [rootIndex, folder] of (vscode.workspace.workspaceFolders ?? []).entries()) {
          this.debugLine(`workspace root[${rootIndex}]=${folder.uri.toString()}`);
        }
      }
      let sessionId = this.context.workspaceState.get<string>(SESSION_KEY);
      if (!sessionId) {
        sessionId = await api.createSession(modelId);
        await this.context.workspaceState.update(SESSION_KEY, sessionId);
      }

      const agentPrompt = selectedContext ? `${prompt}\n\nUser-selected VS Code context:\n${selectedContext}` : prompt;
      const useWeb = webSearch || requiresLiveWeb(prompt);
      const loop = new AgentLoop({
        registry: createWorkspaceToolRegistry(
          event => this.debugTool(event),
          useWeb ? (query, signal) => api.webSearch(query, signal) : undefined,
          useWeb ? (url, signal) => api.fetchUrl(url, signal) : undefined,
          {
            get: () => this.context.workspaceState.get('carrot.projectCommands.v1', []),
            set: commands => this.context.workspaceState.update('carrot.projectCommands.v1', commands),
          },
        ),
        turn: (systemPrompt, messages) => api.runAgentTurn({
          modelId, localOnly, systemPrompt, messages, signal: controller.signal,
          onMetadata: debugAgent ? metadata => this.debugLine(`provider selectedModel=${metadata.selectedModelId ?? 'unknown'} provider=${metadata.provider ?? 'unknown'} localOnly=${metadata.localOnly ?? 'unknown'} protocol=${metadata.protocol ?? 'unknown'}`) : undefined,
        }),
        context: {
          signal: controller.signal,
          approve: (definition, summary) => this.approveTool(definition, summary),
        },
        onActivity: activity => { void this.post({ type: 'agentActivity', activity }); },
        onDebug: debugAgent ? message => this.debugLine(message) : undefined,
        modelId,
        localOnly,
        alternativeModels: selectableChatModels(models, localOnly).map(model => model.id),
        requiresWorkspaceEvidence: true,
        requiresLiveWeb: requiresLiveWeb(prompt),
        maxIterations,
        maxDurationMs,
      });
      const result = await loop.run(agentPrompt);
      await this.recordCompatibility(modelId, completedCompatibility(result.metrics));
      await api.appendSessionMessage(sessionId, 'user', prompt, modelId);
      await api.appendSessionMessage(sessionId, 'assistant', result.final, modelId);
      await this.post({ type: 'streamChunk', chunk: result.final });
      const changedFiles = result.toolResults.flatMap(item => {
        const resultValue = item.result as { changedFiles?: unknown } | undefined;
        return Array.isArray(resultValue?.changedFiles) ? resultValue.changedFiles : [];
      });
      if (changedFiles.length) await this.post({ type: 'changedFiles', files: changedFiles });
      await this.post({ type: 'agentComplete', status: 'complete', label: 'Completed' });
      await this.refresh();
    } catch (error) {
      if (controller.signal.aborted) {
        await this.post({ type: 'agentActivity', activity: { status: 'cancelled', label: 'Agent task stopped; applied changes were preserved.' } });
        await this.post({ type: 'notice', message: 'Agent task stopped. Any already-applied changes were preserved.' });
      } else {
        if (activeModelId) await this.recordCompatibility(activeModelId, failedCompatibility(error));
        await this.post({ type: 'agentComplete', status: 'failed', label: 'Task failed' });
        throw error;
      }
    } finally {
      this.currentAgent = undefined;
      await this.post({ type: 'busy', value: false });
    }
  }

  private async recordCompatibility(modelId: string, record: ReturnType<typeof completedCompatibility>): Promise<void> {
    const key = 'carrot.agentCompatibility.v1';
    const current = this.context.globalState.get<AgentCompatibilityMap>(key);
    await this.context.globalState.update(key, withCompatibility(current, modelId, record));
  }

  private async approveTool(definition: ToolDefinition, summary: string): Promise<boolean> {
    const risk = definition.risk === OperationRisk.HIGH_RISK ? 'High-risk' : 'Workspace change';
    const choice = await vscode.window.showWarningMessage(
      `${risk}: ${summary}`,
      { modal: true },
      definition.risk === OperationRisk.HIGH_RISK ? 'Approve High-Risk Action' : 'Approve',
    );
    return choice === 'Approve' || choice === 'Approve High-Risk Action';
  }

  private debugTool(event: ToolDebugEvent): void {
    this.debugLine(JSON.stringify(event));
  }

  private debugLine(message: string): void {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel('Carrot AI');
      this.context.subscriptions.push(this.outputChannel);
    }
    this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  async testAgentTools(): Promise<void> {
    if (!this.view) throw new Error('Open the Carrot AI sidebar before testing agent tools.');
    await this.sendAgentMessage('Find package.json in the current workspace. Use workspace tools to locate it, read the relevant package.json, and return its project name. Do not modify files.');
  }

  private async addContext(kind: 'currentFile' | 'selection' | 'file'): Promise<void> {
    if (kind === 'selection') {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) throw new Error('Select text in a workspace file first.');
      const owned = this.ownedDocument(editor.document);
      this.addPendingContext(`${owned.label} (selection)`, editor.document.getText(editor.selection).slice(0, 20_000));
    } else if (kind === 'currentFile') {
      const editor = vscode.window.activeTextEditor;
      if (!editor) throw new Error('Open a workspace file first.');
      const owned = this.ownedDocument(editor.document);
      this.addPendingContext(owned.label, editor.document.getText().slice(0, 100_000));
    } else {
      const files = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/dist/**,**/.git/**,**/.env*}', 2_000);
      const choices = files.map(uri => ({ uri, label: vscode.workspace.asRelativePath(uri, false) })).filter(item => !isSensitiveFile(item.label));
      const picked = await vscode.window.showQuickPick(choices, { placeHolder: 'Choose a workspace file to add as context', matchOnDescription: true });
      if (!picked) return;
      const bytes = await vscode.workspace.fs.readFile(picked.uri);
      if (bytes.byteLength > 100_000) throw new Error('Selected file exceeds the 100 KB context limit.');
      this.addPendingContext(picked.label, new TextDecoder().decode(bytes));
    }
    await this.postContextState();
  }

  private ownedDocument(document: vscode.TextDocument): { label: string } {
    if (document.uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(document.uri)) throw new Error('The active file is outside the opened workspace.');
    const label = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
    if (isSensitiveFile(label)) throw new Error('Sensitive files cannot be added to Carrot context.');
    return { label };
  }

  private addPendingContext(label: string, content: string): void {
    if (this.pendingContexts.length >= 5) throw new Error('Remove a context item before adding another.');
    this.pendingContexts.push({ id: crypto.randomUUID(), label, content });
  }

  private contextText(): string {
    return this.pendingContexts.map(item => `--- ${item.label} ---\n${item.content}`).join('\n\n').slice(0, 100_000);
  }

  private contextLabels(): Array<{ id: string; label: string }> { return this.pendingContexts.map(({ id, label }) => ({ id, label })); }
  private async postContextState(): Promise<void> { await this.post({ type: 'contextState', contexts: this.contextLabels() }); }

  async startNewChat(): Promise<void> {
    if (this.newChatInFlight) return this.newChatInFlight;
    this.cancelCurrentAgent();
    await this.post({ type: 'conversationReset' });
    this.newChatInFlight = this.ensureNewChat();
    try {
      await this.newChatInFlight;
    } finally {
      this.newChatInFlight = undefined;
    }
  }

  async showHistory(): Promise<void> {
    this.cancelCurrentAgent();
    await this.post({ type: 'showHistory' });
  }

  private cancelCurrentAgent(): void {
    if (!this.currentAgent) return;
    this.currentAgent.abort();
    void this.post({ type: 'agentStopped' });
  }

  private async ensureNewChat(): Promise<void> {
    const api = this.client();
    const currentSessionId = this.context.workspaceState.get<string>(SESSION_KEY);
    if (currentSessionId) {
      const currentSession = await api.getSession(currentSessionId);
      if (!hasConversationMessages(currentSession.messages)) {
        await this.refresh();
        return;
      }
    } else {
      const recentSession = (await api.getSessions())[0];
      if (recentSession) {
        const details = await api.getSession(recentSession.id);
        if (!hasConversationMessages(details.messages)) {
          await this.context.workspaceState.update(SESSION_KEY, details.id);
          await this.refresh();
          return;
        }
      }
    }

    const modelId = this.context.globalState.get<string>(MODEL_KEY) ?? DEFAULT_EXTENSION_MODEL_ID;
    const sessionId = await api.createSession(modelId);
    await this.context.workspaceState.update(SESSION_KEY, sessionId);
    await this.refresh();
  }

  private async deleteSession(sessionId: string): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
      'Permanently delete this Carrot AI chat?',
      { modal: true },
      'Delete',
    );
    if (confirmation !== 'Delete') return;
    await this.client().deleteSession(sessionId);
    if (this.context.workspaceState.get<string>(SESSION_KEY) === sessionId) {
      await this.context.workspaceState.update(SESSION_KEY, undefined);
    }
    await this.refresh();
  }

  private async clearHistory(): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
      'Permanently delete all of your Carrot AI chat history?',
      { modal: true },
      'Delete All',
    );
    if (confirmation !== 'Delete All') return;
    await this.client().clearChatHistory();
    await this.context.workspaceState.update(SESSION_KEY, undefined);
    await this.refresh();
  }

  private async postState(state: Record<string, unknown>): Promise<void> {
    await this.post({
      type: 'state',
      state: { ...state, webSearch: this.context.workspaceState.get<boolean>(WEB_SEARCH_KEY, false), contexts: this.contextLabels(), workspaceName: vscode.workspace.name ?? 'No workspace' },
    });
  }

  private async post(message: Record<string, unknown>): Promise<void> {
    await this.view?.webview.postMessage(message);
  }
}

function formatError(error: unknown): string {
  if (error instanceof CarrotClientError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected Carrot sidebar error.';
}
