import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { ModelsService, classifyOllamaModelType } from './models.service';

describe('ModelsService', () => {
  const config = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;

  afterEach(() => jest.restoreAllMocks());

  it('classifies known embedding model families without treating them as chat models', () => {
    expect(classifyOllamaModelType('nomic-embed-text:latest')).toBe('embedding');
    expect(classifyOllamaModelType('mxbai-embed-large')).toBe('embedding');
    expect(classifyOllamaModelType('qwen3:8b')).toBe('chat');
  });

  it('discovers and normalizes the current Ollama inventory', async () => {
    jest.spyOn(axios, 'get').mockResolvedValue({
      data: { models: [{ name: 'qwen3:8b', capabilities: ['completion', 'tools', 'thinking'] }, { name: 'nomic-embed-text:latest', capabilities: ['embedding'] }] },
    });
    const catalog = await new ModelsService(config).getModelCatalog();
    expect(catalog.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'local:qwen3:8b', location: 'local', type: 'chat', available: true, agentProtocol: 'structured-json', agentToolStatus: 'untested', supportsNativeTools: true }),
      expect.objectContaining({ id: 'local:nomic-embed-text:latest', location: 'local', type: 'embedding', available: true }),
    ]));
  });

  it('force refresh reflects installed and removed local models', async () => {
    jest.spyOn(axios, 'get')
      .mockResolvedValueOnce({ data: { models: [{ name: 'first:latest' }] } })
      .mockResolvedValueOnce({ data: { models: [{ name: 'second:latest' }] } });
    const service = new ModelsService(config);
    expect((await service.getModelCatalog()).local.map((model) => model.id)).toContain('local:first:latest');
    expect((await service.getModelCatalog(undefined, true)).local.map((model) => model.id)).toEqual(['local:second:latest']);
  });

  it('Auto deterministically prefers an available coding model for agent tasks', async () => {
    jest.spyOn(axios, 'get').mockResolvedValue({
      data: { models: [{ name: 'qwen3:8b' }, { name: 'qwen2.5-coder:7b' }] },
    });
    const selected = await new ModelsService(config).resolveChatModel('auto', true, undefined, true);
    expect(selected.id).toBe('local:qwen2.5-coder:7b');
    expect(selected.preferredForCodingAgent).toBe(true);
  });

  it('returns no local models when both discovery protocols are unavailable', async () => {
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('offline'));
    const catalog = await new ModelsService(config).getModelCatalog();
    expect(catalog.local).toEqual([]);
  });
});
