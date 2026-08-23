import { spawn } from 'node:child_process';
export interface ExecutionResult { exitCode: number | null; output: string; truncated: boolean; timedOut: boolean; durationMs: number; }
export function executeBounded(executable: string, args: string[], options: { cwd: string; timeoutMs: number; outputLimit: number; signal: AbortSignal; }): Promise<ExecutionResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now(); const child = spawn(executable, args, { cwd: options.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let truncated = false; let settled = false; let timedOut = false;
    const append = (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > options.outputLimit) { output = output.slice(-options.outputLimit); truncated = true; } };
    child.stdout.on('data', append); child.stderr.on('data', append); const stop = () => child.kill();
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs); const cleanup = () => { clearTimeout(timer); options.signal.removeEventListener('abort', stop); };
    options.signal.addEventListener('abort', stop, { once: true });
    child.once('error', error => { if (!settled) { settled = true; cleanup(); reject(error); } });
    child.once('close', exitCode => { if (!settled) { settled = true; cleanup(); resolve({ exitCode, output: output.trim(), truncated, timedOut, durationMs: Date.now() - started }); } });
  });
}

export function startDetached(executable: string, args: string[], cwd: string): number {
  const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, detached: true, stdio: 'ignore' });
  if (!child.pid) throw new Error('Failed to start project process.');
  child.unref();
  return child.pid;
}
