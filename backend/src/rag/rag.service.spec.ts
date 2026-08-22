import { BadRequestException } from '@nestjs/common';
import axios from 'axios';
import {
  KnowledgeSourceStatus,
  KnowledgeSourceType,
} from '../entities/knowledge-source.entity';
import { RagService } from './rag.service';

describe('RagService caching and website safety', () => {
  const repository = () => ({
    find: jest.fn(),
    delete: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    query: jest.fn(),
    count: jest.fn(),
  });
  const config = {
    get: jest.fn((_key: string, fallback: unknown) => fallback),
  };
  const sourceRepository = () => ({
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => ({
      id: 'source-1',
      metadata: {},
      ...value,
    })),
    delete: jest.fn(),
    query: jest.fn(),
  });
  const accessRepository = () => ({
    upsert: jest.fn(),
    findOne: jest.fn(),
    delete: jest.fn(),
  });

  it('returns user-scoped cached retrieval results without querying PostgreSQL', async () => {
    const chunks = [
      { fileName: 'guide.md', chunkIndex: 0, content: 'Cached', score: 0.9 },
    ];
    const repo = repository();
    const cache = {
      getNumber: jest.fn().mockResolvedValue(4),
      getJson: jest.fn().mockResolvedValue(chunks),
      setJson: jest.fn(),
      increment: jest.fn(),
    };
    const service = new RagService(
      repo as any,
      sourceRepository() as any,
      accessRepository() as any,
      cache as any,
      config as any,
    );

    await expect(
      service.searchSimilarChunks('user-1', 'What is cached?'),
    ).resolves.toEqual(chunks);
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('rejects local website ingestion targets', async () => {
    const service = new RagService(
      repository() as any,
      sourceRepository() as any,
      accessRepository() as any,
      {} as any,
      config as any,
    );
    await expect(
      service.indexWebsite('user-1', 'http://127.0.0.1/private'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uses pgvector retrieval when the extension and canonical embeddings are available', async () => {
    const vector = new Array(768).fill(0);
    vector[0] = 1;
    const repo = repository();
    repo.query
      .mockResolvedValueOnce([{ available: true }])
      .mockResolvedValueOnce([
        {
          fileName: 'guide.md',
          chunkIndex: 2,
          content: 'Vector result',
          score: '0.91',
        },
      ]);
    const cache = {
      getNumber: jest.fn().mockResolvedValue(1),
      getJson: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(vector),
      setJson: jest.fn().mockResolvedValue(undefined),
      increment: jest.fn(),
    };
    const service = new RagService(
      repo as any,
      sourceRepository() as any,
      accessRepository() as any,
      cache as any,
      config as any,
    );

    await expect(
      service.searchSimilarChunks('user-1', 'Find the guide'),
    ).resolves.toEqual([
      {
        fileName: 'guide.md',
        chunkIndex: 2,
        content: 'Vector result',
        score: 0.91,
      },
    ]);
    expect(repo.query.mock.calls[1][0]).toContain('vector(768)');
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('tracks a new source from pending through processing to ready', async () => {
    const statuses: KnowledgeSourceStatus[] = [];
    const sources = sourceRepository();
    sources.findOne.mockResolvedValue(null);
    sources.save.mockImplementation(async (value) => {
      statuses.push(value.status);
      return { id: 'source-1', metadata: {}, ...value };
    });
    const service = new RagService(
      repository() as any,
      sources as any,
      accessRepository() as any,
      {} as any,
      config as any,
    );
    const source = await (service as any).beginSource({
      userId: 'user-1',
      type: KnowledgeSourceType.FILE,
      title: 'guide.md',
      sourceKey: 'guide.md',
      originalLocator: 'guide.md',
      canonicalUrl: null,
      metadata: {},
    });
    await (service as any).markSourceReady(source, { chunkCount: 2 });

    expect(statuses).toEqual([
      KnowledgeSourceStatus.PENDING,
      KnowledgeSourceStatus.PROCESSING,
      KnowledgeSourceStatus.READY,
    ]);
    expect(source.lastIndexedAt).toBeInstanceOf(Date);
    expect(source.metadata).toMatchObject({ chunkCount: 2 });
  });

  it('lists knowledge sources with an explicit owner filter', async () => {
    const sources = sourceRepository();
    sources.query.mockResolvedValue([]);
    const service = new RagService(
      repository() as any,
      sources as any,
      accessRepository() as any,
      {} as any,
      config as any,
    );
    await service.getUserSources('owner-1');
    expect(sources.query.mock.calls[0][1]).toEqual(['owner-1']);
  });

  it('subscribes a second user to ready public knowledge without fetching or embedding again', async () => {
    const repo = repository();
    repo.count.mockResolvedValue(7);
    const sources = sourceRepository();
    sources.findOne.mockResolvedValue({
      id: 'public-source',
      sourceKey: 'web-example.html',
      canonicalUrl: 'https://example.com/docs',
      visibility: 'PUBLIC',
      status: KnowledgeSourceStatus.READY,
    });
    const access = accessRepository();
    const cache = { increment: jest.fn() };
    const service = new RagService(
      repo as any,
      sources as any,
      access as any,
      cache as any,
      config as any,
    );
    (service as any).assertPublicHttpUrl = jest
      .fn()
      .mockResolvedValue(undefined);

    await expect(
      service.indexWebsite('user-2', 'https://example.com/docs'),
    ).resolves.toMatchObject({
      sourceId: 'public-source',
      chunkCount: 7,
      reused: true,
    });
    expect(access.upsert).toHaveBeenCalledWith(
      { userId: 'user-2', sourceId: 'public-source', enabled: true },
      { conflictPaths: ['userId', 'sourceId'] },
    );
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('unsubscribes one user from public knowledge without deleting shared chunks', async () => {
    const repo = repository();
    const access = accessRepository();
    access.findOne.mockResolvedValue({
      id: 'access-1',
      source: { visibility: 'PUBLIC' },
    });
    const cache = { increment: jest.fn() };
    const service = new RagService(
      repo as any,
      sourceRepository() as any,
      access as any,
      cache as any,
      config as any,
    );

    await expect(
      service.deleteDocument('user-1', 'web-example.html'),
    ).resolves.toEqual({ success: true });
    expect(access.delete).toHaveBeenCalledWith({
      id: 'access-1',
      userId: 'user-1',
    });
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('normalizes equivalent content to the same SHA-256 checksum', () => {
    const service = new RagService(
      repository() as any,
      sourceRepository() as any,
      accessRepository() as any,
      {} as any,
      config as any,
    );
    const first = (service as any).contentChecksum(
      'Heading\r\n\r\nBody   \r\n',
    );
    const second = (service as any).contentChecksum('Heading\n\n\nBody\n');
    const changed = (service as any).contentChecksum(
      'Heading\n\nDifferent body',
    );
    expect(first).toHaveLength(64);
    expect(first).toBe(second);
    expect(changed).not.toBe(first);
  });

  it('reuses private content only for the same owner, source key, checksum, and ready state', async () => {
    const sources = sourceRepository();
    sources.findOne.mockResolvedValue({ id: 'private-source' });
    const service = new RagService(
      repository() as any,
      sources as any,
      accessRepository() as any,
      {} as any,
      config as any,
    );
    await expect(
      (service as any).findReusablePrivateSource(
        'owner-1',
        'guide.md',
        'abc123',
      ),
    ).resolves.toEqual({ id: 'private-source' });
    expect(sources.findOne).toHaveBeenCalledWith({
      where: {
        userId: 'owner-1',
        sourceKey: 'guide.md',
        checksum: 'abc123',
        visibility: 'PRIVATE',
        status: KnowledgeSourceStatus.READY,
      },
    });
  });

  it('rejects a page explicitly disallowed by robots.txt', async () => {
    const service = new RagService(
      repository() as any,
      sourceRepository() as any,
      accessRepository() as any,
      {} as any,
      config as any,
    );
    jest.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: 'User-agent: *\nDisallow: /private',
    });
    await expect(
      (service as any).assertRobotsAllowed(
        new URL('https://example.com/private/page'),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    jest.restoreAllMocks();
  });

  it('deduplicates and limits sitemap pages to the same origin', async () => {
    const service = new RagService(
      repository() as any,
      sourceRepository() as any,
      accessRepository() as any,
      {} as any,
      config as any,
    );
    (service as any).assertPublicHttpUrl = jest
      .fn()
      .mockResolvedValue(undefined);
    jest.spyOn(axios, 'get').mockResolvedValueOnce({
      data: '<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/a</loc></url><url><loc>https://other.test/private</loc></url></urlset>',
    });
    jest.spyOn(service, 'indexWebsite').mockResolvedValue({
      fileName: 'web-a.html',
      chunkCount: 1,
      sourceUrl: 'https://example.com/a',
      sourceId: 'source-a',
    });
    await expect(
      service.indexSitemap('user-1', 'https://example.com/sitemap.xml'),
    ).resolves.toMatchObject({
      pageCount: 1,
      sources: [{ sourceId: 'source-a' }],
    });
    jest.restoreAllMocks();
  });
});
