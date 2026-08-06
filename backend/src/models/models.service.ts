import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as dotenv from 'dotenv';
import * as path from 'path';
import axios from 'axios';

export interface AIModel {
  id: string;
  name: string;
  provider: 'local' | 'openai' | 'deepseek' | 'kimi' | 'gemini' | 'groq';
  providerName: string;
  description: string;
  isLocal: boolean;
  contextWindow: number;
  badge: string;
  available: boolean;
}

export interface SystemHealthStatus {
  localServer: {
    connected: boolean;
    baseUrl: string;
    detectedModels: string[];
    error?: string;
  };
  cloudProviders: {
    openai: { configured: boolean };
    deepseek: { configured: boolean };
    kimi: { configured: boolean };
    gemini: { configured: boolean };
    groq: { configured: boolean };
  };
}

@Injectable()
export class ModelsService {
  private readonly logger = new Logger(ModelsService.name);

  constructor(private readonly configService: ConfigService) {}

  private refreshEnv(): void {
    const backendPath = path.resolve(process.cwd(), 'backend', '.env');
    const rootPath = path.resolve(process.cwd(), '.env');
    dotenv.config({ path: backendPath, override: true });
    dotenv.config({ path: rootPath, override: true });
  }

  public getLocalBaseUrl(customUrl?: string): string {
    this.refreshEnv();
    const url = customUrl || process.env.LOCAL_AI_BASE_URL || this.configService.get<string>('LOCAL_AI_BASE_URL') || 'http://localhost:11434/v1';
    return url.replace(/\/$/, '');
  }

  async checkHealth(customLocalUrl?: string): Promise<SystemHealthStatus> {
    this.refreshEnv();
    const baseUrl = this.getLocalBaseUrl(customLocalUrl);
    let localConnected = false;
    let detectedModels: string[] = [];
    let localError: string | undefined;

    try {
      // Primary check: OpenAI-compatible /v1/models endpoint
      const response = await axios.get(`${baseUrl}/models`, { timeout: 3000 });
      if (response.data && Array.isArray(response.data.data)) {
        localConnected = true;
        detectedModels = response.data.data.map((m: any) => m.id || m.name);
      }
    } catch (err: any) {
      // Fallback check: Native Ollama /api/tags endpoint
      try {
        const rootUrl = baseUrl.replace(/\/v1$/, '');
        const nativeResponse = await axios.get(`${rootUrl}/api/tags`, { timeout: 3000 });
        if (nativeResponse.data && Array.isArray(nativeResponse.data.models)) {
          localConnected = true;
          detectedModels = nativeResponse.data.models.map((m: any) => m.name || m.model);
        }
      } catch (nativeErr: any) {
        localError = nativeErr.message || 'Local Ollama/AI server offline';
        this.logger.warn(`Local AI Health check failed at ${baseUrl}: ${localError}`);
      }
    }

    const openAiKey = (process.env.OPENAI_API_KEY || this.configService.get<string>('OPENAI_API_KEY') || '').trim();
    const deepseekKey = (process.env.DEEPSEEK_API_KEY || this.configService.get<string>('DEEPSEEK_API_KEY') || '').trim();
    const kimiKey = (process.env.KIMI_API_KEY || this.configService.get<string>('KIMI_API_KEY') || '').trim();
    const geminiKey = (process.env.GEMINI_API_KEY || this.configService.get<string>('GEMINI_API_KEY') || '').trim();
    const groqKey = (process.env.GROQ_API_KEY || this.configService.get<string>('GROQ_API_KEY') || '').trim();

    return {
      localServer: {
        connected: localConnected,
        baseUrl,
        detectedModels,
        error: localError,
      },
      cloudProviders: {
        openai: { configured: openAiKey.length > 0 },
        deepseek: { configured: deepseekKey.length > 0 },
        kimi: { configured: kimiKey.length > 0 },
        gemini: { configured: geminiKey.length > 0 },
        groq: { configured: groqKey.length > 0 },
      },
    };
  }

