const STOP_WORDS = new Set([
  'and', 'or', 'the', 'this', 'that', 'for', 'with', 'usage', 'uses', 'related', 'files',
  'search', 'find', 'entire', 'project', 'workspace', 'implementation', 'code', 'vs', 'vscode',
  'explain', 'how', 'works', 'work', 'inspect', 'actual', 'reference', 'referenced', 'used', 'request',
  'in', 'you', 'your', 'me', 'from', 'instead', 'before', 'after',
]);

const ALIASES: Record<string, string[]> = {
  authentication: ['authentication', 'auth'],
  authorization: ['authorization', 'authorize', 'bearer'],
  jwt: ['jwt', 'jsonweb', 'bearer'],
  guards: ['guard', 'guards'],
  guard: ['guard'],
  sessions: ['session'],
  ownership: ['ownership', 'owner', 'user.id'],
  secretstorage: ['secretstorage', 'secrets'],
  login: ['login', 'signin', 'sign-in'],
};

export interface SearchTermInput { query?: unknown; queries?: unknown }

export function searchTerms(input: SearchTermInput, maxTerms = 12): string[] {
  const raw: string[] = [];
  if (typeof input.query === 'string') raw.push(input.query);
  if (Array.isArray(input.queries)) {
    for (const value of input.queries) if (typeof value === 'string') raw.push(value);
  }
  const tokens = raw.flatMap(value => value.split(/[^a-zA-Z0-9_.-]+/))
    .map(value => value.toLowerCase().trim().replace(/^[._-]+|[._-]+$/g, ''))
    .filter(value => value.length >= 2 && !STOP_WORDS.has(value));
  const expanded = tokens.flatMap(token => ALIASES[token] ?? [singularize(token)]);
  return [...new Set(expanded)].slice(0, maxTerms);
}

export function matchingTerms(text: string, terms: readonly string[]): string[] {
  const normalized = text.toLowerCase();
  return terms.filter(term => normalized.includes(term));
}

export function rankFilePaths(paths: readonly string[], terms: readonly string[], limit: number): Array<{ path: string; terms: string[] }> {
  return paths.map(filePath => ({ path: filePath, terms: matchingTerms(filePath, terms), score: fileScore(filePath, terms) }))
    .filter(result => result.terms.length > 0)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    .map(({ path: filePath, terms: matched }) => ({ path: filePath, terms: matched }))
    .slice(0, limit);
}

function fileScore(filePath: string, terms: readonly string[]): number {
  const normalized = filePath.toLowerCase().replaceAll('\\', '/');
  const basename = normalized.split('/').pop() ?? normalized;
  let score = matchingTerms(normalized, terms).length * 10;
  for (const term of terms) {
    if (basename === term || basename.startsWith(`${term}.`) || basename.startsWith(`${term}-`)) score += 12;
    else if (basename.includes(term)) score += 5;
  }
  if (/\.(ts|tsx|js|jsx|html|css|scss|py|go|java)$/.test(normalized)) score += 3;
  if (/\.(service|controller|interceptor|strategy)\.[^.]+$/.test(normalized)) score += 7;
  else if (/\.guard\.[^.]+$/.test(normalized)) score += 5;
  else if (/\.(dto|module)\.[^.]+$/.test(normalized)) score += 1;
  if (/no-auth\.guard\.[^.]+$/.test(normalized)) score -= 10;
  if (/\.(spec|test)\.[^.]+$/.test(normalized) || /(^|\/)(test|tests|fixtures|generated|dist|build)(\/|$)/.test(normalized)) score -= 8;
  return score;
}

export function selectDiverseMatches<T extends { matchedTerms: string[] }>(
  matches: readonly T[],
  terms: readonly string[],
  limit: number,
): T[] {
  const selected: T[] = [];
  const used = new Set<T>();
  for (const term of terms) {
    const match = matches.find(candidate => !used.has(candidate) && candidate.matchedTerms.includes(term));
    if (match) { selected.push(match); used.add(match); }
    if (selected.length >= limit) return selected;
  }
  for (const match of [...matches].sort((a, b) => b.matchedTerms.length - a.matchedTerms.length)) {
    if (!used.has(match)) selected.push(match);
    if (selected.length >= limit) break;
  }
  return selected;
}

function singularize(value: string): string {
  if (value.endsWith('ies') && value.length > 4) return `${value.slice(0, -3)}y`;
  if (value.endsWith('s') && value.length > 3) return value.slice(0, -1);
  return value;
}
