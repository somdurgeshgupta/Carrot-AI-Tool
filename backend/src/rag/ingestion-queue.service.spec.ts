import { ServiceUnavailableException } from '@nestjs/common';
import {
  IngestionJobStatus,
  IngestionJobType,
} from '../entities/ingestion-job.entity';
import { IngestionQueueService } from './ingestion-queue.service';

function repository() {
  return {
    create: jest.fn((value) => ({ id: 'job-1', ...value })),
    save: jest.fn(async (value) => value),
    findOne: jest.fn(),
    update: jest.fn(),
  };
}

describe('IngestionQueueService', () => {
  const config = {
    get: jest.fn((_key: string, fallback: unknown) => fallback),
  };

  it('records a controlled failed job when Redis is unavailable', async () => {
    const jobs = repository();
    const cache = { status: () => ({ available: false }) };
    const service = new IngestionQueueService(
      jobs as any,
      {} as any,
      cache as any,
      config as any,
    );

    await expect(
      service.enqueueWebsite('user-1', 'https://example.com'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(jobs.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: IngestionJobStatus.FAILED,
        progress: 100,
      }),
    );
  });

  it('processes a website job in the worker and persists its result', async () => {
    const jobs = repository();
    const record = {
      id: 'job-1',
      status: IngestionJobStatus.QUEUED,
      cancelRequested: false,
      startedAt: null,
    };
    jobs.findOne.mockResolvedValue(record);
    const rag = {
      indexWebsite: jest.fn().mockResolvedValue({
        fileName: 'web-example.html',
        chunkCount: 4,
        sourceUrl: 'https://example.com',
        sourceId: 'source-1',
      }),
    };
    const service = new IngestionQueueService(
      jobs as any,
      rag as any,
      {} as any,
      config as any,
    );
    const job = {
      id: 'job-1',
      data: {
        type: IngestionJobType.WEBSITE,
        userId: 'user-1',
        url: 'https://example.com',
      },
      attemptsMade: 0,
      opts: { attempts: 3 },
      updateProgress: jest.fn(),
    };

    await expect((service as any).process(job)).resolves.toMatchObject({
      sourceId: 'source-1',
    });
    expect(rag.indexWebsite).toHaveBeenCalledWith(
      'user-1',
      'https://example.com',
      undefined,
      expect.any(Function),
    );
    expect(jobs.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: IngestionJobStatus.COMPLETED,
        progress: 100,
        sourceId: 'source-1',
      }),
    );
  });

  it('loads job status only through the requesting user ownership filter', async () => {
    const jobs = repository();
    jobs.findOne.mockResolvedValue({ id: 'job-1', userId: 'owner-1' });
    const service = new IngestionQueueService(
      jobs as any,
      {} as any,
      {} as any,
      config as any,
    );
    await service.getJob('owner-1', 'job-1');
    expect(jobs.findOne).toHaveBeenCalledWith({
      where: { id: 'job-1', userId: 'owner-1' },
    });
  });
});