  async getAvailableModels(customLocalUrl?: string): Promise<{ local: AIModel[]; cloud: AIModel[] }> {
    const health = await this.checkHealth(customLocalUrl);
    const localModels: AIModel[] = [];

    // If local server has detected installed Ollama models, load them live!
    if (health.localServer.connected && health.localServer.detectedModels.length > 0) {
      for (const modelId of health.localServer.detectedModels) {
        localModels.push({
          id: `local:${modelId}`,
          name: this.formatModelName(modelId),
          provider: 'local',
          providerName: 'Local Machine (Ollama)',
          description: `Installed local Ollama model (${modelId}) on ${health.localServer.baseUrl}`,
          isLocal: true,
          contextWindow: 131072,
          badge: '🔒 Private Installed',
          available: true,
        });
      }
    } else {
      const defaultLocals = [
        { id: 'local:qwen3:8b', name: 'Qwen 3 8B', desc: 'Alibaba Qwen 3 8B Instruct Model (Default)' },
        { id: 'local:qwen2.5-coder:7b', name: 'Qwen 2.5 Coder 7B', desc: 'Alibaba Qwen 2.5 Coder 7B Model' },
        { id: 'local:llama3.2:3b', name: 'Llama 3.2 3B', desc: 'Meta Llama 3.2 3B Model' },
      ];

      for (const item of defaultLocals) {
        localModels.push({
          id: item.id,
          name: item.name,
          provider: 'local',
          providerName: 'Local Machine',
          description: item.desc,
          isLocal: true,
          contextWindow: 8192,
          badge: '🔒 Private Local',
          available: health.localServer.connected,
        });
      }
    }

    // Always sort localModels so Qwen models appear at the top of the list!
    localModels.sort((a, b) => {
      const aIsQwen3 = a.id.toLowerCase().includes('qwen3') || a.id.toLowerCase().includes('qwen-3');
      const bIsQwen3 = b.id.toLowerCase().includes('qwen3') || b.id.toLowerCase().includes('qwen-3');
      if (aIsQwen3 && !bIsQwen3) return -1;
      if (!aIsQwen3 && bIsQwen3) return 1;

      const aIsQwen = a.id.toLowerCase().includes('qwen');
      const bIsQwen = b.id.toLowerCase().includes('qwen');
      if (aIsQwen && !bIsQwen) return -1;
      if (!aIsQwen && bIsQwen) return 1;
      return 0;
    });

    // Strictly 100% Free Working Cloud Models List
    const cloudModels: AIModel[] = [
      {
        id: 'groq:llama-3.3-70b-versatile',
        name: 'Meta Llama 3.3 70B (Groq 100% Free)',
        provider: 'groq',
        providerName: 'Groq Cloud',
        description: 'Ultra-fast Meta Llama 3.3 70B model running at 800 tokens/sec',
        isLocal: false,
        contextWindow: 128000,
        badge: '⚡ Groq Free',
        available: health.cloudProviders.groq.configured || true,
      },
      {
        id: 'groq:llama-3.1-8b-instant',
        name: 'Meta Llama 3.1 8B Instant (Groq 100% Free)',
        provider: 'groq',
        providerName: 'Groq Cloud',
        description: 'Lightning fast Meta Llama 3.1 8B model on Groq hardware',
        isLocal: false,
        contextWindow: 128000,
        badge: '⚡ Groq Free',
        available: health.cloudProviders.groq.configured || true,
      },
      {
        id: 'groq:qwen/qwen3.6-27b',
        name: 'Qwen 3.6 27B (Groq 100% Free)',
        provider: 'groq',
        providerName: 'Groq Cloud',
        description: 'Alibaba Qwen 3.6 27B high-speed reasoning model',
        isLocal: false,
        contextWindow: 128000,
        badge: '⚡ Groq Free',
        available: health.cloudProviders.groq.configured || true,
      },
      {
        id: 'gemini:gemini-3.6-flash',
        name: 'Google Gemini 3.6 Flash (100% Free)',
        provider: 'gemini',
        providerName: 'Google AI',
        description: 'Google flagship high-speed multimodal AI model',
        isLocal: false,
        contextWindow: 1000000,
        badge: '✨ Gemini Free',
        available: health.cloudProviders.gemini.configured || true,
      },
      {
        id: 'gemini:gemini-3.5-flash',
        name: 'Google Gemini 3.5 Flash (100% Free)',
        provider: 'gemini',
        providerName: 'Google AI',
        description: 'Google ultra-fast balanced multimodal model',
        isLocal: false,
        contextWindow: 1000000,
        badge: '✨ Gemini Free',
        available: health.cloudProviders.gemini.configured || true,
      },
    ];

    return { local: localModels, cloud: cloudModels };
  }

  private formatModelName(modelId: string): string {
    const clean = modelId.replace(/^local:/, '').replace(/:latest$/, '');
    const parts = clean.split(':');
    const baseName = parts[0].split(/[\-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const tag = parts[1] ? ` (${parts[1].toUpperCase()})` : '';
    return `${baseName}${tag}`;
  }
}
