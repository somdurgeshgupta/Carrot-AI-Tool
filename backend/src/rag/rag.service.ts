import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocumentChunkEntity } from '../entities/document-chunk.entity';
import * as fs from 'fs';
import * as path from 'path';
// pdf-parse v2 exports a class, not a default function
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PDFParse } = require('pdf-parse');
import axios from 'axios';

export interface UserDocumentSummary {
  fileName: string;
  fileType: string;
  chunkCount: number;
  createdAt: Date;
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

  constructor(
    @InjectRepository(DocumentChunkEntity)
    private readonly chunkRepository: Repository<DocumentChunkEntity>,
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
  ): Promise<{ fileName: string; chunkCount: number }> {
    const userDir = path.join(this.uploadsDir, userId);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }

    const targetPath = path.join(userDir, fileName);
    fs.writeFileSync(targetPath, fileBuffer);

    const fileExt = path.extname(fileName).toLowerCase().replace('.', '') || 'txt';
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
      throw new BadRequestException(`Failed to extract text from file ${fileName}`);
    }

    if (!rawText.trim()) {
      throw new BadRequestException(`No readable text found in file ${fileName}`);
    }

    // Split text into ~800 character chunks with 100 character overlap
    const chunks = this.chunkText(rawText, 800, 100);

    // Delete pre-existing chunks for this user & filename if re-uploading
    await this.chunkRepository.delete({ userId, fileName });

    const chunkEntities: DocumentChunkEntity[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      const embedding = await this.generateEmbedding(chunkText, customLocalUrl);

      const entity = this.chunkRepository.create({
        userId,
        fileName,
        fileType: fileExt,
        chunkIndex: i,
        content: chunkText,
        embedding,
      });

      chunkEntities.push(entity);
    }

    await this.chunkRepository.save(chunkEntities);
    this.logger.log(`Indexed document [${fileName}] for user [${userId}] into ${chunkEntities.length} chunks.`);

    return {
      fileName,
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
    let userChunks = await this.chunkRepository.find({ where: { userId } });
    if (!userChunks || userChunks.length === 0) {
      return [];
    }

    if (selectedDocNames && selectedDocNames.length > 0) {
      const selectedSet = new Set(selectedDocNames);
      userChunks = userChunks.filter(c => selectedSet.has(c.fileName));
      if (userChunks.length === 0) return [];
    }

    const cleanQuery = query.trim().toLowerCase();

    // 1. Casual Chat & Small-Talk Filter: Skip RAG for simple greetings or non-informative prompts
    const casualPatterns = [
      /^(hi|hello|hey|greetings|good\s+(morning|afternoon|evening)|hola|howdy)(\s+.*)?$/i,
      /^(how\s+are\s+you|who\s+are\s+you|what\s+can\s+you\s+do|thanks|thank\s+you|ok|okay|cool|bye|goodbye)$/i,
      /^(write|create|generate|explain|code)\s+a?\s*(python|javascript|typescript|c\+\+|java|html|css|sql)?\s*(script|function|program|code|component)?$/i
    ];

    const isCasual = casualPatterns.some(pattern => pattern.test(cleanQuery)) && cleanQuery.split(/\s+/).length <= 6;
    if (isCasual) {
      this.logger.log(`Skipping RAG document lookup for casual/generic prompt: "${query}"`);
      return [];
    }

    const queryEmbedding = await this.generateEmbedding(query, customLocalUrl);
    const queryWords = cleanQuery.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);

    const scored = userChunks
      .map((chunk) => {
        let score = this.calculateCosineSimilarity(queryEmbedding, chunk.embedding || []);

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
      .filter((c) => c.score >= 0.30) // Strict similarity threshold (0.30+) to ignore irrelevant matches
      .sort((a, b) => b.score - a.score);

    this.logger.log(`RAG query ["${query.slice(0, 40)}..."] matched ${scored.length} chunks (top score: ${scored[0]?.score.toFixed(3) || 0})`);
    return scored.slice(0, topK);
  }

  /**
   * List uploaded documents for a user & auto-clean orphaned files on disk
   */
  async getUserDocuments(userId: string): Promise<UserDocumentSummary[]> {
    const chunks = await this.chunkRepository.find({ where: { userId } });
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
              this.logger.log(`Cleaned up orphaned file from disk: [${file}] for user [${userId}]`);
            } catch (e: any) {
              this.logger.warn(`Could not remove orphan file ${file}: ${e.message}`);
            }
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(`Error during orphan file scan: ${err.message}`);
    }

    return Array.from(docsMap.values());
  }

  /**
   * Delete a document and its stored vector embeddings (future-proof & synchronized)
   */
  async deleteDocument(userId: string, fileName: string): Promise<{ success: boolean }> {
    const safeFileName = path.basename(fileName);

    // 1. Delete vector embeddings from PostgreSQL database
    await this.chunkRepository.delete({ userId, fileName });

    // 2. Delete physical file from disk
    const userDir = path.join(this.uploadsDir, userId);
    const filePath = path.join(userDir, safeFileName);

    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        this.logger.log(`Deleted file from disk: [${safeFileName}] for user [${userId}]`);
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
  private async generateEmbedding(text: string, customLocalUrl?: string): Promise<number[]> {
    const baseUrl = customLocalUrl || 'http://localhost:11434/v1';
    const rootUrl = baseUrl.replace(/\/v1$/, '');

    // Try 1: Call Ollama native embeddings API
    try {
      const response = await axios.post(`${rootUrl}/api/embeddings`, {
        model: 'nomic-embed-text',
        prompt: text,
      }, { timeout: 3000 });

      if (response.data && Array.isArray(response.data.embedding)) {
        return response.data.embedding;
      }
    } catch (err) {
      // Fall through to local vectorizer
    }

    // Try 2: Try standard model embedding via /api/embeddings
    try {
      const response = await axios.post(`${rootUrl}/api/embeddings`, {
        model: 'llama3.2:3b',
        prompt: text,
      }, { timeout: 3000 });

      if (response.data && Array.isArray(response.data.embedding)) {
        return response.data.embedding;
      }
    } catch (err) {
      // Fall through
    }

    // Fallback: Super fast 384-dimensional character n-gram TF-IDF vectorizer (100% offline & local)
    return this.fallbackVectorize(text);
  }

  /**
   * Deterministic 384-dim normalized vector representation
   */
  private fallbackVectorize(text: string, dimensions = 384): number[] {
    const vector = new Array(dimensions).fill(0);
    const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);

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
    const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
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
}
