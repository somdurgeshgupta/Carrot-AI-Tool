import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

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
  type: 'chat' | 'embedding';
}

export interface ModelCatalogResponse {
  local: AIModel[];
  cloud: AIModel[];
  defaultModelId: string;
}

export interface HealthCheckResponse {
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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  modelId?: string;
  isLocal?: boolean;
  attachments?: Array<{
    name: string;
    extension: string;
    size?: number;
    dataUrl?: string;
  }>;
}


export interface ChatPayload {
  modelId: string;
  messages: ChatMessage[];
  sessionId?: string;
  temperature?: number;
  systemPrompt?: string;
  stream?: boolean;
  localServerUrl?: string;
  ragEnabled?: boolean;
  userId?: string;
  selectedDocNames?: string[];
  webSearchEnabled?: boolean;
  attachedFiles?: Array<{
    name: string;
    extension: string;
    type: string;
    content: string;
    dataUrl?: string;
  }>;
  apiKeys?: {
    openaiApiKey?: string;
    deepseekApiKey?: string;
    kimiApiKey?: string;
    geminiApiKey?: string;
    groqApiKey?: string;
  };
}

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private readonly baseUrl = `http://${window.location.hostname}:3000/api`;

  constructor(private http: HttpClient) {}

  getModels(customLocalUrl?: string): Observable<ModelCatalogResponse> {
    const url = customLocalUrl
      ? `${this.baseUrl}/models?localUrl=${encodeURIComponent(customLocalUrl)}`
      : `${this.baseUrl}/models`;
    return this.http.get<ModelCatalogResponse>(url);
  }

  checkHealth(customLocalUrl?: string): Observable<HealthCheckResponse> {
    const url = customLocalUrl
      ? `${this.baseUrl}/models/health?localUrl=${encodeURIComponent(customLocalUrl)}`
      : `${this.baseUrl}/models/health`;
    return this.http.get<HealthCheckResponse>(url);
  }

  async streamChat(payload: ChatPayload, onChunk: (chunk: string) => void, onError: (err: any) => void, signal?: AbortSignal): Promise<void> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      const token = localStorage.getItem('carrot_access_token');
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...payload, stream: true }),
        signal,
      });

      if (!response.ok) {
        const errorJson = await response.json().catch(() => ({}));
        throw new Error(errorJson.message || `HTTP error ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('ReadableStream not supported');

      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;

          if (trimmed.startsWith('data: ')) {
            try {
              const json = JSON.parse(trimmed.substring(6));
              const content = json.choices?.[0]?.delta?.content;
              if (content) {
                onChunk(content);
              }
            } catch {
              // ignore SSE parse errors
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return; // Stream canceled by user
      }
      onError(err);
    }
  }

  extractDocumentText(fileName: string, base64: string): Observable<{ fileName: string; text: string }> {
    return this.http.post<{ fileName: string; text: string }>(`${this.baseUrl}/chat/extract-text`, { fileName, base64 });
  }
}
