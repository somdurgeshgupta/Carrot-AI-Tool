import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as dotenv from 'dotenv';
import * as path from 'path';
import axios from 'axios';
import { assertTrustedLocalAiUrl } from '../common/local-ai-url';

export type ModelLocation = 'local' | 'cloud';
export type ModelType = 'chat' | 'embedding';

export interface CarrotModel {
  id: string;
  model: string;
  name: string;
  provider: 'ollama' | 'local-openai' | 'groq' | 'gemini' | 'openai' | 'deepseek' | 'kimi';
  location: ModelLocation;
  type: ModelType;
  available: boolean;
  supportsStreaming?: boolean;
  supportsEmbeddings?: boolean;
  agentProtocol?: 'structured-json';
  agentToolStatus?: 'untested';
  preferredForCodingAgent?: boolean;
  supportsNativeTools?: boolean;
}

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
  type: ModelType;
}

export interface ModelCatalogResponse {
  models: CarrotModel[];
  local: AIModel[];
  cloud: AIModel[];
  defaultModelId: string;
}

export interface SystemHealthStatus {
  localServer: { connected: boolean; baseUrl: string; detectedModels: string[]; error?: string };
  cloudProviders: Record<string, { configured: boolean }>;
}

interface LocalDiscoveryResult { models: CarrotModel[]; error?: string }
interface CachedDiscovery extends LocalDiscoveryResult { baseUrl: string; expiresAt: number }
interface CachedCloudDiscovery { models: CarrotModel[]; expiresAt: number }

const EMBEDDING_MODEL_PATTERNS = [
  /(^|[-_:])embed(ding)?([-_:]|$)/i,
  /^nomic-embed/i,
  /^mxbai-embed/i,
  /^all-minilm/i,
  /^bge-(m3|large|base|small)/i,
];

export function classifyOllamaModelType(modelName: string): ModelType {
  return EMBEDDING_MODEL_PATTERNS.some((pattern) => pattern.test(modelName)) ? 'embedding' : 'chat';
}

@Injectable()
export class ModelsService {
  private readonly logger = new Logger(ModelsService.name);
  private localCache?: CachedDiscovery;
  private cloudCache?: CachedCloudDiscovery;
  private readonly cacheDurationMs = 10_000;
  private readonly cloudCacheDurationMs = 30 * 60_000;

  constructor(private readonly configService: ConfigService) {}

