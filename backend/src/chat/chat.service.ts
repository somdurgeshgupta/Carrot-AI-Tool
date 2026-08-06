import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsString, IsArray, IsOptional, IsNumber, IsBoolean, IsObject } from 'class-validator';
import * as dotenv from 'dotenv';
import * as path from 'path';
import axios from 'axios';
import { Response } from 'express';
import { SessionsService } from '../sessions/sessions.service';
import { RagService } from '../rag/rag.service';

export class ChatMessage {
  @IsString()
  role: 'system' | 'user' | 'assistant';

  @IsString()
  content: string;
}

export class ApiKeysDto {
  @IsOptional()
  @IsString()
  openaiApiKey?: string;

  @IsOptional()
  @IsString()
  deepseekApiKey?: string;

  @IsOptional()
  @IsString()
  kimiApiKey?: string;

  @IsOptional()
  @IsString()
  geminiApiKey?: string;

  @IsOptional()
  @IsString()
  groqApiKey?: string;
}

export class ChatRequestDto {
  @IsString()
  modelId: string;

  @IsArray()
  messages: ChatMessage[];

  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  @IsNumber()
  temperature?: number;

  @IsOptional()
  @IsString()
  systemPrompt?: string;

  @IsOptional()
  @IsBoolean()
  stream?: boolean;

  @IsOptional()
  @IsString()
  localServerUrl?: string;

  @IsOptional()
  @IsObject()
  apiKeys?: ApiKeysDto;

  @IsOptional()
  @IsBoolean()
  ragEnabled?: boolean;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsArray()
  selectedDocNames?: string[];

