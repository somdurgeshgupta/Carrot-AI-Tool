import assert from 'node:assert/strict';
import test from 'node:test';
import { CarrotClient, CarrotClientError } from './carrotClient';

const token = async () => 'test-token';

test('sends an authenticated non-streaming chat request', async () => {
  let request: Request | undefined;
  const client = new CarrotClient({
    baseUrl: 'http://localhost:3000/api/',
    modelId: 'local:qwen3:8b',
    getToken: token,
    fetchImplementation: async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Hello from Carrot' } }] }), { status: 200 });
    },
  });

  assert.equal(await client.sendChat('hello'), 'Hello from Carrot');
  assert.equal(request?.url, 'http://localhost:3000/api/chat/completions');
  assert.equal(request?.headers.get('authorization'), 'Bearer test-token');
});

test('does not send a request without a token', async () => {
  const client = new CarrotClient({
    baseUrl: 'http://localhost:3000/api',
    modelId: 'local:qwen3:8b',
    getToken: async () => undefined,
  });
  await assert.rejects(() => client.sendChat('hello'), CarrotClientError);
});

test('reports malformed backend responses', async () => {
  const client = new CarrotClient({
    baseUrl: 'http://localhost:3000/api',
    modelId: 'local:qwen3:8b',
    getToken: token,
    fetchImplementation: async () => new Response('{}', { status: 200 }),
  });
  await assert.rejects(() => client.sendChat('hello'), CarrotClientError);
});

test('reports authentication failures without exposing credentials', async () => {
  const client = new CarrotClient({
    baseUrl: 'http://localhost:3000/api',
    modelId: 'local:qwen3:8b',
    getToken: token,
    fetchImplementation: async () => new Response(JSON.stringify({ message: 'Invalid email or password credentials.' }), { status: 401 }),
  });
  await assert.rejects(() => client.login('user@example.com', 'secret-value'), /Invalid email or password/);
});

test('reports an unavailable backend', async () => {
  const client = new CarrotClient({
    baseUrl: 'http://localhost:3000/api',
    modelId: 'local:qwen3:8b',
    getToken: token,
    fetchImplementation: async () => { throw new TypeError('connect failed'); },
  });
  await assert.rejects(() => client.sendChat('hello'), /backend is unavailable/);
});

test('cancels a request after the configured timeout', async () => {
  const client = new CarrotClient({
    baseUrl: 'http://localhost:3000/api',
    modelId: 'local:qwen3:8b',
    getToken: token,
    timeoutMs: 5,
    fetchImplementation: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
  });
  await assert.rejects(() => client.sendChat('hello'), /timed out/);
});

test('cancels an in-flight agent turn from the caller signal', async () => {
  const controller = new AbortController();
  const client = new CarrotClient({
    baseUrl: 'http://localhost:3000/api',
    modelId: 'local:qwen3:8b',
    getToken: token,
    fetchImplementation: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      controller.abort();
    }),
  });
  await assert.rejects(() => client.runAgentTurn({
    modelId: 'local:qwen3:8b', localOnly: true, systemPrompt: 'tools',
    messages: [{ role: 'user', content: 'inspect' }], signal: controller.signal,
  }), /cancelled/);
});

test('loads the normalized model registry with an authenticated refresh', async () => {
  let request: Request | undefined;
  const client = new CarrotClient({
    baseUrl: 'http://localhost:3000/api',
    modelId: 'auto',
    getToken: token,
    fetchImplementation: async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({
        models: [{
          id: 'local:qwen3:8b',
          model: 'qwen3:8b',
          name: 'Qwen 3 (8B)',
          provider: 'ollama',
          location: 'local',
          type: 'chat',
          available: true,
        }],
      }), { status: 200 });
    },
  });
  assert.equal((await client.getModels(true))[0].id, 'local:qwen3:8b');
  assert.equal(request?.url, 'http://localhost:3000/api/models?refresh=true');
  assert.equal(request?.headers.get('authorization'), 'Bearer test-token');
});

