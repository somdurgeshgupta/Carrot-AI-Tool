import { AgentRunMetrics } from './agentLoop';

export type AgentCompatibilityStatus = 'tested' | 'passed' | 'degraded' | 'failed';

export interface AgentCompatibilityRecord {
  status: AgentCompatibilityStatus;
  testedAt: string;
  turns?: number;
  latencyMs?: number;
  correctiveRetries?: number;
  reason?: string;
}

export type AgentCompatibilityMap = Record<string, AgentCompatibilityRecord>;

export function completedCompatibility(metrics: AgentRunMetrics): AgentCompatibilityRecord {
  const degraded = metrics.correctiveRetries > 0 || metrics.modelDurationMs > 120_000;
  return {
    status: degraded ? 'degraded' : 'passed',
    testedAt: new Date().toISOString(),
    turns: metrics.turns,
    latencyMs: metrics.modelDurationMs + metrics.toolDurationMs,
    correctiveRetries: metrics.correctiveRetries,
  };
}

export function failedCompatibility(error: unknown): AgentCompatibilityRecord {
  const reason = (error instanceof Error ? error.message : 'Agent task failed').replace(/[\r\n]+/g, ' ').slice(0, 200);
  return { status: 'failed', testedAt: new Date().toISOString(), reason };
}

export function withCompatibility(current: AgentCompatibilityMap | undefined, modelId: string, record: AgentCompatibilityRecord): AgentCompatibilityMap {
  return { ...(current ?? {}), [modelId]: record };
}
