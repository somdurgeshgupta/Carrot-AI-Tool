import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsString, IsArray, IsOptional, IsNumber, IsBoolean, IsObject } from 'class-validator';
import * as dotenv from 'dotenv';
import * as path from 'path';
import axios from 'axios';
import { Response } from 'express';
import { SessionsService } from '../sessions/sessions.service';

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
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly sessionsService: SessionsService,
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

    // Prepare full messages payload
    const formattedMessages: ChatMessage[] = [];
    if (dto.systemPrompt && dto.systemPrompt.trim().length > 0) {
      formattedMessages.push({ role: 'system', content: dto.systemPrompt.trim() });
    }
    formattedMessages.push(...dto.messages);

    const requestBody = {
      model: modelName,
      messages: formattedMessages,
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

      response.data.on('end', async () => {
        res.write('data: [DONE]\n\n');
        res.end();

        // Auto-save user prompt and generated assistant response to PostgreSQL session
        if (dto.sessionId && accumulatedAssistantText.trim().length > 0) {
          try {
            const lastUserMsg = dto.messages[dto.messages.length - 1];
            if (lastUserMsg && lastUserMsg.role === 'user') {
              await this.sessionsService.appendMessage(dto.sessionId, 'user', lastUserMsg.content, dto.modelId);
            }
            await this.sessionsService.appendMessage(dto.sessionId, 'assistant', accumulatedAssistantText, dto.modelId);
          } catch (e: any) {
            this.logger.error(`Failed to auto-save session messages: ${e.message}`);
          }
        }

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
    const msg = error.response?.data?.error?.message || error.message || `Error connecting to ${endpoint}`;
    this.logger.error(`API Error [${status}] at ${endpoint}: ${msg}`);
    throw new HttpException({ status: 'error', message: msg, endpoint }, status);
  }
}
