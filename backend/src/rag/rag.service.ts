import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocumentChunkEntity } from '../entities/document-chunk.entity';
import {
  KnowledgeSourceEntity,
  KnowledgeSourceStatus,
  KnowledgeSourceType,
  KnowledgeSourceVisibility,
} from '../entities/knowledge-source.entity';
import { UserKnowledgeSourceEntity } from '../entities/user-knowledge-source.entity';
import * as fs from 'fs';
import * as path from 'path';
// pdf-parse v2 exports a class, not a default function
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PDFParse } = require('pdf-parse');
import axios from 'axios';
import { load } from 'cheerio';
import { createHash } from 'crypto';
import { promises as dns } from 'dns';
import { isIP } from 'net';
import { RedisCacheService } from '../cache/redis-cache.service';

export interface UserDocumentSummary {
  fileName: string;
  fileType: string;
  chunkCount: number;
  createdAt: Date;
  sourceId?: string;
  sourceStatus?: KnowledgeSourceStatus;
  sourceType?: KnowledgeSourceType;
}

export interface RelevantChunkResult {
  fileName: string;
  chunkIndex: number;
  content: string;
  score: number;
}

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private readonly uploadsDir = path.resolve(__dirname, '..', '..', 'uploads');
  private pgVectorAvailable: boolean | undefined;

  constructor(
    @InjectRepository(DocumentChunkEntity)
    private readonly chunkRepository: Repository<DocumentChunkEntity>,
    @InjectRepository(KnowledgeSourceEntity)
    private readonly sourceRepository: Repository<KnowledgeSourceEntity>,
    @InjectRepository(UserKnowledgeSourceEntity)
    private readonly accessRepository: Repository<UserKnowledgeSourceEntity>,
    private readonly cache: RedisCacheService,
    private readonly config: ConfigService,
  ) {
    if (!fs.existsSync(this.uploadsDir)) {
      fs.mkdirSync(this.uploadsDir, { recursive: true });
    }
  }

  /**
   * Process & Index an uploaded document for a user
   */
  async indexDocument(
    userId: string,
    fileName: string,
    fileBuffer: Buffer,
    mimeType: string,
    customLocalUrl?: string,
    shouldCancel?: () => Promise<boolean>,
  ): Promise<{
    fileName: string;
    chunkCount: number;
    sourceId: string;
    reused?: boolean;
  }> {
    const userDir = path.join(this.uploadsDir, userId);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }

    const safeFileName = path.basename(fileName);
    if (!safeFileName || safeFileName !== fileName) {
      throw new BadRequestException('Invalid file name');
    }
    const targetPath = path.join(userDir, safeFileName);
    fs.writeFileSync(targetPath, fileBuffer);

    const fileExt =
      path.extname(safeFileName).toLowerCase().replace('.', '') || 'txt';
    let rawText = '';

    try {
      if (fileExt === 'pdf' || mimeType.includes('pdf')) {
        // pdf-parse v2: class-based API — getText() returns {text, pages, total}
        const parser = new PDFParse({ data: fileBuffer });
        const result = await parser.getText();
        rawText = result.text || '';
      } else if (fileExt === 'json') {
        try {
          const parsedJson = JSON.parse(fileBuffer.toString('utf-8'));
          rawText = JSON.stringify(parsedJson, null, 2);
        } catch {
          rawText = fileBuffer.toString('utf-8');
        }
      } else {
        // Clean UTF-8 string text (TXT, MD, CSV, Code files)
        rawText = fileBuffer.toString('utf-8');
      }
    } catch (err: any) {
      this.logger.error(`Error parsing file ${fileName}: ${err.message}`);
      throw new BadRequestException(
        `Failed to extract text from file ${fileName}`,
      );
    }

    if (!rawText.trim()) {
      throw new BadRequestException(
        `No readable text found in file ${fileName}`,
      );
    }

    const checksum = this.contentChecksum(rawText);
    const reusable = await this.findReusablePrivateSource(
      userId,
      safeFileName,
      checksum,
    );
    if (reusable) {
      return {
        fileName: safeFileName,
        chunkCount: await this.chunkRepository.count({
          where: { sourceId: reusable.id },
        }),
        sourceId: reusable.id,
        reused: true,
      };
    }

    const source = await this.beginSource({
      userId,
      type: KnowledgeSourceType.FILE,
      title: safeFileName,
      sourceKey: safeFileName,
      originalLocator: safeFileName,
      canonicalUrl: null,
      checksum,
      metadata: { mimeType, sizeBytes: fileBuffer.byteLength },
    });
    try {
      const result = await this.indexText(
        userId,
        safeFileName,
        fileExt,
        rawText,
        source.id,
        customLocalUrl,
        shouldCancel,
      );
      await this.markSourceReady(source, { chunkCount: result.chunkCount });
      return { ...result, sourceId: source.id };
    } catch (error: unknown) {
      await this.markSourceFailed(source, error);
      throw error;
    }
  }

  async indexWebsite(
    userId: string,
    inputUrl: string,
    customLocalUrl?: string,
    shouldCancel?: () => Promise<boolean>,
  ): Promise<{
    fileName: string;
    chunkCount: number;
    sourceUrl: string;
    sourceId: string;
    reused?: boolean;
  }> {
    let currentUrl: URL;
    try {
      currentUrl = new URL(inputUrl);
    } catch {
      throw new BadRequestException('Website URL is invalid');
    }
    await this.assertPublicHttpUrl(currentUrl);
    const requestedUrl = this.normalizePublicUrl(currentUrl);
    const existing = await this.findReadyPublicSource(requestedUrl);
    if (existing) {
      await this.subscribeUser(userId, existing.id);
      await this.cache.increment(this.documentVersionKey(userId));
      return {
        fileName: existing.sourceKey,
        chunkCount: await this.chunkRepository.count({
          where: { sourceId: existing.id },
        }),
        sourceUrl: existing.canonicalUrl || requestedUrl,
        sourceId: existing.id,
        reused: true,
      };
    }
    await this.assertRobotsAllowed(currentUrl);
    let response: any;

    for (let redirect = 0; redirect <= 3; redirect++) {
      await this.assertPublicHttpUrl(currentUrl);
      try {
        response = await axios.get(currentUrl.toString(), {
          timeout: 10_000,
          maxRedirects: 0,
          responseType: 'text',
          maxContentLength: 2 * 1024 * 1024,
          headers: { 'User-Agent': 'CarrotAI-KnowledgeIndexer/1.0' },
          validateStatus: (status) =>
            (status >= 200 && status < 300) || (status >= 300 && status < 400),
        });
      } catch (error: any) {
        throw new BadRequestException(
          `Could not retrieve website: ${error.message}`,
        );
      }

      if (response.status < 300) break;
      const location = response.headers.location;
      if (!location || redirect === 3)
        throw new BadRequestException('Website redirected too many times');
      currentUrl = new URL(location, currentUrl);
    }

    const contentType = String(response.headers['content-type'] || '');
    if (
      !contentType.includes('text/html') &&
      !contentType.includes('text/plain')
    ) {
      throw new BadRequestException(
        'Only HTML and plain-text website content can be indexed',
      );
    }

    const $ = load(String(response.data));
    $('script, style, noscript, svg, nav, footer, form').remove();
    const title = $('title').first().text().replace(/\s+/g, ' ').trim();
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    if (bodyText.length < 50)
      throw new BadRequestException(
        'Website did not contain enough readable text',
      );

    const sourceUrl = this.normalizePublicUrl(currentUrl);
    const urlHash = createHash('sha256')
      .update(sourceUrl)
      .digest('hex')
      .slice(0, 12);
    const host = currentUrl.hostname.replace(/[^a-z0-9.-]/gi, '-').slice(0, 80);
    const fileName = `web-${host}-${urlHash}.html`;
    const rawText = `Source URL: ${sourceUrl}\nPage title: ${title || host}\n\n${bodyText}`;
    const checksum = this.contentChecksum(rawText);
    const source = await this.beginPublicSource({
      type: KnowledgeSourceType.WEBSITE,
      title: title || host,
      sourceKey: fileName,
      originalLocator: inputUrl,
      canonicalUrl: sourceUrl,
      checksum,
      metadata: { host },
    });
    await this.subscribeUser(userId, source.id);
    if (source.status === KnowledgeSourceStatus.READY) {
      await this.cache.increment(this.documentVersionKey(userId));
      return {
        fileName: source.sourceKey,
        chunkCount: await this.chunkRepository.count({
          where: { sourceId: source.id },
        }),
        sourceUrl: source.canonicalUrl || sourceUrl,
        sourceId: source.id,
        reused: true,
      };
    }
    try {
      const result = await this.indexText(
        null,
        fileName,
        'html',
        rawText,
        source.id,
        customLocalUrl,
        shouldCancel,
      );
      await this.markSourceReady(source, { chunkCount: result.chunkCount });
      await this.cache.increment(this.documentVersionKey(userId));
      return { ...result, sourceUrl, sourceId: source.id };
    } catch (error: unknown) {
      await this.markSourceFailed(source, error);
      throw error;
    }
  }

  async indexSitemap(
    userId: string,
    inputUrl: string,
    shouldCancel?: () => Promise<boolean>,
  ): Promise<{
    sitemapUrl: string;
    pageCount: number;
    sources: Array<{ sourceId: string; fileName: string; reused?: boolean }>;
  }> {
    let sitemapUrl: URL;
    try {
      sitemapUrl = new URL(inputUrl);
    } catch {
      throw new BadRequestException('Sitemap URL is invalid');
    }
    await this.assertPublicHttpUrl(sitemapUrl);
    const response = await axios.get(sitemapUrl.toString(), {
      timeout: 10_000,
      maxRedirects: 0,
      responseType: 'text',
      maxContentLength: 1024 * 1024,
      headers: { 'User-Agent': 'CarrotAI-KnowledgeIndexer/1.0' },
    });
    const $ = load(String(response.data), { xmlMode: true });
    const maximumPages = Math.min(
      this.config.get<number>('SITEMAP_MAX_PAGES', 10),
      25,
    );
    const urls = new Map<string, URL>();
    $('loc').each((_index, element) => {
      if (urls.size >= maximumPages) return;
      try {
        const candidate = new URL($(element).text().trim());
        if (candidate.origin !== sitemapUrl.origin) return;
        const normalized = this.normalizePublicUrl(candidate);
        urls.set(normalized, candidate);
      } catch {
        // Ignore malformed sitemap entries.
      }
    });
    if (!urls.size)
      throw new BadRequestException(
        'Sitemap did not contain eligible same-origin pages',
      );
    const sources: Array<{
      sourceId: string;
      fileName: string;
      reused?: boolean;
    }> = [];
    for (const page of urls.values()) {
      if (await shouldCancel?.()) throw new Error('Ingestion cancelled');
      await this.assertPublicHttpUrl(page);
      const result = await this.indexWebsite(
        userId,
        page.toString(),
        undefined,
        shouldCancel,
      );
      sources.push({
        sourceId: result.sourceId,
        fileName: result.fileName,
        reused: result.reused,
      });
    }
    return {
      sitemapUrl: this.normalizePublicUrl(sitemapUrl),
      pageCount: sources.length,
      sources,
    };
  }

  private async indexText(
    userId: string | null,
    safeFileName: string,
    fileExt: string,
    rawText: string,
    sourceId: string,
    customLocalUrl?: string,
    shouldCancel?: () => Promise<boolean>,
  ): Promise<{ fileName: string; chunkCount: number }> {
    const chunks = this.chunkText(rawText, 800, 100);

    // Delete pre-existing chunks for this user & filename if re-uploading
    await this.chunkRepository.delete({ sourceId });

    const chunkEntities: DocumentChunkEntity[] = [];

    for (let i = 0; i < chunks.length; i++) {
      if (await shouldCancel?.()) throw new Error('Ingestion cancelled');
      const chunkText = chunks[i];
      const embedding = await this.generateEmbedding(chunkText, customLocalUrl);

      const entity = this.chunkRepository.create({
        userId,
        fileName: safeFileName,
        fileType: fileExt,
        chunkIndex: i,
        content: chunkText,
        embedding,
        sourceId,
      });

      chunkEntities.push(entity);
    }

    await this.chunkRepository.save(chunkEntities);
    if (userId) await this.cache.increment(this.documentVersionKey(userId));
    this.logger.log(
      `Indexed knowledge [${safeFileName}] for user [${userId}] into ${chunkEntities.length} chunks.`,
    );

    return {
      fileName: safeFileName,
      chunkCount: chunkEntities.length,
    };
  }

  /**
   * Search for top-K relevant document chunks matching user query prompt
   */
  async searchSimilarChunks(
    userId: string,
    query: string,
    topK = 3,
    customLocalUrl?: string,
    selectedDocNames?: string[],
  ): Promise<RelevantChunkResult[]> {
    const cleanQuery = query.trim().toLowerCase().replace(/\s+/g, ' ');
    const version = await this.cache.getNumber(this.documentVersionKey(userId));
    const retrievalKey = this.hashKey('rag:results', {
      userId,
      version,
      query: cleanQuery,
      topK,
      selectedDocNames: [...(selectedDocNames || [])].sort(),
      localUrl: customLocalUrl || 'default',
      algorithm: 1,
    });
    const cached =
      await this.cache.getJson<RelevantChunkResult[]>(retrievalKey);
    if (cached) {
      this.logger.debug(`RAG retrieval cache hit for user [${userId}].`);
      return cached;
    }

    const vectorResults = await this.searchWithPgVector(
      userId,
      query,
      cleanQuery,
      topK,
      customLocalUrl,
      selectedDocNames,
    );
    if (vectorResults) {
      await this.cache.setJson(
        retrievalKey,
        vectorResults,
        this.config.get<number>('RAG_CACHE_TTL_SECONDS', 1_800),
      );
      return vectorResults;
    }

    let userChunks = await this.getAccessibleChunks(userId);
    if (!userChunks || userChunks.length === 0) {
      return [];
    }

    if (selectedDocNames && selectedDocNames.length > 0) {
      const selectedSet = new Set(selectedDocNames);
      userChunks = userChunks.filter((c) => selectedSet.has(c.fileName));
      if (userChunks.length === 0) return [];
    }

    // 1. Casual Chat & Small-Talk Filter: Skip RAG for simple greetings or non-informative prompts
    const casualPatterns = [
      /^(hi|hello|hey|greetings|good\s+(morning|afternoon|evening)|hola|howdy)(\s+.*)?$/i,
      /^(how\s+are\s+you|who\s+are\s+you|what\s+can\s+you\s+do|thanks|thank\s+you|ok|okay|cool|bye|goodbye)$/i,
      /^(write|create|generate|explain|code)\s+a?\s*(python|javascript|typescript|c\+\+|java|html|css|sql)?\s*(script|function|program|code|component)?$/i,
    ];

    const isCasual =
      casualPatterns.some((pattern) => pattern.test(cleanQuery)) &&
      cleanQuery.split(/\s+/).length <= 6;
    if (isCasual) {
      this.logger.log(
        `Skipping RAG document lookup for casual/generic prompt: "${query}"`,
      );
      return [];
    }

    const queryEmbedding = await this.generateEmbedding(query, customLocalUrl);
    const queryWords = cleanQuery
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2);

    const scored = userChunks
      .map((chunk) => {
        let score = this.calculateCosineSimilarity(
          queryEmbedding,
          chunk.embedding || [],
        );

        // 2. Keyword boost: Give higher weight if exact query keywords appear in chunk content
        if (queryWords.length > 0) {
          const chunkTextLower = chunk.content.toLowerCase();
          let wordMatches = 0;
          for (const word of queryWords) {
            if (chunkTextLower.includes(word)) {
              wordMatches++;
            }
          }
          const wordOverlapRatio = wordMatches / queryWords.length;
          score += wordOverlapRatio * 0.25; // Boost score by up to 0.25 for high keyword match
        }

        return {
          fileName: chunk.fileName,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          score,
        };
      })
      .filter((c) => c.score >= 0.3) // Strict similarity threshold (0.30+) to ignore irrelevant matches
      .sort((a, b) => b.score - a.score);

    this.logger.log(
      `RAG query ["${query.slice(0, 40)}..."] matched ${scored.length} chunks (top score: ${scored[0]?.score.toFixed(3) || 0})`,
    );
    const results = scored.slice(0, topK);
    await this.cache.setJson(
      retrievalKey,
      results,
      this.config.get<number>('RAG_CACHE_TTL_SECONDS', 1_800),
    );
    return results;
  }

  /**
   * List uploaded documents for a user & auto-clean orphaned files on disk
   */
  async getUserDocuments(userId: string): Promise<UserDocumentSummary[]> {
    const chunks = await this.getAccessibleChunks(userId);
    const docsMap = new Map<string, UserDocumentSummary>();

    for (const chunk of chunks) {
      const existing = docsMap.get(chunk.fileName);
      if (existing) {
        existing.chunkCount += 1;
      } else {
        docsMap.set(chunk.fileName, {
          fileName: chunk.fileName,
          fileType: chunk.fileType,
          chunkCount: 1,
          createdAt: chunk.createdAt,
          sourceId: chunk.sourceId || undefined,
          sourceStatus: chunk.sourceStatus,
          sourceType: chunk.sourceType,
        });
      }
    }

    // Auto Garbage Collection: Clean up orphan files on disk that have no database chunks
    try {
      const userDir = path.join(this.uploadsDir, userId);
      if (fs.existsSync(userDir)) {
        const diskFiles = fs.readdirSync(userDir);
        for (const file of diskFiles) {
          if (!docsMap.has(file)) {
            const orphanPath = path.join(userDir, file);
            try {
              fs.unlinkSync(orphanPath);
              this.logger.log(
                `Cleaned up orphaned file from disk: [${file}] for user [${userId}]`,
              );
            } catch (e: any) {
              this.logger.warn(
                `Could not remove orphan file ${file}: ${e.message}`,
              );
            }
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(`Error during orphan file scan: ${err.message}`);
    }

    return Array.from(docsMap.values());
  }

  async getUserSources(userId: string): Promise<KnowledgeSourceEntity[]> {
    return this.sourceRepository.query(
      `SELECT source.*
       FROM knowledge_sources source
       WHERE source."userId" = $1
          OR EXISTS (
            SELECT 1 FROM user_knowledge_sources access
            WHERE access."sourceId" = source.id AND access."userId" = $1 AND access.enabled = true
          )
       ORDER BY source."updatedAt" DESC`,
      [userId],
    );
  }

  /**
   * Delete a document and its stored vector embeddings (future-proof & synchronized)
   */
  async deleteDocument(
    userId: string,
    fileName: string,
  ): Promise<{ success: boolean }> {
    const safeFileName = path.basename(fileName);

    const publicAccess = await this.accessRepository.findOne({
      where: { userId, source: { sourceKey: safeFileName } },
      relations: { source: true },
    });
    if (publicAccess?.source.visibility === KnowledgeSourceVisibility.PUBLIC) {
      await this.accessRepository.delete({ id: publicAccess.id, userId });
      await this.cache.increment(this.documentVersionKey(userId));
      return { success: true };
    }

    // 1. Delete vector embeddings from PostgreSQL database
    await this.chunkRepository.delete({ userId, fileName });
    await this.sourceRepository.delete({ userId, sourceKey: safeFileName });
    await this.cache.increment(this.documentVersionKey(userId));

    // 2. Delete physical file from disk
    const userDir = path.join(this.uploadsDir, userId);
    const filePath = path.join(userDir, safeFileName);

    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        this.logger.log(
          `Deleted file from disk: [${safeFileName}] for user [${userId}]`,
        );
      } catch (e: any) {
        this.logger.warn(`Could not delete file from disk: ${e.message}`);
      }
    }

    // 3. Fallback check: remove any leftover case variations of the file in user directory
    if (fs.existsSync(userDir)) {
      try {
        const files = fs.readdirSync(userDir);
        for (const f of files) {
          if (f.toLowerCase() === safeFileName.toLowerCase()) {
            try {
              fs.unlinkSync(path.join(userDir, f));
            } catch (e) {
              // ignore
            }
          }
        }
      } catch (e) {
        // ignore
      }
    }

    return { success: true };
  }

  private async beginSource(input: {
    userId: string;
    type: KnowledgeSourceType;
    title: string;
    sourceKey: string;
    originalLocator: string;
    canonicalUrl: string | null;
    checksum: string;
    metadata: Record<string, unknown>;
  }): Promise<KnowledgeSourceEntity> {
    let source = await this.sourceRepository.findOne({
      where: { userId: input.userId, sourceKey: input.sourceKey },
    });
    if (!source) {
      source = await this.sourceRepository.save(
        this.sourceRepository.create({
          ...input,
          visibility: KnowledgeSourceVisibility.PRIVATE,
          publicKey: null,
          version: 1,
          status: KnowledgeSourceStatus.PENDING,
          checksum: input.checksum,
          errorMessage: null,
          lastIndexedAt: null,
          lastCheckedAt: new Date(),
        }),
      );
    } else {
      Object.assign(source, input, {
        version: source.version + 1,
        lastCheckedAt: new Date(),
      });
    }
    source.status = KnowledgeSourceStatus.PROCESSING;
    source.errorMessage = null;
    return this.sourceRepository.save(source);
  }

  private async getAccessibleChunks(userId: string): Promise<
    Array<
      DocumentChunkEntity & {
        sourceStatus?: KnowledgeSourceStatus;
        sourceType?: KnowledgeSourceType;
      }
    >
  > {
    const rows = await this.chunkRepository.query(
      `SELECT chunk.*, source.status AS "sourceStatus", source.type AS "sourceType"
       FROM document_chunks chunk
       LEFT JOIN knowledge_sources source ON source.id = chunk."sourceId"
       WHERE chunk."userId" = $1
          OR EXISTS (
            SELECT 1 FROM user_knowledge_sources access
            WHERE access."sourceId" = chunk."sourceId" AND access."userId" = $1 AND access.enabled = true
          )`,
      [userId],
    );
    return rows.map((row: DocumentChunkEntity) => {
      const embedding = (row as unknown as { embedding?: number[] | string })
        .embedding;
      return {
        ...row,
        embedding:
          typeof embedding === 'string'
            ? embedding.slice(1, -1).split(',').map(Number)
            : embedding,
      } as DocumentChunkEntity & {
        sourceStatus?: KnowledgeSourceStatus;
        sourceType?: KnowledgeSourceType;
      };
    });
  }

  private normalizePublicUrl(url: URL): string {
    const normalized = new URL(url.toString());
    normalized.hash = '';
    normalized.hostname = normalized.hostname.toLowerCase();
    if (
      (normalized.protocol === 'https:' && normalized.port === '443') ||
      (normalized.protocol === 'http:' && normalized.port === '80')
    ) {
      normalized.port = '';
    }
    normalized.searchParams.sort();
    return normalized.toString();
  }

  private normalizeContentForChecksum(content: string): string {
    return content
      .normalize('NFKC')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[\t ]+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private contentChecksum(content: string): string {
    return createHash('sha256')
      .update(this.normalizeContentForChecksum(content), 'utf8')
      .digest('hex');
  }

  private async findReusablePrivateSource(
    userId: string,
    sourceKey: string,
    checksum: string,
  ): Promise<KnowledgeSourceEntity | null> {
    return this.sourceRepository.findOne({
      where: {
        userId,
        sourceKey,
        checksum,
        visibility: KnowledgeSourceVisibility.PRIVATE,
        status: KnowledgeSourceStatus.READY,
      },
    });
  }

  private publicUrlKey(url: string): string {
    return createHash('sha256').update(url).digest('hex');
  }

  private async findReadyPublicSource(
    url: string,
  ): Promise<KnowledgeSourceEntity | null> {
    return this.sourceRepository.findOne({
      where: {
        publicKey: this.publicUrlKey(url),
        visibility: KnowledgeSourceVisibility.PUBLIC,
        status: KnowledgeSourceStatus.READY,
      },
    });
  }

  private async beginPublicSource(input: {
    type: KnowledgeSourceType;
    title: string;
    sourceKey: string;
    originalLocator: string;
    canonicalUrl: string;
    checksum: string;
    metadata: Record<string, unknown>;
  }): Promise<KnowledgeSourceEntity> {
    const publicKey = this.publicUrlKey(input.canonicalUrl);
    let source = await this.sourceRepository.findOne({ where: { publicKey } });
    if (source) {
      if (
        source.status === KnowledgeSourceStatus.READY &&
        source.checksum === input.checksum
      )
        return source;
      Object.assign(source, input, {
        status: KnowledgeSourceStatus.PROCESSING,
        version: source.version + 1,
        errorMessage: null,
        lastCheckedAt: new Date(),
      });
      return this.sourceRepository.save(source);
    }
    source = await this.sourceRepository.save(
      this.sourceRepository.create({
        ...input,
        userId: null,
        visibility: KnowledgeSourceVisibility.PUBLIC,
        publicKey,
        version: 1,
        status: KnowledgeSourceStatus.PENDING,
        checksum: input.checksum,
        errorMessage: null,
        lastIndexedAt: null,
        lastCheckedAt: new Date(),
      }),
    );
    source.status = KnowledgeSourceStatus.PROCESSING;
    return this.sourceRepository.save(source);
  }

  private async subscribeUser(userId: string, sourceId: string): Promise<void> {
    await this.accessRepository.upsert(
      { userId, sourceId, enabled: true },
      { conflictPaths: ['userId', 'sourceId'] },
    );
  }

  private async markSourceReady(
    source: KnowledgeSourceEntity,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    source.status = KnowledgeSourceStatus.READY;
    source.lastIndexedAt = new Date();
    source.lastCheckedAt = source.lastIndexedAt;
    source.errorMessage = null;
    source.metadata = { ...source.metadata, ...metadata };
    await this.sourceRepository.save(source);
  }

  private async markSourceFailed(
    source: KnowledgeSourceEntity,
    error: unknown,
  ): Promise<void> {
    source.status = KnowledgeSourceStatus.FAILED;
    source.lastCheckedAt = new Date();
    source.errorMessage = (
      error instanceof Error ? error.message : 'Ingestion failed'
    ).slice(0, 2_000);
    await this.sourceRepository.save(source);
  }

  /**
   * Helper: Chunk raw text into overlapping windows
   */
  private chunkText(text: string, chunkSize = 800, overlap = 100): string[] {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    const paragraphs = normalized.split(/\n\n+/);
    const chunks: string[] = [];
    let currentChunk = '';

    for (const p of paragraphs) {
      if ((currentChunk + '\n\n' + p).length <= chunkSize) {
        currentChunk = currentChunk ? `${currentChunk}\n\n${p}` : p;
      } else {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
        }
        if (p.length > chunkSize) {
          // Split large paragraph by sentences
          let start = 0;
          while (start < p.length) {
            let end = start + chunkSize;
            chunks.push(p.slice(start, end).trim());
            start += chunkSize - overlap;
          }
          currentChunk = '';
        } else {
          currentChunk = p;
        }
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks.filter((c) => c.length > 10);
  }

  /**
   * Helper: Generate vector embedding using local Ollama or high-speed local n-gram vectorizer
   */
  private async generateEmbedding(
    text: string,
    customLocalUrl?: string,
  ): Promise<number[]> {
    const baseUrl = customLocalUrl || 'http://localhost:11434/v1';
    const rootUrl = baseUrl.replace(/\/v1$/, '');
    const embeddingKey = this.hashKey('rag:embedding', {
      rootUrl,
      text,
      version: 1,
    });
    const cached = await this.cache.getJson<number[]>(embeddingKey);
    if (cached) return cached;

    // Try 1: Call Ollama native embeddings API
    try {
      const response = await axios.post(
        `${rootUrl}/api/embeddings`,
        {
          model: 'nomic-embed-text',
          prompt: text,
        },
        { timeout: 3000 },
      );

      if (
        response.data &&
        Array.isArray(response.data.embedding) &&
        response.data.embedding.length === 768
      ) {
        await this.cacheEmbedding(embeddingKey, response.data.embedding);
        return response.data.embedding;
      }
    } catch (err) {
      // Fall through to local vectorizer
    }

    // Fallback stays at Nomic's canonical dimension so all newly indexed rows
    // remain searchable by pgvector even while Ollama is temporarily offline.
    const fallback = this.fallbackVectorize(text);
    await this.cacheEmbedding(embeddingKey, fallback);
    return fallback;
  }

  private async cacheEmbedding(
    key: string,
    embedding: number[],
  ): Promise<void> {
    await this.cache.setJson(
      key,
      embedding,
      this.config.get<number>('RAG_EMBEDDING_CACHE_TTL_SECONDS', 86_400),
    );
  }

  private documentVersionKey(userId: string): string {
    return `rag:document-version:${userId}`;
  }

  private hashKey(prefix: string, value: unknown): string {
    return `${prefix}:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
  }

  private async assertPublicHttpUrl(url: URL): Promise<void> {
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new BadRequestException('Website URL must use HTTP or HTTPS');
    }
    if (url.username || url.password)
      throw new BadRequestException('Website URL cannot include credentials');
    const host = url.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local')
    ) {
      throw new BadRequestException(
        'Private or local websites cannot be indexed',
      );
    }
    let addresses: string[];
    try {
      addresses = isIP(host)
        ? [host]
        : (await dns.lookup(host, { all: true })).map((entry) => entry.address);
    } catch {
      throw new BadRequestException('Website hostname could not be resolved');
    }
    if (
      addresses.length === 0 ||
      addresses.some((address) => this.isPrivateAddress(address))
    ) {
      throw new BadRequestException(
        'Website resolves to a private or reserved network address',
      );
    }
  }

  private async assertRobotsAllowed(url: URL): Promise<void> {
    const robotsUrl = new URL('/robots.txt', url.origin);
    try {
      const response = await axios.get(robotsUrl.toString(), {
        timeout: 5_000,
        maxRedirects: 0,
        responseType: 'text',
        maxContentLength: 256 * 1024,
        headers: { 'User-Agent': 'CarrotAI-KnowledgeIndexer/1.0' },
        validateStatus: (status) =>
          status === 404 || (status >= 200 && status < 300),
      });
      if (response.status === 404) return;
      if (response.status === 401 || response.status === 403) {
        throw new BadRequestException(
          'Website robots.txt does not permit indexing',
        );
      }
      let applies = false;
      const pathName = `${url.pathname}${url.search}`;
      for (const rawLine of String(response.data).split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, '').trim();
        const separator = line.indexOf(':');
        if (separator < 0) continue;
        const field = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        if (field === 'user-agent')
          applies =
            value === '*' ||
            value.toLowerCase() === 'carrotai-knowledgeindexer';
        if (
          applies &&
          field === 'disallow' &&
          value &&
          pathName.startsWith(value)
        ) {
          throw new BadRequestException(
            'Website robots.txt disallows indexing this page',
          );
        }
      }
    } catch (error: unknown) {
      if (error instanceof BadRequestException) throw error;
      this.logger.warn(
        `robots.txt could not be checked for ${url.hostname}; continuing with bounded indexing.`,
      );
    }
  }

  private isPrivateAddress(address: string): boolean {
    const normalized = address.toLowerCase();
    if (normalized.includes(':')) {
      const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
      if (mappedIpv4) return this.isPrivateAddress(mappedIpv4);
      return (
        normalized === '::1' ||
        normalized === '::' ||
        normalized.startsWith('fc') ||
        normalized.startsWith('fd') ||
        normalized.startsWith('fe8') ||
        normalized.startsWith('fe9') ||
        normalized.startsWith('fea') ||
        normalized.startsWith('feb')
      );
    }
    const [a, b] = normalized.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  /**
   * Deterministic 384-dim normalized vector representation
   */
  private fallbackVectorize(text: string, dimensions = 768): number[] {
    const vector = new Array(dimensions).fill(0);
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(Boolean);

    for (const word of words) {
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = (hash << 5) - hash + word.charCodeAt(i);
        hash |= 0;
      }
      const idx = Math.abs(hash) % dimensions;
      vector[idx] += 1;
    }

    // L2 Normalize
    const magnitude = Math.sqrt(
      vector.reduce((sum, val) => sum + val * val, 0),
    );
    if (magnitude === 0) return vector;
    return vector.map((val) => val / magnitude);
  }

  /**
   * Calculate Cosine Similarity between two numerical vectors
   */
  private calculateCosineSimilarity(vecA: number[], vecB: number[]): number {
    if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0) return 0;
    // Strict dimension check: vectors generated by different embedding models cannot be compared
    if (vecA.length !== vecB.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private async searchWithPgVector(
    userId: string,
    query: string,
    cleanQuery: string,
    topK: number,
    customLocalUrl?: string,
    selectedDocNames?: string[],
  ): Promise<RelevantChunkResult[] | undefined> {
    if (!(await this.hasPgVector())) return undefined;

    const queryEmbedding = await this.generateEmbedding(query, customLocalUrl);
    if (queryEmbedding.length !== 768) return undefined;
    const queryWords = cleanQuery
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((word) => word.length > 2);
    const vectorLiteral = `[${queryEmbedding.join(',')}]`;
    const parameters: unknown[] = [vectorLiteral, userId, queryWords, topK];
    let documentFilter = '';
    if (selectedDocNames?.length) {
      parameters.push(selectedDocNames);
      documentFilter = `AND chunk."fileName" = ANY($5::text[])`;
    }

    try {
      const rows = await this.chunkRepository.query(
        `SELECT chunk."fileName", chunk."chunkIndex", chunk.content,
          (1 - (chunk.embedding <=> $1::vector(768))) +
          CASE WHEN cardinality($3::text[]) = 0 THEN 0 ELSE
            (SELECT COUNT(*)::float FROM unnest($3::text[]) AS word WHERE lower(chunk.content) LIKE '%' || word || '%')
            / cardinality($3::text[]) * 0.25
          END AS score
        FROM document_chunks chunk
        WHERE (
          chunk."userId" = $2
          OR EXISTS (
            SELECT 1 FROM user_knowledge_sources access
            WHERE access."sourceId" = chunk."sourceId" AND access."userId" = $2 AND access.enabled = true
          )
        )
          AND chunk.embedding IS NOT NULL
          ${documentFilter}
        ORDER BY chunk.embedding <=> $1::vector(768)
        LIMIT $4`,
        parameters,
      );
      return rows
        .map((row: any) => ({
          fileName: row.fileName,
          chunkIndex: Number(row.chunkIndex),
          content: row.content,
          score: Number(row.score),
        }))
        .filter((row: RelevantChunkResult) => row.score >= 0.3);
    } catch (error: any) {
      this.pgVectorAvailable = false;
      this.logger.warn(
        `pgvector search unavailable; using application fallback: ${error.message}`,
      );
      return undefined;
    }
  }

  private async hasPgVector(): Promise<boolean> {
    if (this.pgVectorAvailable !== undefined) return this.pgVectorAvailable;
    try {
      const rows = await this.chunkRepository.query(
        `SELECT EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          JOIN pg_class relation ON relation.oid = attribute.attrelid
          WHERE relation.relname = 'document_chunks'
            AND attribute.attname = 'embedding'
            AND format_type(attribute.atttypid, attribute.atttypmod) = 'vector(768)'
        ) AS available`,
      );
      this.pgVectorAvailable = rows[0]?.available === true;
    } catch {
      this.pgVectorAvailable = false;
    }
    return this.pgVectorAvailable;
  }
}