  private refreshEnv(): void {
    dotenv.config({ path: path.resolve(process.cwd(), 'backend', '.env'), override: true });
    dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });
  }

  getLocalBaseUrl(customUrl?: string): string {
    this.refreshEnv();
    const url = customUrl || process.env.LOCAL_AI_BASE_URL || this.configService.get<string>('LOCAL_AI_BASE_URL') || 'http://localhost:11434/v1';
    return assertTrustedLocalAiUrl(url, process.env.LOCAL_AI_ALLOWED_HOSTS || this.configService.get<string>('LOCAL_AI_ALLOWED_HOSTS'));
  }

  async getModelCatalog(customLocalUrl?: string, forceRefresh = false): Promise<ModelCatalogResponse> {
    const localDiscovery = await this.discoverLocalModels(this.getLocalBaseUrl(customLocalUrl), forceRefresh);
    const cloudModels = await this.getCloudModels(forceRefresh);
    const models = [...localDiscovery.models, ...cloudModels];
    const configuredDefault = (process.env.DEFAULT_MODEL || this.configService.get<string>('DEFAULT_MODEL') || '').trim();
    const defaultModelId = models.some((model) => model.id === configuredDefault && model.type === 'chat' && model.available)
      ? configuredDefault
      : 'auto';
    return {
      models,
      local: localDiscovery.models.map((model) => this.toLegacyModel(model)),
      cloud: cloudModels.map((model) => this.toLegacyModel(model)),
      defaultModelId,
    };
  }

  async getAvailableModels(customLocalUrl?: string, forceRefresh = false): Promise<ModelCatalogResponse> {
    return this.getModelCatalog(customLocalUrl, forceRefresh);
  }

  async resolveChatModel(requestedId: string, localOnly: boolean, customLocalUrl?: string, agentTask = false): Promise<CarrotModel> {
    const { models } = await this.getModelCatalog(customLocalUrl);
    const availableChatModels = models.filter((model) => model.type === 'chat' && model.available);

    if (!requestedId || requestedId === 'auto') {
      const localModels = availableChatModels.filter((model) => model.location === 'local');
      const local = agentTask
        ? localModels.find((model) => model.preferredForCodingAgent) ?? localModels[0]
        : localModels[0];
      if (local) return local;
      if (localOnly) throw new ServiceUnavailableException('Local-only mode is enabled, but no local chat model is available.');
      const cloud = availableChatModels.find((model) => model.location === 'cloud');
      if (cloud) return cloud;
      throw new ServiceUnavailableException('No chat model is currently available.');
    }

    const selected = models.find((model) => model.id === requestedId);
    if (!selected && requestedId.startsWith('local:')) {
      const fallbackLocal = availableChatModels.find((model) => model.location === 'local');
      if (fallbackLocal) {
        this.logger.warn(`Local model ${requestedId} is no longer installed; using ${fallbackLocal.id}.`);
        return fallbackLocal;
      }
    }
    if (!selected) throw new BadRequestException(`Selected model is unavailable: ${requestedId}`);
    if (selected.type !== 'chat') throw new BadRequestException(`Embedding model cannot be used for chat: ${requestedId}`);
    if (!selected.available) throw new ServiceUnavailableException(`Selected model is not configured or available: ${requestedId}`);
    if (localOnly && selected.location !== 'local') throw new BadRequestException('Local-only mode blocks cloud model requests.');
    return selected;
  }

  async checkHealth(customLocalUrl?: string): Promise<SystemHealthStatus> {
    const baseUrl = this.getLocalBaseUrl(customLocalUrl);
    const local = await this.discoverLocalModels(baseUrl);
    const configured = this.providerConfiguration();
    return {
      localServer: {
        connected: !local.error,
        baseUrl,
        detectedModels: local.models.map((model) => model.model),
        error: local.error,
      },
      cloudProviders: {
        openai: { configured: configured.openai },
        deepseek: { configured: configured.deepseek },
        kimi: { configured: configured.kimi },
        gemini: { configured: configured.gemini },
        groq: { configured: configured.groq },
      },
    };
  }

  private async discoverLocalModels(baseUrl: string, forceRefresh = false): Promise<LocalDiscoveryResult> {
    if (!forceRefresh && this.localCache?.baseUrl === baseUrl && this.localCache.expiresAt > Date.now()) {
      return { models: this.localCache.models, error: this.localCache.error };
    }

    let result: LocalDiscoveryResult;
    const rootUrl = baseUrl.replace(/\/v1$/, '');
    try {
      const response = await axios.get(`${rootUrl}/api/tags`, { timeout: 3000 });
      if (!Array.isArray(response.data?.models)) throw new Error('Ollama returned a malformed model list.');
      result = {
        models: response.data.models
          .filter((entry: any) => typeof (entry?.name || entry?.model) === 'string')
          .map((entry: any) => this.normalizeLocalModel(entry.name || entry.model, 'ollama', Array.isArray(entry.capabilities) ? entry.capabilities : undefined)),
      };
    } catch (ollamaError: any) {
      try {
        const response = await axios.get(`${baseUrl}/models`, { timeout: 3000 });
        if (!Array.isArray(response.data?.data)) throw new Error('Local OpenAI-compatible server returned a malformed model list.');
        result = {
          models: response.data.data
            .map((entry: any) => entry?.id || entry?.name)
            .filter((name: unknown): name is string => typeof name === 'string' && name.trim().length > 0)
            .map((name: string) => this.normalizeLocalModel(name, 'local-openai')),
        };
      } catch (fallbackError: any) {
        const error = fallbackError?.message || ollamaError?.message || 'Local AI server is unavailable.';
        this.logger.warn(`Local model discovery failed at ${baseUrl}: ${error}`);
        result = { models: [], error };
      }
    }

    this.localCache = { ...result, baseUrl, expiresAt: Date.now() + this.cacheDurationMs };
    return result;
  }

  private normalizeLocalModel(name: string, provider: 'ollama' | 'local-openai', capabilities?: string[]): CarrotModel {
    const type = classifyOllamaModelType(name);
    const supportsNativeTools = capabilities?.includes('tools');
    return {
      id: `local:${name}`,
      model: name,
      name: this.formatModelName(name),
      provider,
      location: 'local',
      type,
      available: true,
      supportsStreaming: type === 'chat',
      supportsEmbeddings: type === 'embedding',
      agentProtocol: type === 'chat' ? 'structured-json' : undefined,
      agentToolStatus: type === 'chat' ? 'untested' : undefined,
      preferredForCodingAgent: type === 'chat' && (supportsNativeTools === true || /coder|code/i.test(name)),
      supportsNativeTools,
    };
  }

  private async getCloudModels(forceRefresh = false): Promise<CarrotModel[]> {
    this.refreshEnv();
    if (!forceRefresh && this.cloudCache?.expiresAt && this.cloudCache.expiresAt > Date.now()) {
      return this.cloudCache.models;
    }
    const configured = this.providerConfiguration();
    const models: CarrotModel[] = [];
    if (process.env.NODE_ENV === 'test') return models;

    if (configured.groq) {
      try {
        const key = (process.env.GROQ_API_KEY || this.configService.get<string>('GROQ_API_KEY') || '').trim();
        const response = await axios.get('https://api.groq.com/openai/v1/models', {
          headers: { Authorization: `Bearer ${key}` }, timeout: 6000,
        });
        const excluded = /whisper|guard|safeguard|orpheus|embedding|tts/i;
        for (const entry of response.data?.data || []) {
          const name = typeof entry?.id === 'string' ? entry.id : '';
          if (name && entry.active !== false && !excluded.test(name)) {
            models.push(this.cloudModel(`groq:${name}`, name, this.formatModelName(name), 'groq', true));
          }
        }
      } catch (error: any) {
        this.logger.warn(`Groq model discovery failed: ${error.message}`);
      }
    }

    if (configured.gemini) {
      try {
        const key = (process.env.GEMINI_API_KEY || this.configService.get<string>('GEMINI_API_KEY') || '').trim();
        const response = await axios.get('https://generativelanguage.googleapis.com/v1beta/models', {
          params: { key, pageSize: 1000 }, timeout: 6000,
        });
        const excluded = /image|tts|computer-use|deep-research|robotics|lyria|nano-banana|antigravity/i;
        for (const entry of response.data?.models || []) {
          const name = typeof entry?.name === 'string' ? entry.name.replace(/^models\//, '') : '';
          const methods = Array.isArray(entry?.supportedGenerationMethods) ? entry.supportedGenerationMethods : [];
          if (name && methods.includes('generateContent') && !excluded.test(name) && /^(gemini|gemma)-/i.test(name)) {
            models.push(this.cloudModel(`gemini:${name}`, name, this.formatModelName(name), 'gemini', true));
          }
        }
      } catch (error: any) {
        this.logger.warn(`Gemini model discovery failed: ${error.message}`);
      }
    }

    this.cloudCache = { models, expiresAt: Date.now() + this.cloudCacheDurationMs };
    return models;
  }

  private cloudModel(id: string, model: string, name: string, provider: 'groq' | 'gemini', available: boolean): CarrotModel {
    return { id, model, name, provider, location: 'cloud', type: 'chat', available, supportsStreaming: true, agentProtocol: 'structured-json', agentToolStatus: 'untested', preferredForCodingAgent: /coder|code/i.test(`${id} ${name}`) };
  }

  private providerConfiguration(): Record<'openai' | 'deepseek' | 'kimi' | 'gemini' | 'groq', boolean> {
    const value = (name: string) => (process.env[name] || this.configService.get<string>(name) || '').trim().length > 0;
    return {
      openai: value('OPENAI_API_KEY'),
      deepseek: value('DEEPSEEK_API_KEY'),
      kimi: value('KIMI_API_KEY'),
      gemini: value('GEMINI_API_KEY'),
      groq: value('GROQ_API_KEY'),
    };
  }

  private toLegacyModel(model: CarrotModel): AIModel {
    const providerName = model.location === 'local'
      ? (model.provider === 'ollama' ? 'Local Machine (Ollama)' : 'Local OpenAI-Compatible Server')
      : `${model.provider.charAt(0).toUpperCase()}${model.provider.slice(1)} Cloud`;
    return {
      id: model.id,
      name: model.name,
      provider: model.location === 'local' ? 'local' : model.provider as AIModel['provider'],
      providerName,
      description: `${model.type === 'embedding' ? 'Embedding' : 'Chat'} model: ${model.model}`,
      isLocal: model.location === 'local',
      contextWindow: 0,
      badge: model.location === 'local' ? 'Private Local' : 'Cloud',
      available: model.available,
      type: model.type,
    };
  }

  private formatModelName(modelId: string): string {
    const clean = modelId.replace(/:latest$/, '');
    const parts = clean.split(':');
    const baseName = parts[0].split(/[\-_\/]/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
    const tag = parts[1] ? ` (${parts[1].toUpperCase()})` : '';
    return `${baseName}${tag}`;
  }
}