test('clears authenticated chat history explicitly', async () => {
  let request: Request | undefined;
  const client = new CarrotClient({
    baseUrl: 'http://localhost:3000/api',
    modelId: 'auto',
    getToken: token,
    fetchImplementation: async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ success: true, deletedCount: 3 }), { status: 200 });
    },
  });
  assert.equal(await client.clearChatHistory(), 3);
  assert.equal(request?.method, 'DELETE');
  assert.equal(request?.url, 'http://localhost:3000/api/sessions');
});

test('loads persisted session history and an owned conversation', async () => {
  const responses = [
    new Response(JSON.stringify([{ id: 'session-1', title: 'Greeting', modelId: 'auto', createdAt: '', updatedAt: '' }])),
    new Response(JSON.stringify({
      id: 'session-1',
      title: 'Greeting',
      modelId: 'auto',
      createdAt: '',
      updatedAt: '',
      messages: [{ id: 'message-1', role: 'user', content: 'hello', createdAt: '' }],
    })),
  ];
  const client = new CarrotClient({
    baseUrl: 'http://localhost:3000/api',
    modelId: 'auto',
    getToken: token,
    fetchImplementation: async () => responses.shift()!,
  });
  assert.equal((await client.getSessions())[0].title, 'Greeting');
  assert.equal((await client.getSession('session-1')).messages?.[0].content, 'hello');
});

test('streams the existing backend SSE protocol incrementally', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  });
  const chunks: string[] = [];
  const client = new CarrotClient({
    baseUrl: 'http://localhost:3000/api',
    modelId: 'auto',
    getToken: token,
    fetchImplementation: async () => new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
  });
  const result = await client.sendChatStream('hello', { modelId: 'auto', localOnly: true }, chunk => chunks.push(chunk));
  assert.equal(result, 'Hello');
  assert.deepEqual(chunks, ['Hel', 'lo']);
});

test('preserves Local Only on every agent turn without exposing tokens in the payload', async () => {
  let request: Request | undefined;
  let metadata: any;
  const client = new CarrotClient({
    baseUrl: 'http://localhost:3000/api',
    modelId: 'auto',
    getToken: token,
    fetchImplementation: async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"type":"final","content":"done"}' } }], carrotAgent: { selectedModelId: 'local:qwen3:8b', provider: 'ollama', localOnly: true, protocol: 'structured-json' } }));
    },
  });
  await client.runAgentTurn({
    modelId: 'auto',
    localOnly: true,
    systemPrompt: 'tools',
    messages: [{ role: 'user', content: 'inspect' }],
    onMetadata: value => { metadata = value; },
  });
  const body = JSON.parse(await request!.clone().text());
  assert.equal(body.localOnly, true);
  assert.equal(request!.url, 'http://localhost:3000/api/agent/turn');
  assert.equal(Object.hasOwn(body, 'agentTask'), false);
  assert.equal(JSON.stringify(body).includes('test-token'), false);
  assert.deepEqual(metadata, { selectedModelId: 'local:qwen3:8b', provider: 'ollama', localOnly: true, protocol: 'structured-json' });
});

test('calls the authenticated bounded agent web-search endpoint', async () => {
  let request: Request | undefined;
  const client = new CarrotClient({
    baseUrl: 'http://localhost:3000/api', modelId: 'auto', getToken: token,
    fetchImplementation: async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ query: 'Angular release', results: '[NPM]: 21.0.0' }));
    },
  });
  assert.deepEqual(await client.webSearch('Angular release'), { query: 'Angular release', results: '[NPM]: 21.0.0' });
  assert.equal(request?.url, 'http://localhost:3000/api/agent/web-search');
  assert.equal(request?.headers.get('authorization'), 'Bearer test-token');
  assert.deepEqual(JSON.parse(await request!.clone().text()), { query: 'Angular release' });
});
