import { OperationRisk } from './workspacePolicy';
import { ToolCall, ToolDefinition, ToolResult } from './toolProtocol';

export interface ToolContext {
  signal: AbortSignal;
  approve: (definition: ToolDefinition, summary: string) => Promise<boolean>;
}

export interface RegisteredTool extends ToolDefinition {
  validate: (args: Record<string, unknown>) => void;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
  summarize?: (args: Record<string, unknown>) => string;
}

export interface ToolDebugEvent {
  stage: 'requested' | 'completed' | 'failed';
  tool: string;
  arguments?: Record<string, unknown>;
  durationMs?: number;
  resultCount?: number;
  error?: string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(private readonly debug?: (event: ToolDebugEvent) => void) {}

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool is already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map(({ name, description, inputSchema, risk, requiresApproval }) => ({
      name, description, inputSchema, risk, requiresApproval,
    }));
  }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const started = Date.now();
    this.debug?.({ stage: 'requested', tool: call.tool, arguments: sanitizeArguments(call.arguments) });
    const tool = this.tools.get(call.tool);
    if (!tool) {
      this.debug?.({ stage: 'failed', tool: call.tool, durationMs: Date.now() - started, error: 'Unknown tool' });
      return { type: 'tool_result', id: call.id, tool: call.tool, error: `Unknown tool: ${call.tool}` };
    }
    try {
      if (context.signal.aborted) throw new Error('Agent task was cancelled.');
      tool.validate(call.arguments);
      if (tool.requiresApproval) {
        const approved = await context.approve(tool, tool.summarize?.(call.arguments) ?? tool.description);
        if (!approved) throw new Error('User rejected this operation.');
      }
      const result = await tool.execute(call.arguments, context);
      this.debug?.({ stage: 'completed', tool: call.tool, durationMs: Date.now() - started, resultCount: resultCount(result) });
      return { type: 'tool_result', id: call.id, tool: call.tool, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool execution failed.';
      this.debug?.({ stage: 'failed', tool: call.tool, durationMs: Date.now() - started, error: sanitizeError(message) });
      return {
        type: 'tool_result',
        id: call.id,
        tool: call.tool,
        error: message,
      };
    }
  }
}

function sanitizeError(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\b(bearer\s+)[a-z0-9._~+\/-]+/gi, '$1[redacted]')
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 500);
}

function sanitizeArguments(args: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(['path', 'cwd', 'rootIndex', 'limit', 'depth', 'startLine', 'endLine', 'timeoutMs', 'create', 'port', 'pid', 'expectedPid', 'action', 'target']);
  return Object.fromEntries(Object.entries(args)
    .filter(([key]) => allowed.has(key))
    .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 500) : value]));
}

function resultCount(result: unknown): number | undefined {
  if (Array.isArray(result)) return result.length;
  if (!result || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  if (typeof record.count === 'number') return record.count;
  for (const key of ['matches', 'files', 'entries', 'changedFiles']) {
    if (Array.isArray(record[key])) return record[key].length;
  }
  return undefined;
}

export const schemas = {
  object(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
    return { type: 'object', properties, required, additionalProperties: false };
  },
  string: { type: 'string' },
  number: { type: 'number' },
  boolean: { type: 'boolean' },
};

export function requireString(args: Record<string, unknown>, key: string, max = 10_000): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${key}.`);
  return value;
}

export function optionalNumber(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = args[key] ?? fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`Invalid ${key}.`);
  return value as number;
}

export { OperationRisk };
