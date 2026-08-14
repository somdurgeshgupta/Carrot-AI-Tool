export interface CarrotAuthResponse {
  accessToken: string;
  user: { id: string; email: string; name: string };
}

export interface CarrotClientOptions {
  baseUrl: string;
  modelId: string;
  getToken: () => Promise<string | undefined>;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}

export interface CarrotModel {
  id: string;
  model: string;
  name: string;
  provider: string;
  location: 'local' | 'cloud';
  type: 'chat' | 'embedding';
  available: boolean;
  agentProtocol?: 'structured-json';
  agentToolStatus?: 'untested' | 'tested' | 'failed';
  preferredForCodingAgent?: boolean;
  supportsNativeTools?: boolean;
}

export interface SendChatOptions {
  modelId?: string;
  sessionId?: string;
  localOnly?: boolean;
  context?: string;
  webSearchEnabled?: boolean;
  signal?: AbortSignal;
}

export interface AgentTurnOptions {
  modelId: string;
  localOnly: boolean;
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  signal?: AbortSignal;
  onMetadata?: (metadata: AgentTurnMetadata) => void;
}

export interface AgentTurnMetadata {
  selectedModelId?: string;
  provider?: string;
  localOnly?: boolean;
  protocol?: string;
}

export interface CarrotChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  modelId?: string;
  createdAt: string;
}

export interface CarrotSession {
  id: string;
  title: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
  messages?: CarrotChatMessage[];
}

export class CarrotClientError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'CarrotClientError';
  }
}

