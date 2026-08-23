import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { lookup } from 'node:dns/promises';
import * as net from 'node:net';

export interface WebSearchResult { title: string; url: string; snippet: string; source: string; }

@Injectable()
export class WebToolsService {
  async search(query: string): Promise<{ query: string; provider: string; results: WebSearchResult[] }> {
    const clean = query.trim();
    if (!clean) throw new BadRequestException('Search query is required.');
    if (process.env.WEB_SEARCH_ENABLED?.toLowerCase() === 'false') throw new ServiceUnavailableException('Web search is disabled by configuration.');
    const provider = (process.env.WEB_SEARCH_PROVIDER || this.detectProvider()).toLowerCase();
    const results = provider === 'brave' ? await this.searchBrave(clean)
      : provider === 'tavily' ? await this.searchTavily(clean)
      : provider === 'serper' ? await this.searchSerper(clean)
      : provider === 'duckduckgo' ? await this.searchDuckDuckGo(clean)
      : (() => { throw new ServiceUnavailableException(`Unsupported web search provider: ${provider}`); })();
    return { query: clean, provider, results: results.slice(0, 8) };
  }

  async fetchUrl(value: string): Promise<{ url: string; status: number; title: string; text: string; truncated: boolean; untrusted: true }> {
    const url = await this.assertPublicUrl(value);
    const response = await axios.get<string>(url.toString(), {
      timeout: 10_000, maxRedirects: 0, maxContentLength: 1_000_000, maxBodyLength: 1_000_000,
      responseType: 'text', transformResponse: value => value,
      headers: { Accept: 'text/html,text/plain,application/json;q=0.8', 'User-Agent': 'CarrotAI/1.0 safe-web-fetch' },
      validateStatus: status => status >= 200 && status < 300,
    });
    const contentType = String(response.headers['content-type'] || '');
    if (!/(text\/|application\/(json|xml|xhtml))/i.test(contentType)) throw new BadRequestException('Only text web pages can be fetched.');
    const raw = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    const extracted = /html|xhtml/i.test(contentType) ? extractReadableHtml(raw) : { title: '', text: raw };
    const limit = 100_000;
    return { url: url.toString(), status: response.status, title: extracted.title, text: extracted.text.slice(0, limit), truncated: extracted.text.length > limit, untrusted: true };
  }

  private detectProvider(): string {
    if (process.env.BRAVE_SEARCH_API_KEY) return 'brave';
    if (process.env.TAVILY_API_KEY) return 'tavily';
    if (process.env.SERPER_API_KEY) return 'serper';
    return 'duckduckgo';
  }

  private async searchBrave(query: string): Promise<WebSearchResult[]> {
    const key = requiredKey('BRAVE_SEARCH_API_KEY');
    const response = await axios.get('https://api.search.brave.com/res/v1/web/search', { params: { q: query, count: 8 }, headers: { 'X-Subscription-Token': key, Accept: 'application/json' }, timeout: 10_000, maxRedirects: 0 });
    return (response.data?.web?.results ?? []).map((item: any) => result(item.title, item.url, item.description, 'Brave Search'));
  }

  private async searchTavily(query: string): Promise<WebSearchResult[]> {
    const response = await axios.post('https://api.tavily.com/search', { api_key: requiredKey('TAVILY_API_KEY'), query, max_results: 8, search_depth: 'basic', include_answer: false, include_raw_content: false }, { timeout: 10_000, maxRedirects: 0 });
    return (response.data?.results ?? []).map((item: any) => result(item.title, item.url, item.content, 'Tavily'));
  }

  private async searchSerper(query: string): Promise<WebSearchResult[]> {
    const response = await axios.post('https://google.serper.dev/search', { q: query, num: 8 }, { headers: { 'X-API-KEY': requiredKey('SERPER_API_KEY'), 'Content-Type': 'application/json' }, timeout: 10_000, maxRedirects: 0 });
    return (response.data?.organic ?? []).map((item: any) => result(item.title, item.link, item.snippet, 'Serper'));
  }

  private async searchDuckDuckGo(query: string): Promise<WebSearchResult[]> {
    const response = await axios.get<string>('https://html.duckduckgo.com/html/', { params: { q: query }, timeout: 10_000, maxRedirects: 0, responseType: 'text', headers: { 'User-Agent': 'CarrotAI/1.0' } });
    const $ = cheerio.load(response.data); const results: WebSearchResult[] = [];
    $('.result').each((_, element) => {
      const anchor = $(element).find('.result__a').first(); const href = decodeDuckDuckGoUrl(anchor.attr('href') || '');
      if (href && results.length < 8) results.push(result(anchor.text(), href, $(element).find('.result__snippet').text(), 'DuckDuckGo'));
    });
    return results;
  }

  private async assertPublicUrl(value: string): Promise<URL> {
    let url: URL; try { url = new URL(value); } catch { throw new BadRequestException('Invalid URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port && !['80', '443'].includes(url.port)) throw new BadRequestException('Only credential-free HTTP(S) URLs on standard ports are allowed.');
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || privateAddress(host)) throw new BadRequestException('Local and private network URLs are blocked.');
    const addresses = await lookup(host, { all: true });
    if (!addresses.length || addresses.some(item => privateAddress(item.address))) throw new BadRequestException('URL resolved to a private or unavailable address.');
    return url;
  }
}

function requiredKey(name: string): string { const value = process.env[name]; if (!value) throw new ServiceUnavailableException(`${name} is not configured.`); return value; }
function result(title: unknown, url: unknown, snippet: unknown, source: string): WebSearchResult { return { title: clean(title), url: String(url || '').slice(0, 2_000), snippet: clean(snippet).slice(0, 1_000), source }; }
function clean(value: unknown): string { return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
function decodeDuckDuckGoUrl(value: string): string { try { const url = new URL(value, 'https://duckduckgo.com'); return url.searchParams.get('uddg') || (url.hostname !== 'duckduckgo.com' ? url.toString() : ''); } catch { return ''; } }
function extractReadableHtml(html: string): { title: string; text: string } { const $ = cheerio.load(html); $('script,style,noscript,svg,nav,footer,form').remove(); return { title: clean($('title').first().text()), text: clean($('main,article').first().text() || $('body').text()) }; }
function privateAddress(host: string): boolean {
  if (host === '::1' || host === '0.0.0.0') return true;
  if (net.isIPv4(host)) { const [a, b] = host.split('.').map(Number); return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224; }
  if (net.isIPv6(host)) { const value = host.toLowerCase(); return value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80') || value === '::'; }
  return false;
}
