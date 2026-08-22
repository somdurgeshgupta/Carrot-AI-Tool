import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, Queue, Worker } from 'bullmq';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Repository } from 'typeorm';
import { RedisCacheService } from '../cache/redis-cache.service';
import {
  IngestionJobEntity,
  IngestionJobStatus,
  IngestionJobType,
} from '../entities/ingestion-job.entity';
import { RagService } from './rag.service';

type IngestionPayload =
  | {
      type: IngestionJobType.FILE;
      userId: string;
      fileName: string;
      mimeType: string;
      stagedPath: string;
    }
  | { type: IngestionJobType.WEBSITE; userId: string; url: string }
  | { type: IngestionJobType.SITEMAP; userId: string; url: string };

@Injectable()
export class IngestionQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngestionQueueService.name);
  private readonly stagingRoot = path.resolve(
    __dirname,
    '..',
    '..',
    'uploads',
    '.ingestion',
  );
  private queue?: Queue<IngestionPayload>;
  private worker?: Worker<IngestionPayload>;

  constructor(
    @InjectRepository(IngestionJobEntity)
    private readonly jobs: Repository<IngestionJobEntity>,
    private readonly rag: RagService,
    private readonly cache: RedisCacheService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (
      this.config.get<string>('REDIS_ENABLED', 'true').toLowerCase() === 'false'
    ) {
      this.logger.warn(
        'Ingestion queue is disabled because Redis is disabled.',
      );
      return;
    }
    const redisUrl = new URL(
      this.config.get<string>('REDIS_URL', 'redis://127.0.0.1:6379'),
    );
    const connection = {
      host: redisUrl.hostname,
      port: Number(redisUrl.port || 6379),
      username: redisUrl.username || undefined,
      password: redisUrl.password || undefined,
      db: Number(redisUrl.pathname.slice(1) || 0),
      ...(redisUrl.protocol === 'rediss:' ? { tls: {} } : {}),
      maxRetriesPerRequest: null,
    };
    this.queue = new Queue<IngestionPayload>('carrot-ingestion', {
      connection,
      defaultJobOptions: {
        attempts: this.positiveInteger('INGESTION_MAX_ATTEMPTS', 3),
        backoff: {
          type: 'exponential',
          delay: this.positiveInteger('INGESTION_RETRY_BASE_MS', 1_000),
        },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    });
    this.worker = new Worker<IngestionPayload>(
      'carrot-ingestion',
      (job) => this.process(job),
      {
        connection,
        concurrency: this.positiveInteger('INGESTION_CONCURRENCY', 2),
      },
    );
    this.worker.on(
      'failed',
      (job, error) => void this.recordFailure(job, error),
    );
    this.worker.on('error', (error) =>
      this.logger.warn(`Ingestion worker unavailable: ${error.message}`),
    );
    await fs.mkdir(this.stagingRoot, { recursive: true });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  async enqueueFile(
    userId: string,
    fileName: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<IngestionJobEntity> {
    const record = await this.createRecord(
      userId,
      IngestionJobType.FILE,
      fileName,
    );
    const jobDir = path.join(this.stagingRoot, record.id);
    const stagedPath = path.join(jobDir, path.basename(fileName));
    try {
      this.assertQueueAvailable();
      await fs.mkdir(jobDir, { recursive: true });
      await fs.writeFile(stagedPath, buffer, { flag: 'wx' });
      await this.queue!.add(
        'file',
        { type: IngestionJobType.FILE, userId, fileName, mimeType, stagedPath },
        { jobId: record.id },
      );
      return record;
    } catch (error: unknown) {
      await this.failBeforeQueue(record, error);
      await this.cleanupStagedPath(stagedPath);
      throw new ServiceUnavailableException(
        'Knowledge ingestion is temporarily unavailable; chat and retrieval remain available.',
      );
    }
  }

  async enqueueWebsite(
    userId: string,
    url: string,
  ): Promise<IngestionJobEntity> {
    const record = await this.createRecord(
      userId,
      IngestionJobType.WEBSITE,
      url,
    );
    try {
      this.assertQueueAvailable();
      await this.queue!.add(
        'website',
        { type: IngestionJobType.WEBSITE, userId, url },
        { jobId: record.id },
      );
      return record;
    } catch (error: unknown) {
      await this.failBeforeQueue(record, error);
      throw new ServiceUnavailableException(
        'Knowledge ingestion is temporarily unavailable; chat and retrieval remain available.',
      );
    }
  }

  async enqueueSitemap(
    userId: string,
    url: string,
  ): Promise<IngestionJobEntity> {
    const record = await this.createRecord(
      userId,
      IngestionJobType.SITEMAP,
      url,
    );
    try {
      this.assertQueueAvailable();
      await this.queue!.add(
        'sitemap',
        { type: IngestionJobType.SITEMAP, userId, url },
        { jobId: record.id },
      );
      return record;
    } catch (error: unknown) {
      await this.failBeforeQueue(record, error);
      throw new ServiceUnavailableException(
        'Knowledge ingestion is temporarily unavailable; chat and retrieval remain available.',
      );
    }
  }

  async getJob(userId: string, jobId: string): Promise<IngestionJobEntity> {
    const record = await this.jobs.findOne({ where: { id: jobId, userId } });
    if (!record) throw new NotFoundException('Ingestion job not found');
    return record;
  }

  async cancelJob(userId: string, jobId: string): Promise<IngestionJobEntity> {
    const record = await this.getJob(userId, jobId);
    if (
      [
        IngestionJobStatus.COMPLETED,
        IngestionJobStatus.FAILED,
        IngestionJobStatus.CANCELLED,
      ].includes(record.status)
    )
      return record;
    record.cancelRequested = true;
    const queued = await this.queue?.getJob(jobId);
    const state = await queued?.getState();
    if (queued && state !== 'active') {
      await queued.remove();
      record.status = IngestionJobStatus.CANCELLED;
      record.completedAt = new Date();
    }
    return this.jobs.save(record);
  }

  private async process(
    job: Job<IngestionPayload>,
  ): Promise<Record<string, unknown>> {
    const record = await this.jobs.findOne({ where: { id: String(job.id) } });
    if (!record || record.cancelRequested) {
      if (record)
        await this.jobs.update(record.id, {
          status: IngestionJobStatus.CANCELLED,
          completedAt: new Date(),
        });
      return { cancelled: true };
    }
    await this.jobs.update(record.id, {
      status: IngestionJobStatus.PROCESSING,
      progress: 10,
      attempts: job.attemptsMade + 1,
      startedAt: record.startedAt || new Date(),
      errorMessage: null,
    });
    await job.updateProgress(10);
    let result: Record<string, unknown>;
    try {
      if (job.data.type === IngestionJobType.FILE) {
        const buffer = await fs.readFile(
          this.validatedStagedPath(job.data.stagedPath),
        );
        await job.updateProgress(30);
        result = await this.rag.indexDocument(
          job.data.userId,
          job.data.fileName,
          buffer,
          job.data.mimeType,
          undefined,
          () => this.isCancelRequested(record.id),
        );
        await this.cleanupStagedPath(job.data.stagedPath);
      } else if (job.data.type === IngestionJobType.WEBSITE) {
        await job.updateProgress(25);
        result = await this.rag.indexWebsite(
          job.data.userId,
          job.data.url,
          undefined,
          () => this.isCancelRequested(record.id),
        );
      } else {
        await job.updateProgress(20);
        result = await this.rag.indexSitemap(
          job.data.userId,
          job.data.url,
          () => this.isCancelRequested(record.id),
        );
      }
      await job.updateProgress(100);
      Object.assign(record, {
        status: IngestionJobStatus.COMPLETED,
        progress: 100,
        result,
        sourceId: typeof result.sourceId === 'string' ? result.sourceId : null,
        completedAt: new Date(),
      });
      await this.jobs.save(record);
      return result;
    } catch (error) {
      if (await this.isCancelRequested(record.id)) {
        if (job.data.type === IngestionJobType.FILE)
          await this.cleanupStagedPath(job.data.stagedPath);
        await this.jobs.update(record.id, {
          status: IngestionJobStatus.CANCELLED,
          completedAt: new Date(),
          errorMessage: null,
        });
        return { cancelled: true };
      }
      if (
        job.data.type === IngestionJobType.FILE &&
        job.attemptsMade + 1 >= (job.opts.attempts || 1)
      ) {
        await this.cleanupStagedPath(job.data.stagedPath);
      }
      throw error;
    }
  }

  private async recordFailure(
    job: Job<IngestionPayload> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job?.id) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts || 1);
    await this.jobs.update(String(job.id), {
      status: exhausted
        ? IngestionJobStatus.FAILED
        : IngestionJobStatus.RETRYING,
      progress: exhausted ? 100 : 10,
      attempts: job.attemptsMade,
      errorMessage: error.message.slice(0, 2_000),
      completedAt: exhausted ? new Date() : null,
    });
  }

  private async createRecord(
    userId: string,
    type: IngestionJobType,
    inputLabel: string,
  ): Promise<IngestionJobEntity> {
    return this.jobs.save(
      this.jobs.create({
        userId,
        type,
        inputLabel,
        status: IngestionJobStatus.QUEUED,
        progress: 0,
        attempts: 0,
        cancelRequested: false,
        sourceId: null,
        result: null,
        errorMessage: null,
        startedAt: null,
        completedAt: null,
      }),
    );
  }

  private async isCancelRequested(jobId: string): Promise<boolean> {
    const record = await this.jobs.findOne({ where: { id: jobId } });
    return record?.cancelRequested === true;
  }

  private assertQueueAvailable(): void {
    if (!this.queue || !this.cache.status().available)
      throw new Error('Redis queue is unavailable');
  }

  private async failBeforeQueue(
    record: IngestionJobEntity,
    error: unknown,
  ): Promise<void> {
    record.status = IngestionJobStatus.FAILED;
    record.progress = 100;
    record.errorMessage = (
      error instanceof Error ? error.message : 'Queue unavailable'
    ).slice(0, 2_000);
    record.completedAt = new Date();
    await this.jobs.save(record);
  }

  private validatedStagedPath(candidate: string): string {
    const resolved = path.resolve(candidate);
    if (
      resolved !== this.stagingRoot &&
      !resolved.startsWith(`${this.stagingRoot}${path.sep}`)
    )
      throw new Error('Invalid staged ingestion path');
    return resolved;
  }

  private async cleanupStagedPath(candidate: string): Promise<void> {
    try {
      const resolved = this.validatedStagedPath(candidate);
      await fs.rm(path.dirname(resolved), { recursive: true, force: true });
    } catch (error: unknown) {
      this.logger.warn(
        `Could not clean ingestion staging data: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private positiveInteger(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key, String(fallback)));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
}