export class CarrotClient {
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: CarrotClientOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async login(email: string, password: string): Promise<CarrotAuthResponse> {
    const response = await this.request(this.url('/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = await this.readJson(response);
    if (!response.ok || !this.isAuthResponse(body)) {
      throw new CarrotClientError(this.messageFrom(body, 'Unable to sign in to Carrot AI.'), response.status);
    }
    return body;
  }

  async sendChat(prompt: string, requestOptions: SendChatOptions = {}): Promise<string> {
    const token = await this.options.getToken();
    if (!token) {
      throw new CarrotClientError('Sign in to Carrot AI before sending a chat request.', 401);
    }

    const message = prompt;
    const response = await this.request(this.url('/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        modelId: requestOptions.modelId || this.options.modelId,
        messages: [{ role: 'user', content: message }],
        sessionId: requestOptions.sessionId,
        localOnly: requestOptions.localOnly === true,
        stream: false,
        webSearchEnabled: requestOptions.webSearchEnabled === true,
        workspaceContext: requestOptions.context,
      }),
    });
    const body = await this.readJson(response);
    if (!response.ok) {
      throw new CarrotClientError(this.messageFrom(body, 'Carrot AI could not process the request.'), response.status);
    }

    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new CarrotClientError('Carrot AI returned an unexpected chat response.');
    }
    return content;
  }

  async sendChatStream(
    prompt: string,
    requestOptions: SendChatOptions,
    onChunk: (chunk: string) => void,
  ): Promise<string> {
    const token = await this.options.getToken();
    if (!token) throw new CarrotClientError('Sign in to Carrot AI before sending a chat request.', 401);
    const message = prompt;
    const response = await this.request(this.url('/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        modelId: requestOptions.modelId || this.options.modelId,
        messages: [{ role: 'user', content: message }],
        sessionId: requestOptions.sessionId,
        localOnly: requestOptions.localOnly === true,
        stream: true,
        webSearchEnabled: requestOptions.webSearchEnabled === true,
        workspaceContext: requestOptions.context,
      }),
      signal: requestOptions.signal,
    });
    if (!response.ok || !response.body) {
      const body = await this.readJson(response);
      throw new CarrotClientError(this.messageFrom(body, 'Carrot AI could not start streaming.'), response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';
      for (const event of events) {
        for (const line of event.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let parsed: any;
          try { parsed = JSON.parse(data); } catch { continue; }
          if (typeof parsed?.error === 'string') throw new CarrotClientError(parsed.error);
          const chunk = parsed?.choices?.[0]?.delta?.content ?? parsed?.choices?.[0]?.text;
          if (typeof chunk === 'string' && chunk) {
            content += chunk;
            onChunk(chunk);
          }
        }
      }
      if (done) break;
    }
    if (!content.trim()) throw new CarrotClientError('Carrot AI returned an empty streaming response.');
    return content;
  }

  async runAgentTurn(options: AgentTurnOptions): Promise<string> {
    const response = await this.authenticatedRequest(this.url('/agent/turn'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId: options.modelId,
        localOnly: options.localOnly,
        systemPrompt: options.systemPrompt,
        messages: options.messages,
      }),
      signal: options.signal,
    }, 300_000);
    const body = await this.readJson(response);
    if (!response.ok) throw new CarrotClientError(this.messageFrom(body, 'Carrot agent turn failed.'), response.status);
    if (body?.carrotAgent && typeof body.carrotAgent === 'object') options.onMetadata?.(body.carrotAgent);
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new CarrotClientError('Carrot returned an invalid agent response.');
    return content;
  }

  async webSearch(query: string, signal?: AbortSignal): Promise<{ query: string; results: string }> {
    const response = await this.authenticatedRequest(this.url('/agent/web-search'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }), signal,
    }, 30_000);
    const body = await this.readJson(response);
    if (!response.ok || typeof body?.results !== 'string') throw new CarrotClientError(this.messageFrom(body, 'Carrot web search failed.'), response.status);
    return { query: typeof body.query === 'string' ? body.query : query, results: body.results };
  }

  async appendSessionMessage(sessionId: string, role: 'user' | 'assistant', content: string, modelId?: string): Promise<void> {
    const response = await this.authenticatedRequest(this.url(`/sessions/${encodeURIComponent(sessionId)}/messages`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, content, modelId }),
    });
    if (!response.ok) {
      const body = await this.readJson(response);
      throw new CarrotClientError(this.messageFrom(body, 'Unable to persist the Carrot agent message.'), response.status);
    }
  }

  async getModels(forceRefresh = false): Promise<CarrotModel[]> {
    const response = await this.authenticatedRequest(this.url(`/models${forceRefresh ? '?refresh=true' : ''}`), { method: 'GET' });
    const body = await this.readJson(response);
    if (!response.ok || !Array.isArray(body?.models)) {
      throw new CarrotClientError(this.messageFrom(body, 'Unable to load Carrot models.'), response.status);
    }
    return body.models;
  }

  async createSession(modelId: string): Promise<string> {
    const response = await this.authenticatedRequest(this.url('/sessions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'VS Code Conversation', modelId }),
    });
    const body = await this.readJson(response);
    if (!response.ok || typeof body?.id !== 'string') {
      throw new CarrotClientError(this.messageFrom(body, 'Unable to create a Carrot chat session.'), response.status);
    }
    return body.id;
  }

  async getSessions(): Promise<CarrotSession[]> {
    const response = await this.authenticatedRequest(this.url('/sessions'), { method: 'GET' });
    const body = await this.readJson(response);
    if (!response.ok || !Array.isArray(body)) {
      throw new CarrotClientError(this.messageFrom(body, 'Unable to load Carrot chat history.'), response.status);
    }
    return body;
  }

  async getSession(sessionId: string): Promise<CarrotSession> {
    const response = await this.authenticatedRequest(
      this.url(`/sessions/${encodeURIComponent(sessionId)}`),
      { method: 'GET' },
    );
    const body = await this.readJson(response);
    if (!response.ok || typeof body?.id !== 'string' || !Array.isArray(body?.messages)) {
      throw new CarrotClientError(this.messageFrom(body, 'Unable to load the Carrot chat.'), response.status);
    }
    return body;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const response = await this.authenticatedRequest(this.url(`/sessions/${encodeURIComponent(sessionId)}`), { method: 'DELETE' });
    if (!response.ok) {
      const body = await this.readJson(response);
      throw new CarrotClientError(this.messageFrom(body, 'Unable to delete the Carrot chat session.'), response.status);
    }
  }

  async clearChatHistory(): Promise<number> {
    const response = await this.authenticatedRequest(this.url('/sessions'), { method: 'DELETE' });
    const body = await this.readJson(response);
    if (!response.ok || typeof body?.deletedCount !== 'number') {
      throw new CarrotClientError(this.messageFrom(body, 'Unable to clear Carrot chat history.'), response.status);
    }
    return body.deletedCount;
  }

  private async authenticatedRequest(input: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
    const token = await this.options.getToken();
    if (!token) throw new CarrotClientError('Sign in to Carrot AI before sending a request.', 401);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return this.request(input, { ...init, headers }, timeoutMs);
  }

  private url(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}${path}`;
  }

  private async request(input: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
    const controller = new AbortController();
    const externalSignal = init.signal;
    const abortFromExternal = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs ?? this.options.timeoutMs ?? 120_000);
    try {
      return await this.fetchImplementation(input, { ...init, signal: controller.signal });
    } catch (error) {
      const detail = error instanceof Error && error.name === 'AbortError'
        ? timedOut ? 'The Carrot backend request timed out.' : 'The Carrot request was cancelled.'
        : 'The Carrot backend is unavailable.';
      throw new CarrotClientError(detail);
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortFromExternal);
    }
  }

  private async readJson(response: Response): Promise<any> {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }

  private messageFrom(body: any, fallback: string): string {
    return typeof body?.message === 'string' ? body.message : fallback;
  }

  private isAuthResponse(value: any): value is CarrotAuthResponse {
    return typeof value?.accessToken === 'string'
      && typeof value?.user?.id === 'string'
      && typeof value?.user?.email === 'string';
  }
}
