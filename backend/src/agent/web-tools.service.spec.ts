import axios from 'axios';
import { WebToolsService } from './web-tools.service';

describe('WebToolsService', () => {
  const original = { ...process.env };
  afterEach(() => { process.env = { ...original }; jest.restoreAllMocks(); });

  it('normalizes live DuckDuckGo results with source URLs', async () => {
    process.env.WEB_SEARCH_PROVIDER = 'duckduckgo';
    jest.spyOn(axios, 'get').mockResolvedValue({ data: '<div class="result"><a class="result__a" href="https://example.com/docs">Official docs</a><div class="result__snippet">Current release notes</div></div>' } as any);
    await expect(new WebToolsService().search('latest Angular')).resolves.toEqual({ query: 'latest Angular', provider: 'duckduckgo', results: [{ title: 'Official docs', url: 'https://example.com/docs', snippet: 'Current release notes', source: 'DuckDuckGo' }] });
  });

  it('honors the environment kill switch', async () => {
    process.env.WEB_SEARCH_ENABLED = 'false';
    await expect(new WebToolsService().search('current news')).rejects.toThrow(/disabled/i);
  });

  it('blocks localhost, private IPs, credentials, and nonstandard ports before fetching', async () => {
    const service = new WebToolsService();
    for (const url of ['http://localhost:3000', 'http://127.0.0.1', 'http://10.0.0.1', 'https://user:pass@example.com', 'https://example.com:8443']) await expect(service.fetchUrl(url)).rejects.toThrow();
  });
});
