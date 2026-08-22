import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';

export const REDIS_CLIENT_FACTORY = Symbol('REDIS_CLIENT_FACTORY');
export type RedisClientFactory = (url: string, options: RedisOptions) => Redis;
type RedisConnectionState =
  'disabled' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

@Injectable()
export class RedisCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisCacheService.name);
  private client?: Redis;
  private enabled = false;
  private available = false;
  private connectionState: RedisConnectionState = 'disabled';
  private readonly metrics = {
    reconnectAttempts: 0,
    hits: 0,
    misses: 0,
    errors: 0,
    latencySamples: 0,
    latencyTotalMs: 0,
    lastLatencyMs: null as number | null,
  };

  constructor(
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT_FACTORY)
    private readonly createClient: RedisClientFactory,
  ) {}

  async onModuleInit(): Promise<void> {
    if (
      this.config.get<string>('REDIS_ENABLED', 'true').toLowerCase() === 'false'
    ) {
      this.logger.log(
        'Redis cache is disabled; PostgreSQL retrieval remains available.',
      );
      return;
    }
    this.enabled = true;
    this.connectionState = 'connecting';
    const retryBaseMs = this.positiveInteger('REDIS_RETRY_BASE_MS', 250);
    const retryMaxMs = this.positiveInteger('REDIS_RETRY_MAX_MS', 10_000);
    this.client = this.createClient(
      this.config.get<string>('REDIS_URL', 'redis://127.0.0.1:6379'),
      {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: this.positiveInteger('REDIS_CONNECT_TIMEOUT_MS', 1_500),
        retryStrategy: (attempt) =>
          Math.min(retryBaseMs * 2 ** Math.min(attempt - 1, 8), retryMaxMs),
      },
    );
    this.client.on('ready', () => {
      const recovered =
        this.connectionState === 'reconnecting' ||
        this.connectionState === 'disconnected';
      this.available = true;
      this.connectionState = 'connected';
      this.logger.log(
        recovered
          ? 'Redis cache connection recovered.'
          : 'Redis cache connected.',
      );
    });
    this.client.on('reconnecting', () => {
      this.available = false;
      this.connectionState = 'reconnecting';
      this.metrics.reconnectAttempts += 1;
    });
    for (const event of ['close', 'end'] as const)
      this.client.on(event, () => {
        this.available = false;
        this.connectionState = 'disconnected';
      });
    this.client.on('error', (error) => {
      this.available = false;
      this.metrics.errors += 1;
      this.logger.warn(
        `Redis cache unavailable; using PostgreSQL fallback: ${error.message}`,
      );
    });
    try {
      await this.client.connect();
    } catch (error: unknown) {
      this.available = false;
      this.connectionState = 'reconnecting';
      const message =
        error instanceof Error ? error.message : 'connection failed';
      this.logger.warn(
        `Redis unavailable at startup; continuing while reconnecting: ${message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect(false);
    }
  }

  status() {
    const average = this.metrics.latencySamples
      ? Number(
          (this.metrics.latencyTotalMs / this.metrics.latencySamples).toFixed(
            2,
          ),
        )
      : null;
    return {
      enabled: this.enabled,
      available: this.available,
      state: this.connectionState,
      metrics: {
        reconnectAttempts: this.metrics.reconnectAttempts,
        hits: this.metrics.hits,
        misses: this.metrics.misses,
        errors: this.metrics.errors,
        latencyMs: { last: this.metrics.lastLatencyMs, average },
      },
    };
  }

  async getJson<T>(key: string): Promise<T | undefined> {
    if (!this.available || !this.client) return undefined;
    try {
      const value = await this.timed(() => this.client!.get(key));
      if (value === null) {
        this.metrics.misses += 1;
        return undefined;
      }
      this.metrics.hits += 1;
      return JSON.parse(value) as T;
    } catch {
      this.recordOperationError();
      return undefined;
    }
  }

  async setJson(
    key: string,
    value: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    if (!this.available || !this.client) return;
    try {
      await this.timed(() =>
        this.client!.set(key, JSON.stringify(value), 'EX', ttlSeconds),
      );
    } catch {
      this.recordOperationError();
    }
  }

  async getNumber(key: string, fallback = 0): Promise<number> {
    if (!this.available || !this.client) return fallback;
    try {
      const value = await this.timed(() => this.client!.get(key));
      if (value === null) {
        this.metrics.misses += 1;
        return fallback;
      }
      this.metrics.hits += 1;
      return Number(value) || fallback;
    } catch {
      this.recordOperationError();
      return fallback;
    }
  }

  async increment(key: string): Promise<void> {
    if (!this.available || !this.client) return;
    try {
      await this.timed(() => this.client!.incr(key));
    } catch {
      this.recordOperationError();
    }
  }

  private positiveInteger(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key, String(fallback)));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private async timed<T>(operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await operation();
    } finally {
      const latency = Number((performance.now() - started).toFixed(2));
      this.metrics.lastLatencyMs = latency;
      this.metrics.latencyTotalMs += latency;
      this.metrics.latencySamples += 1;
    }
  }

  private recordOperationError(): void {
    this.metrics.errors += 1;
  }
}
