import { OperationRisk, requireString, schemas, ToolRegistry } from './toolRegistry';

export type WebSearchExecutor = (query: string, signal: AbortSignal) => Promise<unknown>;

export function registerWebSearchTool(registry: ToolRegistry, search?: WebSearchExecutor): void {
  if (!search) return;
  registry.register({
    name: 'web_search',
    description: 'Search the public internet for current information. Use only when the user enabled Web Search.',
    risk: OperationRisk.READ_ONLY,
    requiresApproval: false,
    inputSchema: schemas.object({ query: schemas.string }, ['query']),
    validate: args => { requireString(args, 'query', 500); },
    execute: (args, context) => search(requireString(args, 'query', 500), context.signal),
  });
}
