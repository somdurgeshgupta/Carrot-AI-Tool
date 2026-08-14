import { AgentService } from './agent.service';

describe('AgentService', () => {
  it('forwards a bounded model turn with Local Only and no filesystem authority', async () => {
    const chat = { handleChatCompletion: jest.fn().mockResolvedValue({ choices: [] }), performWebSearch: jest.fn() };
    const service = new AgentService(chat as any);
    await service.turn('user-1', {
      modelId: 'auto',
      localOnly: true,
      systemPrompt: 'tools',
      messages: [{ role: 'user', content: 'inspect' }],
    });
    expect(chat.handleChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      localOnly: true,
      agentTask: true,
      stream: false,
      ragEnabled: false,
      webSearchEnabled: false,
    }), 'user-1');
    const payload = chat.handleChatCompletion.mock.calls[0][0];
    expect(payload).not.toHaveProperty('path');
    expect(payload).not.toHaveProperty('workspaceRoot');
  });

  it('returns bounded web-search results through the authenticated agent service', async () => {
    const chat = { handleChatCompletion: jest.fn(), performWebSearch: jest.fn().mockResolvedValue('[Result]: current fact') };
    const service = new AgentService(chat as any);
    await expect(service.webSearch(' latest Angular ')).resolves.toEqual({ query: 'latest Angular', results: '[Result]: current fact' });
    expect(chat.performWebSearch).toHaveBeenCalledWith('latest Angular');
  });
});
