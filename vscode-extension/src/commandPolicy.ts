export type CommandRisk = 'read-only' | 'normal-write' | 'destructive';
export interface ValidatedCommand { executable: string; args: string[]; risk: CommandRisk; }
export function validateAgentCommand(command: string): void { parseValidatedCommand(command); }
export function parseAgentCommand(command: string, platform = process.platform): string[] { const parsed = parseValidatedCommand(command, platform); return [parsed.executable, ...parsed.args]; }
export function parseValidatedCommand(command: string, platform = process.platform): ValidatedCommand {
  if (!command.trim() || command.length > 300 || /[;&|><`$\r\n]/.test(command)) throw new Error('Shell operators are not allowed.');
  const parts = command.trim().split(/\s+/); const raw = parts.shift()!.toLowerCase().replace(/\.cmd$/, '');
  const executable = platform === 'win32' && ['npm', 'npx', 'yarn', 'pnpm'].includes(raw) ? `${raw}.cmd` : raw; const args = parts;
  if (raw === 'npm' && ((args[0] === 'test' && passArgs(args.slice(1))) || (args[0] === 'run' && lifecycle(args[1]) && passArgs(args.slice(2))))) return { executable, args, risk: 'normal-write' };
  if (raw === 'yarn' && lifecycle(args[0]) && passArgs(args.slice(1))) return { executable, args, risk: 'normal-write' };
  if (raw === 'pnpm' && (((args[0] === 'run' && lifecycle(args[1]) && passArgs(args.slice(2))) || (lifecycle(args[0]) && passArgs(args.slice(1)))))) return { executable, args, risk: 'normal-write' };
  if (raw === 'pnpm' && args[0] === 'exec' && args[1] === 'tsc' && args.slice(2).every(tscArg)) return { executable, args, risk: 'normal-write' };
  if (raw === 'npx' && args[0] === 'tsc' && args.slice(1).every(tscArg)) return { executable, args, risk: 'normal-write' };
  throw new Error('Command is not in the local development allowlist.');
}
function lifecycle(value: string | undefined): boolean { return !!value && /^(build|test|lint|typecheck|type-check|start|serve|dev)(:[a-z0-9_.-]+)*$/i.test(value); }
function passArgs(args: string[]): boolean { return !args.length || (args[0] === '--' && args.slice(1).every(value => /^--?[a-z0-9][a-z0-9_.=-]*$/i.test(value))); }
function tscArg(value: string): boolean { return /^(--noemit|--pretty(?:=(?:true|false))?|--project|-p|[a-z0-9_./\\-]+)$/i.test(value) && !value.includes('..'); }
