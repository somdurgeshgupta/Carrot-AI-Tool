import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PortOwner { port: number; pid: number; address: string; state: string; }

export function parseNetstatOwners(output: string, port: number): PortOwner[] {
  const owners: PortOwner[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+(\S+)\s+(\d+)$/i);
    if (!match || Number(match[2]) !== port || match[3].toUpperCase() !== 'LISTENING') continue;
    owners.push({ port, pid: Number(match[4]), address: match[1], state: match[3].toUpperCase() });
  }
  return owners;
}

export async function checkPort(port: number, signal: AbortSignal): Promise<{ port: number; free: boolean; owners: PortOwner[] }> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
  if (process.platform !== 'win32') throw new Error('Process tools currently support the Windows extension host only.');
  const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], { timeout: 10_000, maxBuffer: 1_000_000, signal });
  const owners = parseNetstatOwners(stdout, port);
  return { port, free: owners.length === 0, owners };
}

export async function findProcess(pid: number, signal: AbortSignal): Promise<{ pid: number; found: boolean; imageName?: string }> {
  if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid process id.');
  const { stdout } = await execFileAsync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 10_000, maxBuffer: 100_000, signal });
  const match = stdout.match(/^"([^"]+)","(\d+)"/m);
  return match ? { pid, found: true, imageName: match[1] } : { pid, found: false };
}

export async function killPort(port: number, expectedPid: number, signal: AbortSignal): Promise<{ port: number; killedPid: number; free: boolean }> {
  const before = await checkPort(port, signal);
  if (before.free) return { port, killedPid: expectedPid, free: true };
  if (!before.owners.some(owner => owner.pid === expectedPid)) throw new Error(`Port ${port} is no longer owned by PID ${expectedPid}. Recheck before killing.`);
  await execFileAsync('taskkill.exe', ['/PID', String(expectedPid), '/T', '/F'], { timeout: 15_000, maxBuffer: 100_000, signal });
  await new Promise(resolve => setTimeout(resolve, 250));
  const after = await checkPort(port, signal);
  return { port, killedPid: expectedPid, free: after.free };
}

export async function terminateProcess(pid: number, signal: AbortSignal): Promise<void> {
  if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid process id.');
  await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 15_000, maxBuffer: 100_000, signal });
}
