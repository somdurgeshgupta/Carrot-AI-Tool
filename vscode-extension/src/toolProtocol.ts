import { OperationRisk } from './workspacePolicy';

export interface ToolCall {
  type: 'tool_call';
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  type: 'tool_result';
  id: string;
  tool: string;
  result?: unknown;
  error?: string;
}

export interface AgentFinal {
  type: 'final';
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: OperationRisk;
  requiresApproval: boolean;
}

export function parseAgentResponse(value: string): ToolCall | AgentFinal {
  const trimmed = extractJson(value.replace(/<think>[\s\S]*?<\/think>/gi, '').trim());
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { throw new Error('The model returned malformed agent JSON.'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('The model returned an invalid agent response.');
  let record = parsed as Record<string, unknown>;
  for (const key of ['response', 'result', 'message']) {
    const wrapped = objectRecord(record[key]);
    if (wrapped && Object.keys(record).length === 1) {
      record = wrapped;
      break;
    }
  }
  const finalContent = firstString(record.content, record.response, record.answer, record.final);
  if ((record.type === 'final' || record.type === 'final_response' || (!record.tool && !record.name && !record.tool_call)) && finalContent) {
    return { type: 'final', content: finalContent };
  }
  const nested = objectRecord(record.tool_call);
  const tool = firstString(record.tool, record.name, nested?.tool, nested?.name);
  const args = objectRecord(record.arguments) ?? objectRecord(record.parameters) ?? objectRecord(record.input)
    ?? objectRecord(nested?.arguments) ?? objectRecord(nested?.parameters) ?? objectRecord(nested?.input);
  const suppliedId = firstString(record.id, record.tool_call_id, nested?.id);
  const id = suppliedId ?? generatedCallId(trimmed);
  if ((record.type === 'tool_call' || tool) && tool && safeId(tool) && safeId(id) && args) {
    return {
      type: 'tool_call',
      id,
      tool,
      arguments: args,
    };
  }
  throw new Error('The model returned an invalid tool call.');
}

function safeId(value: unknown): boolean {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function generatedCallId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return `call_${(hash >>> 0).toString(16)}`;
}

function extractJson(value: string): string {
  const fenced = value.match(/^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
  return (fenced?.[1] ?? value).trim();
}
