export type SidebarMessage =
  | { type: 'ready' }
  | { type: 'signIn' }
  | { type: 'signOut' }
  | { type: 'refreshModels' }
  | { type: 'testAgentTools' }
  | { type: 'selectModel'; modelId: string }
  | { type: 'toggleLocalOnly'; enabled: boolean }
  | { type: 'sendMessage'; prompt: string; mode: 'ask' | 'agent'; webSearch: boolean }
  | { type: 'setWebSearch'; enabled: boolean }
  | { type: 'addContext'; kind: 'currentFile' | 'selection' | 'file' }
  | { type: 'removeContext'; contextId: string }
  | { type: 'newChat' }
  | { type: 'openSession'; sessionId: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'clearHistory' }
  | { type: 'openSettings' }
  | { type: 'stopAgent' }
  | { type: 'copyCode'; code: string }
  | { type: 'openExternal'; url: string };

const SIMPLE_TYPES = new Set([
  'ready', 'signIn', 'signOut', 'refreshModels', 'testAgentTools', 'newChat', 'clearHistory', 'openSettings', 'stopAgent',
]);

export function parseSidebarMessage(value: unknown): SidebarMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== 'string') return undefined;
  if (SIMPLE_TYPES.has(record.type)) return { type: record.type } as SidebarMessage;
  if (record.type === 'toggleLocalOnly' && typeof record.enabled === 'boolean') {
    return { type: record.type, enabled: record.enabled };
  }
  if (record.type === 'setWebSearch' && typeof record.enabled === 'boolean') return { type: record.type, enabled: record.enabled };
  if (record.type === 'addContext' && (record.kind === 'currentFile' || record.kind === 'selection' || record.kind === 'file')) return { type: record.type, kind: record.kind };
  if (record.type === 'removeContext' && safeText(record.contextId, 100)) return { type: record.type, contextId: record.contextId as string };
  if (record.type === 'selectModel' && safeText(record.modelId, 300)) {
    return { type: record.type, modelId: record.modelId as string };
  }
  if (record.type === 'sendMessage' && safeText(record.prompt, 100_000)
    && (record.mode === 'ask' || record.mode === 'agent') && typeof record.webSearch === 'boolean') {
    return { type: record.type, prompt: (record.prompt as string).trim(), mode: record.mode, webSearch: record.webSearch };
  }
  if ((record.type === 'openSession' || record.type === 'deleteSession') && safeText(record.sessionId, 200)) {
    return { type: record.type, sessionId: record.sessionId as string };
  }
  if (record.type === 'copyCode' && typeof record.code === 'string' && record.code.length <= 100_000) {
    return { type: record.type, code: record.code };
  }
  if (record.type === 'openExternal' && safeText(record.url, 2_000)) {
    try {
      const url = new URL(record.url as string);
      if (url.protocol === 'https:' || url.protocol === 'http:') return { type: record.type, url: url.toString() };
    } catch { return undefined; }
  }
  return undefined;
}

function safeText(value: unknown, maxLength: number): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}
