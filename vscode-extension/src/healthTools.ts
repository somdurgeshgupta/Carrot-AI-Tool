import * as net from 'node:net';

export type HealthTarget = 'backend' | 'frontend' | 'ollama' | 'redis' | 'postgresql';

const TARGETS: Record<HealthTarget, { kind: 'http' | 'tcp'; host: string; port: number; url?: string }> = {
  backend: { kind: 'http', host: '127.0.0.1', port: 3000, url: 'http://127.0.0.1:3000/api/health' },
  frontend: { kind: 'http', host: '127.0.0.1', port: 4200, url: 'http://127.0.0.1:4200/' },
  ollama: { kind: 'http', host: '127.0.0.1', port: 11434, url: 'http://127.0.0.1:11434/api/tags' },
  redis: { kind: 'tcp', host: '127.0.0.1', port: 6379 },
  postgresql: { kind: 'tcp', host: '127.0.0.1', port: 5432 },
};

export async function checkHealth(target: HealthTarget, signal: AbortSignal): Promise<{ target: HealthTarget; healthy: boolean; detail: string; latencyMs: number }> {
  const config = TARGETS[target]; if (!config) throw new Error('Invalid health target.');
  const started = Date.now();
  try {
    if (config.kind === 'http') {
      const response = await fetch(config.url!, { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]), redirect: 'error' });
      return { target, healthy: response.ok, detail: `HTTP ${response.status}`, latencyMs: Date.now() - started };
    }
    await tcpProbe(config.host, config.port, signal);
    return { target, healthy: true, detail: `TCP ${config.port} accepting connections`, latencyMs: Date.now() - started };
  } catch (error) {
    return { target, healthy: false, detail: (error instanceof Error ? error.message : 'Unavailable').slice(0, 200), latencyMs: Date.now() - started };
  }
}

function tcpProbe(host: string, port: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }); const timer = setTimeout(() => socket.destroy(new Error('Health check timed out.')), 5_000);
    const abort = () => socket.destroy(new Error('Health check cancelled.')); signal.addEventListener('abort', abort, { once: true });
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    socket.once('connect', () => { done(); socket.end(); resolve(); }); socket.once('error', error => { done(); reject(error); });
  });
}
