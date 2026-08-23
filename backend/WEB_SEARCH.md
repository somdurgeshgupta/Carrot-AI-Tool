# Live web tools

Carrot's existing agent loop exposes `web_search` and `fetch_url` for prompts that require current internet information. Web content is untrusted reference data and is never executed.

Configuration is optional and read from the backend process environment:

- `WEB_SEARCH_ENABLED=false` disables live search. Any other value leaves it available to the extension's web-intent and Web Search controls.
- `WEB_SEARCH_PROVIDER=brave|tavily|serper|duckduckgo` selects a provider explicitly.
- `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, or `SERPER_API_KEY` enables that provider and is auto-detected in that order when `WEB_SEARCH_PROVIDER` is omitted.
- When no provider key is configured, Carrot uses the keyless DuckDuckGo HTML search endpoint.

`fetch_url` accepts credential-free HTTP(S) URLs on ports 80/443 only. It rejects localhost, private/reserved IPs, DNS resolutions containing private addresses, redirects, non-text responses, responses over 1 MB, and requests exceeding 10 seconds. Extracted readable text is capped at 100,000 characters.