  @IsOptional()
  @IsBoolean()
  webSearchEnabled?: boolean;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly sessionsService: SessionsService,
    private readonly ragService: RagService,
  ) {}

  private refreshEnv(): void {
    const backendPath = path.resolve(process.cwd(), 'backend', '.env');
    const rootPath = path.resolve(process.cwd(), '.env');
    dotenv.config({ path: backendPath, override: true });
    dotenv.config({ path: rootPath, override: true });
  }

  async handleChatCompletion(dto: ChatRequestDto, res?: Response) {
    this.refreshEnv();
    const { provider, modelName } = this.parseModelId(dto.modelId);
    const { endpoint, apiKey, isLocal } = this.resolveEndpointAndKey(provider, dto);

    this.logger.log(`Routing prompt to Provider: [${provider.toUpperCase()}] | Model: [${modelName}] | IsLocal: [${isLocal}]`);

    // Always inject current system date & time into system context
    const now = new Date();
    const currentDateStr = now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    const dateTimeContext = `System Information:\n- Current Date & Time: ${currentDateStr} (ISO: ${now.toISOString()})\n- You ALWAYS know the exact current date, time, and year when asked.`;

    // Prepare full messages payload
    const formattedMessages: ChatMessage[] = [
      { role: 'system', content: dateTimeContext }
    ];

    if (dto.systemPrompt && dto.systemPrompt.trim().length > 0) {
      formattedMessages.push({ role: 'system', content: dto.systemPrompt.trim() });
    }

    // Perform RAG retrieval if enabled
    const messagesForModel: ChatMessage[] = dto.messages.map((m) => ({ ...m }));
    const lastUserMsg = messagesForModel[messagesForModel.length - 1];

    if (dto.ragEnabled && dto.userId && lastUserMsg && lastUserMsg.role === 'user') {
      try {
        const chunks = await this.ragService.searchSimilarChunks(
          dto.userId,
          lastUserMsg.content,
          3,
          dto.localServerUrl,
          dto.selectedDocNames,
        );
        if (chunks.length > 0) {
          const contextText = chunks
            .map((c, i) => `[Citation ${i + 1} - "${c.fileName}", Chunk ${c.chunkIndex + 1}]:\n${c.content}`)
            .join('\n\n');

          const ragInstruction = `The user has provided relevant document excerpts from their private files:\n\n--- PRIVATE DOCUMENT EXCERPTS ---\n${contextText}\n--- END EXCERPTS ---\n\nINSTRUCTIONS:\n1. Use the facts from the document excerpts above to answer accurately.\n2. When citing information, cite the exact source badge (e.g. [Citation 1 - "filename.pdf"]).`;

          formattedMessages.unshift({ role: 'system', content: ragInstruction });
          this.logger.log(`Injected ${chunks.length} document chunks into RAG prompt context.`);
        }
      } catch (e: any) {
        this.logger.warn(`RAG retrieval failed: ${e.message}`);
      }
    }

    // Perform Web Search if enabled
    if (dto.webSearchEnabled && lastUserMsg && lastUserMsg.role === 'user') {
      const originalQuery = lastUserMsg.content;
      try {
        const webSnippets = await this.performWebSearch(originalQuery);
        if (webSnippets) {
          const webInstruction = `You are Carrot AI assistant with REAL-TIME INTERNET ACCESS.\nHere are the LIVE real-time web search results for "${originalQuery}":\n\n--- LIVE WEB SEARCH RESULTS ---\n${webSnippets}\n--- END LIVE WEB RESULTS ---\n\nCRITICAL MANDATES FOR MODEL RESPONSE:\n1. Extract and directly state the exact versions, numbers, weather, dates, or facts from the LIVE WEB SEARCH RESULTS above.\n2. NEVER tell the user to check external websites or official pages themselves. You MUST provide the answer directly in your response.\n3. OVERRIDE any outdated knowledge from your historical training data with the live search results.`;

          formattedMessages.unshift({ role: 'system', content: webInstruction });
          lastUserMsg.content = `[LIVE REAL-TIME SEARCH DATA]:\n${webSnippets}\n\n[USER QUESTION]: ${originalQuery}\n\n(Instruction: Answer the user's question directly using the live search data above. Do not tell the user to look it up on external sites.)`;
          this.logger.log(`Injected live web search results into prompt context and user message.`);
        }
      } catch (e: any) {
        this.logger.warn(`Web search failed: ${e.message}`);
      }
    }

    formattedMessages.push(...messagesForModel);

    // Sanitize messages array: strip extra non-standard properties like isLocal, modelId before sending to AI providers (Groq, OpenAI, Gemini, etc.)
    const cleanMessages = formattedMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const requestBody = {
      model: modelName,
      messages: cleanMessages,
      temperature: dto.temperature ?? 0.7,
      stream: dto.stream ?? true,
    };


    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (apiKey && apiKey.trim().length > 0) {
      headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    }

    if (dto.stream && res) {
      return this.streamChatCompletion(endpoint, requestBody, headers, res, dto);
    } else {
      return this.fetchJsonChatCompletion(endpoint, requestBody, headers, dto);
    }
  }

  private async fetchJsonChatCompletion(endpoint: string, body: any, headers: Record<string, string>, dto: ChatRequestDto) {
    try {
      const response = await axios.post(endpoint, body, { headers, timeout: 60000 });
      const assistantText = response.data.choices?.[0]?.message?.content || '';
      
      if (dto.sessionId && assistantText) {
        const lastUserMsg = dto.messages[dto.messages.length - 1];
        if (lastUserMsg && lastUserMsg.role === 'user') {
          await this.sessionsService.appendMessage(dto.sessionId, 'user', lastUserMsg.content, dto.modelId);
        }
        await this.sessionsService.appendMessage(dto.sessionId, 'assistant', assistantText, dto.modelId);
      }


      return response.data;
    } catch (error: any) {
      this.handleApiError(error, endpoint);
    }
  }

  private async streamChatCompletion(endpoint: string, body: any, headers: Record<string, string>, res: Response, dto: ChatRequestDto) {
    let accumulatedAssistantText = '';

    // Pre-save user prompt immediately to database so it is never lost on navigation or page switch
    if (dto.sessionId && dto.messages && dto.messages.length > 0) {
      try {
        const lastUserMsg = dto.messages[dto.messages.length - 1];
        if (lastUserMsg && lastUserMsg.role === 'user') {
          await this.sessionsService.appendMessage(dto.sessionId, 'user', lastUserMsg.content, dto.modelId);
        }
      } catch (e: any) {
        this.logger.error(`Failed to pre-save user prompt: ${e.message}`);
      }
    }

    try {
      // Connect to AI provider stream FIRST before sending SSE headers to Express response
      const response = await axios.post(endpoint, body, {
        headers,
        responseType: 'stream',
        timeout: 120000,
      });

      // Flushed SSE response headers ONLY on success
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      response.data.on('data', (chunk: Buffer) => {
        const str = chunk.toString('utf-8');
        res.write(chunk);

        // Accumulate text for session database saving
        const lines = str.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
            try {
              const json = JSON.parse(trimmed.replace(/^data:\s*/, ''));
              const content = json.choices?.[0]?.delta?.content || json.choices?.[0]?.text || '';
              if (content) {
                accumulatedAssistantText += content;
              }
            } catch (e) {
              // ignore parse errors during raw chunk stream
            }
          }
        }
      });

      let hasSavedAssistant = false;
      const saveAssistantMessage = async () => {
        if (!hasSavedAssistant && dto.sessionId && accumulatedAssistantText.trim().length > 0) {
          hasSavedAssistant = true;
          try {
            await this.sessionsService.appendMessage(dto.sessionId, 'assistant', accumulatedAssistantText, dto.modelId);
            this.logger.log(`Saved assistant response (${accumulatedAssistantText.length} chars) to session ${dto.sessionId}`);
          } catch (e: any) {
            this.logger.error(`Failed to save assistant message: ${e.message}`);
          }
        }
      };

      response.data.on('end', async () => {
        res.write('data: [DONE]\n\n');
        res.end();
        await saveAssistantMessage();
      });

      res.on('close', async () => {
        await saveAssistantMessage();
      });

      response.data.on('error', (err: any) => {
        this.logger.error(`Stream transmission error: ${err.message}`);
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      });
    } catch (error: any) {
      let errorMsg = 'Failed to connect to AI provider';

      if (error.response?.data) {
        try {
          const chunks: Buffer[] = [];
          if (typeof error.response.data.on === 'function') {
            for await (const chunk of error.response.data) {
              chunks.push(Buffer.from(chunk));
            }
            const rawBody = Buffer.concat(chunks).toString('utf-8');
            const parsed = JSON.parse(rawBody);
            errorMsg = parsed.error?.message || parsed.message || rawBody;
          } else if (error.response.data.error?.message) {
            errorMsg = error.response.data.error.message;
          }
        } catch (e) {
          errorMsg = error.message || errorMsg;
        }
      } else if (error.message) {
        errorMsg = error.message;
      }

      this.logger.error(`Stream initiation failed for ${endpoint}: ${errorMsg}`);

      if (!res.headersSent) {
        res.status(HttpStatus.BAD_REQUEST).json({ error: errorMsg, message: errorMsg });
      }
    }
  }

  private parseModelId(fullModelId: string): { provider: string; modelName: string } {
    if (!fullModelId.includes(':')) {
      return { provider: 'local', modelName: fullModelId };
    }
    const parts = fullModelId.split(':');
    const provider = parts[0];
    const modelName = parts.slice(1).join(':');
    return { provider, modelName };
  }

  private resolveEndpointAndKey(provider: string, dto: ChatRequestDto): { endpoint: string; apiKey?: string; isLocal: boolean } {
    this.refreshEnv();
    switch (provider.toLowerCase()) {
      case 'local': {
        const baseUrl = (dto.localServerUrl || process.env.LOCAL_AI_BASE_URL || this.configService.get<string>('LOCAL_AI_BASE_URL') || 'http://localhost:11434/v1').replace(/\/$/, '');
        return {
          endpoint: `${baseUrl}/chat/completions`,
          isLocal: true,
        };
      }
      case 'groq': {
        const key = (dto.apiKeys?.groqApiKey || process.env.GROQ_API_KEY || this.configService.get<string>('GROQ_API_KEY') || '').trim();
        if (!key) {
          throw new HttpException('Groq API Key is missing. Please configure GROQ_API_KEY in .env or Settings.', HttpStatus.UNAUTHORIZED);
        }
        return {
          endpoint: 'https://api.groq.com/openai/v1/chat/completions',
          apiKey: key,
          isLocal: false,
        };
      }
      case 'gemini': {
        const key = (dto.apiKeys?.geminiApiKey || process.env.GEMINI_API_KEY || this.configService.get<string>('GEMINI_API_KEY') || '').trim();
        if (!key) {
          throw new HttpException('Google Gemini API Key is missing. Please configure GEMINI_API_KEY in .env or Settings.', HttpStatus.UNAUTHORIZED);
        }
        return {
          endpoint: `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions?key=${key}`,
          apiKey: key,
          isLocal: false,
        };
      }
      case 'openai': {
        const key = (dto.apiKeys?.openaiApiKey || process.env.OPENAI_API_KEY || this.configService.get<string>('OPENAI_API_KEY') || '').trim();
        if (!key) {
          throw new HttpException('OpenAI API Key is missing. Please configure OPENAI_API_KEY in .env or Settings.', HttpStatus.UNAUTHORIZED);
        }
        return {
          endpoint: 'https://api.openai.com/v1/chat/completions',
          apiKey: key,
          isLocal: false,
        };
      }
      case 'deepseek': {
        const key = (dto.apiKeys?.deepseekApiKey || process.env.DEEPSEEK_API_KEY || this.configService.get<string>('DEEPSEEK_API_KEY') || '').trim();
        if (!key) {
          throw new HttpException('DeepSeek API Key is missing. Please configure DEEPSEEK_API_KEY in .env or Settings.', HttpStatus.UNAUTHORIZED);
        }
        return {
          endpoint: 'https://api.deepseek.com/v1/chat/completions',
          apiKey: key,
          isLocal: false,
        };
      }
      case 'kimi': {
        const key = (dto.apiKeys?.kimiApiKey || process.env.KIMI_API_KEY || this.configService.get<string>('KIMI_API_KEY') || '').trim();
        if (!key) {
          throw new HttpException('Kimi (Moonshot) API Key is missing. Please configure KIMI_API_KEY in .env or Settings.', HttpStatus.UNAUTHORIZED);
        }
        return {
          endpoint: 'https://api.moonshot.ai/v1/chat/completions',
          apiKey: key,
          isLocal: false,
        };
      }
      default: {
        const baseUrl = (dto.localServerUrl || process.env.LOCAL_AI_BASE_URL || this.configService.get<string>('LOCAL_AI_BASE_URL') || 'http://localhost:11434/v1').replace(/\/$/, '');
        return {
          endpoint: `${baseUrl}/chat/completions`,
          isLocal: true,
        };
      }
    }
  }

  private handleApiError(error: any, endpoint: string) {
    const status = error.response?.status || HttpStatus.INTERNAL_SERVER_ERROR;
    const message = error.response?.data?.error?.message || error.response?.data?.message || error.message || 'Error executing AI model completion';
    this.logger.error(`AI Provider error at [${endpoint}]: ${message}`);
    throw new HttpException(message, status);
  }

  private async performWebSearch(query: string): Promise<string> {
    const snippets: string[] = [];
    const lowerQuery = query.toLowerCase();

    // 1. Node.js Official Release Registry
    if (/(node(\.js)?|nodejs)/i.test(lowerQuery) && /(version|latest|current|release|lts)/i.test(lowerQuery)) {
      try {
        const resNode = await axios.get('https://nodejs.org/dist/index.json', { timeout: 4000 });
        if (Array.isArray(resNode.data) && resNode.data.length > 0) {
          const current = resNode.data[0];
          const lts = resNode.data.find((r: any) => r.lts);
          let nodeInfo = `[Official Node.js Release Registry]: Current Latest Released Version is ${current.version} (Released Date: ${current.date}).`;
          if (lts) {
            nodeInfo += ` Current Active LTS Version is ${lts.version} (Codename: ${lts.lts}).`;
          }
          snippets.push(nodeInfo);
        }
      } catch (e: any) {
        this.logger.warn(`Node.js dist API failed: ${e.message}`);
      }
    }

    // 3. endoflife.date API for tech/frameworks/languages
    const eolProducts = [
      'nodejs', 'python', 'angular', 'react', 'vue', 'go', 'rust', 'java',
      'docker', 'postgres', 'mysql', 'ubuntu', 'nextjs', 'laravel', 'php',
      'ruby', 'csharp', 'dotnet', 'kubernetes', 'terraform', 'kotlin', 'swift'
    ];
    for (const prod of eolProducts) {
      if (lowerQuery.includes(prod) || (prod === 'nodejs' && lowerQuery.includes('node'))) {
        try {
          const resEol = await axios.get(`https://endoflife.date/api/${prod}.json`, { timeout: 3000 });
          if (Array.isArray(resEol.data) && resEol.data.length > 0) {
            const latest = resEol.data[0];
            snippets.push(
              `[endoflife.date Registry - ${prod.toUpperCase()}]: Latest Cycle: ${latest.cycle}, Latest Version: ${latest.latest} (Released: ${latest.releaseDate}, LTS Status: ${latest.lts || 'No'})`
            );
            break;
          }
        } catch (e) {}
      }
    }

    // 4. NPM package lookup
    const pkgMatch = lowerQuery.match(/(angular|react|vue|next|express|nest|typescript|tailwind|bootstrap|svelte|rxjs|vite|webpack)/i);
    if (pkgMatch) {
      const rawPkg = pkgMatch[1];
      const pkgName = rawPkg === 'angular' ? '@angular/core' : rawPkg;
      try {
        const res = await axios.get(`https://registry.npmjs.org/${pkgName}/latest`, { timeout: 3000 });
        if (res.data && res.data.version) {
          snippets.push(`[NPM Package Registry - ${res.data.name}]: Current latest released version is ${res.data.version}`);
        }
      } catch (e) {}
    }

    // 5. PyPI package lookup
    const pypiMatch = lowerQuery.match(/(django|flask|fastapi|pandas|numpy|scipy|tensorflow|torch|scikit-learn|requests)/i);
    if (pypiMatch) {
      const pkg = pypiMatch[1];
      try {
        const resPy = await axios.get(`https://pypi.org/pypi/${pkg}/json`, { timeout: 3000 });
        if (resPy.data?.info?.version) {
          snippets.push(`[PyPI Package Registry - ${pkg}]: Current latest version is ${resPy.data.info.version}`);
        }
      } catch (e) {}
    }

    // 6. Weather lookup
    if (/(weather|temperature|forecast|rain|climate)/i.test(lowerQuery)) {
      const words = query.replace(/[^a-zA-Z\s]/g, '').split(/\s+/);
      const stopWords = new Set(['weather', 'in', 'the', 'for', 'today', 'now', 'current', 'temperature', 'forecast', 'what', 'is', 'how', 'like']);
      const locCandidates = words.filter(w => !stopWords.has(w.toLowerCase()) && w.length > 2);
      const location = locCandidates.join(' ') || 'London';
      try {
        const resWttr = await axios.get(`https://wttr.in/${encodeURIComponent(location)}?format=3`, { timeout: 3000 });
        if (resWttr.data && typeof resWttr.data === 'string' && !resWttr.data.includes('Unknown location')) {
          snippets.push(`[Live Weather Report]: ${resWttr.data.trim()}`);
        }
      } catch (e) {}
    }

    // 7. Google News RSS search
    try {
      this.logger.log(`Fetching Google News RSS search for: "${query}"`);
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
      const rssRes = await axios.get(rssUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 4000
      });
      const xml = rssRes.data;
      if (typeof xml === 'string') {
        const titleRegex = /<title>([\s\S]*?)<\/title>/gi;
        let match;
        let count = 0;
        while ((match = titleRegex.exec(xml)) !== null && snippets.length < 8) {
          count++;
          if (count === 1) continue; // Skip RSS feed main title
          const cleanTitle = match[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
          if (cleanTitle && !cleanTitle.includes('Google News')) {
            snippets.push(`[Google News Headline]: ${cleanTitle}`);
          }
        }
      }
    } catch (e: any) {
      this.logger.warn(`Google News RSS search failed: ${e.message}`);
    }

    // 8. Wikipedia API
    if (snippets.length < 4) {
      try {
        const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`;
        const wikiRes = await axios.get(wikiUrl, { timeout: 3500 });
        if (wikiRes.data?.query?.search) {
          const searchResults = wikiRes.data.query.search.slice(0, 3);
          for (const item of searchResults) {
            const cleanSnippet = item.snippet.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            if (cleanSnippet) {
              snippets.push(`[Wikipedia - ${item.title}]: ${cleanSnippet}`);
            }
          }
        }
      } catch (e: any) {
        this.logger.warn(`Wikipedia API search failed: ${e.message}`);
      }
    }

    // 9. DuckDuckGo Instant Answer API
    if (snippets.length < 4) {
      try {
        const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
        const ddgRes = await axios.get(ddgUrl, { timeout: 3500 });
        if (ddgRes.data) {
          if (ddgRes.data.AbstractText) {
            snippets.push(`[DuckDuckGo Knowledge]: ${ddgRes.data.AbstractText}`);
          }
          if (ddgRes.data.Answer) {
            snippets.push(`[DuckDuckGo Answer]: ${ddgRes.data.Answer}`);
          }
        }
      } catch (e: any) {
        this.logger.warn(`DuckDuckGo API search failed: ${e.message}`);
      }
    }

    const resultsText = snippets.map((s, i) => `[Live Web Result ${i + 1}]: ${s}`).join('\n\n');
    this.logger.log(`Web search engine returned ${snippets.length} live snippets.`);
    return resultsText;
  }
}
