import * as vscode from 'vscode';
import { CarrotClient, CarrotClientError } from './carrotClient';
import { CarrotModel, selectableChatModels, validateModelSelection } from './modelPolicy';
import { CARROT_VIEW_ID, CarrotSidebarProvider, MODEL_KEY, SESSION_KEY, TOKEN_KEY } from './sidebarProvider';
import { AgentLoop, looksLikeProjectTask } from './agentLoop';
import { createWorkspaceToolRegistry } from './workspaceTools';

export function activate(context: vscode.ExtensionContext): void {
  const configuration = () => vscode.workspace.getConfiguration('carrot');
  const selectedModel = () => context.globalState.get<string>(MODEL_KEY)
    ?? configuration().get<string>('modelId', 'auto');
  const localOnly = () => configuration().get<boolean>('localOnly', true);
  const client = () => new CarrotClient({
    baseUrl: configuration().get<string>('backendUrl', 'http://localhost:3000/api'),
    modelId: selectedModel(),
    getToken: async () => context.secrets.get(TOKEN_KEY),
  });
  const sidebar = new CarrotSidebarProvider(context, client);
  const debugChannel = vscode.window.createOutputChannel('Carrot AI Agent');
  context.subscriptions.push(debugChannel);
  const debug = (message: string) => {
    if (configuration().get<boolean>('debugAgent', false)) debugChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CARROT_VIEW_ID, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('carrot.open', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.carrot');
    }),
    vscode.commands.registerCommand('carrot.showHistory', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.carrot');
      await sidebar.showHistory();
    }),
    vscode.commands.registerCommand('carrot.login', async () => {
      const email = await vscode.window.showInputBox({ prompt: 'Carrot AI email', ignoreFocusOut: true });
      if (!email) return;
      const password = await vscode.window.showInputBox({ prompt: 'Carrot AI password', password: true, ignoreFocusOut: true });
      if (!password) return;
      try {
        const result = await client().login(email, password);
        await context.secrets.store(TOKEN_KEY, result.accessToken);
        void vscode.window.showInformationMessage(`Signed in to Carrot AI as ${result.user.email}.`);
        await sidebar.refresh();
      } catch (error) { showError(error); }
    }),
    vscode.commands.registerCommand('carrot.logout', async () => {
      await context.secrets.delete(TOKEN_KEY);
      await context.workspaceState.update(SESSION_KEY, undefined);
      void vscode.window.showInformationMessage('Signed out of Carrot AI.');
      await sidebar.refresh();
    }),
    vscode.commands.registerCommand('carrot.selectModel', async () => {
      try {
        const models = await client().getModels();
        const picked = await vscode.window.showQuickPick(
          modelItems(selectableChatModels(models, localOnly())),
          {
            placeHolder: localOnly()
              ? 'Select Auto or an available local chat model'
              : 'Select Auto or an available chat model',
            matchOnDescription: true,
          },
        );
        if (!picked?.modelId) return;
        await context.globalState.update(MODEL_KEY, picked.modelId);
        await context.workspaceState.update(SESSION_KEY, undefined);
        void vscode.window.showInformationMessage(`Carrot AI model set to ${picked.label}. A new chat will start.`);
        await sidebar.refresh();
      } catch (error) { showError(error); }
    }),
    vscode.commands.registerCommand('carrot.refreshModels', async () => {
      try {
        const models = await client().getModels(true);
        const available = selectableChatModels(models, localOnly());
        validateModelSelection(models, selectedModel(), localOnly());
        void vscode.window.showInformationMessage(`Carrot AI found ${available.length} available chat model(s).`);
        await sidebar.refresh();
      } catch (error) { showError(error); }
    }),
    vscode.commands.registerCommand('carrot.testAgentTools', async () => {
      try {
        await vscode.commands.executeCommand('workbench.view.extension.carrot');
        await sidebar.testAgentTools();
        void vscode.window.showInformationMessage('Carrot AI agent-tool self-test completed.');
      } catch (error) { showError(error); }
    }),
    vscode.commands.registerCommand('carrot.toggleLocalOnly', async () => {
      const enabled = !localOnly();
      await configuration().update('localOnly', enabled, vscode.ConfigurationTarget.Global);
      if (enabled) {
        try {
          validateModelSelection(await client().getModels(), selectedModel(), true);
        } catch {
          await context.globalState.update(MODEL_KEY, 'auto');
          await context.workspaceState.update(SESSION_KEY, undefined);
        }
      }
      void vscode.window.showInformationMessage(`Carrot AI Local Only mode is now ${enabled ? 'ON' : 'OFF'}.`);
      await sidebar.refresh();
    }),
    vscode.commands.registerCommand('carrot.newChat', async () => {
      try {
        await sidebar.startNewChat();
        void vscode.window.showInformationMessage('Carrot AI new chat is ready.');
      } catch (error) { showError(error); }
    }),
    vscode.commands.registerCommand('carrot.deleteCurrentChat', async () => {
      const sessionId = context.workspaceState.get<string>(SESSION_KEY);
      if (!sessionId) {
        void vscode.window.showInformationMessage('There is no current Carrot AI chat to delete.');
        return;
      }
      const confirmation = await vscode.window.showWarningMessage(
        'Permanently delete the current Carrot AI chat?',
        { modal: true },
        'Delete',
      );
      if (confirmation !== 'Delete') return;
      try {
        await client().deleteSession(sessionId);
        await context.workspaceState.update(SESSION_KEY, undefined);
        void vscode.window.showInformationMessage('Deleted the current Carrot AI chat.');
        await sidebar.refresh();
      } catch (error) { showError(error); }
    }),
    vscode.commands.registerCommand('carrot.clearChatHistory', async () => {
      const confirmation = await vscode.window.showWarningMessage(
        'Permanently delete all of your Carrot AI chat history?',
        { modal: true },
        'Delete All',
      );
      if (confirmation !== 'Delete All') return;
      try {
        const deletedCount = await client().clearChatHistory();
        await context.workspaceState.update(SESSION_KEY, undefined);
        void vscode.window.showInformationMessage(`Deleted ${deletedCount} Carrot AI chat(s).`);
        await sidebar.refresh();
      } catch (error) { showError(error); }
    }),
  );

  const participant = vscode.chat.createChatParticipant('carrot.agent', async (request, _chatContext, stream, token) => {
    if (!await context.secrets.get(TOKEN_KEY)) {
      stream.markdown('Sign in first with the **Carrot AI: Sign In** command, then ask `@carrot` again.');
      return;
    }
    try {
      const api = client();
      const modelId = selectedModel();
      const models = await api.getModels();
      validateModelSelection(models, modelId, localOnly());
      let sessionId = context.workspaceState.get<string>(SESSION_KEY);
      if (!sessionId) {
        sessionId = await api.createSession(modelId);
        await context.workspaceState.update(SESSION_KEY, sessionId);
      }
      if (looksLikeProjectTask(request.prompt) && vscode.workspace.workspaceFolders?.length) {
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        try {
          const loop = new AgentLoop({
            registry: createWorkspaceToolRegistry(),
            turn: (systemPrompt, messages) => api.runAgentTurn({
              modelId, localOnly: localOnly(), systemPrompt, messages, signal: controller.signal,
              onMetadata: metadata => debug(`provider selectedModel=${metadata.selectedModelId ?? 'unknown'} provider=${metadata.provider ?? 'unknown'} localOnly=${metadata.localOnly ?? 'unknown'} protocol=${metadata.protocol ?? 'unknown'}`),
            }),
            context: {
              signal: controller.signal,
              approve: async (definition, summary) => {
                const choice = await vscode.window.showWarningMessage(
                  `${definition.risk}: ${summary}`,
                  { modal: true },
                  'Approve',
                );
                return choice === 'Approve';
              },
            },
            onActivity: activity => stream.progress(activity.label),
            onDebug: debug,
            modelId,
            localOnly: localOnly(),
            alternativeModels: selectableChatModels(models, localOnly()).map(model => model.id),
            requiresWorkspaceEvidence: true,
            maxIterations: configuration().get<number>('agentMaxToolCalls', 20),
            maxDurationMs: configuration().get<number>('agentTimeoutMinutes', 15) * 60_000,
          });
          const result = await loop.run(request.prompt);
          await api.appendSessionMessage(sessionId, 'user', request.prompt, modelId);
          await api.appendSessionMessage(sessionId, 'assistant', result.final, modelId);
          if (!token.isCancellationRequested) stream.markdown(result.final);
          return;
        } finally {
          cancellation.dispose();
        }
      }
      const response = await api.sendChat(request.prompt, { modelId, sessionId, localOnly: localOnly() });
      if (!token.isCancellationRequested) stream.markdown(response);
    } catch (error) {
      stream.markdown(`Carrot AI error: ${formatError(error)}\n\nUse **Carrot AI: Select Model** to choose another model.`);
    }
  });
  participant.iconPath = new vscode.ThemeIcon('comment-discussion');
  context.subscriptions.push(participant);
}

interface ModelQuickPickItem extends vscode.QuickPickItem { modelId?: string; }

function modelItems(models: CarrotModel[]): ModelQuickPickItem[] {
  const items: ModelQuickPickItem[] = [
    { label: 'Auto', description: 'Deterministic local-first selection', modelId: 'auto' },
  ];
  for (const location of ['local', 'cloud'] as const) {
    const group = models.filter((model) => model.location === location);
    if (!group.length) continue;
    items.push({
      label: location === 'local' ? 'Local models' : 'Cloud models',
      kind: vscode.QuickPickItemKind.Separator,
    });
    items.push(...group.map((model) => ({
      label: model.name,
      description: `${model.provider} · ${model.model}`,
      modelId: model.id,
    })));
  }
  return items;
}

function showError(error: unknown): void {
  void vscode.window.showErrorMessage(`Carrot AI: ${formatError(error)}`);
}

function formatError(error: unknown): string {
  if (error instanceof CarrotClientError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected extension error.';
}

export function deactivate(): void {}
