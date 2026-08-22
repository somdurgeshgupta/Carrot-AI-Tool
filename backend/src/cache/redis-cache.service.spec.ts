import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'node:events';
import Redis from 'ioredis';
import { RedisCacheService } from './redis-cache.service';

class FakeRedis extends EventEmitter {
  connect = jest.fn<Promise<void>, []>();
  quit = jest.fn<Promise<'OK'>, []>().mockResolvedValue('OK');
  disconnect = jest.fn();
  get = jest.fn<Promise<string | null>, [string]>();
  set = jest
    .fn<Promise<'OK'>, [string, string, string, number]>()
    .mockResolvedValue('OK');
  incr = jest.fn<Promise<number>, [string]>().mockResolvedValue(1);
}

function serviceWith(client: FakeRedis, values: Record<string, string> = {}) {
  const config = {
    get: (key: string, fallback: string) => values[key] ?? fallback,
  } as ConfigService;
  return new RedisCacheService(config, () => client as unknown as Redis);
}

test('starts without Redis and recovers automatically when Redis later becomes ready', async () => {
  const client = new FakeRedis();
  client.connect.mockRejectedValueOnce(new Error('connection refused'));
  const cache = serviceWith(client);
  await expect(cache.onModuleInit()).resolves.toBeUndefined();
  expect(cache.status()).toMatchObject({
    enabled: true,
    available: false,
    state: 'reconnecting',
  });
  client.emit('reconnecting', 250);
  client.emit('ready');
  expect(cache.status()).toMatchObject({
    enabled: true,
    available: true,
    state: 'connected',
    metrics: { reconnectAttempts: 1 },
  });
});

test('tracks cache hits, misses, errors, and latency without exposing Redis details', async () => {
  const client = new FakeRedis();
  client.connect.mockImplementation(() => {
    client.emit('ready');
    return Promise.resolve();
  });
  client.get
    .mockResolvedValueOnce('{"ok":true}')
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error('lost'));
  const cache = serviceWith(client);
  await cache.onModuleInit();
  await expect(cache.getJson('hit')).resolves.toEqual({ ok: true });
  await expect(cache.getJson('miss')).resolves.toBeUndefined();
  await expect(cache.getJson('error')).resolves.toBeUndefined();
  expect(cache.status()).toMatchObject({
    available: true,
    metrics: { hits: 1, misses: 1, errors: 1 },
  });
  expect(cache.status().metrics.latencyMs.last).not.toBeNull();
  expect(JSON.stringify(cache.status())).not.toContain('redis://');
});

test('remains a no-op cache when explicitly disabled', async () => {
  const client = new FakeRedis();
  const cache = serviceWith(client, { REDIS_ENABLED: 'false' });
  await cache.onModuleInit();
  expect(client.connect).not.toHaveBeenCalled();
  expect(cache.status()).toMatchObject({
    enabled: false,
    available: false,
    state: 'disabled',
  });
});
