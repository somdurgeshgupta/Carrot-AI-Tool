import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface AngularProjectOptions {
  name: string;
  routing: boolean;
  style: 'css' | 'scss' | 'sass' | 'less';
  standalone: boolean;
  skipGit: boolean;
}

export function angularProjectOptions(args: Record<string, unknown>): AngularProjectOptions {
  const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'angular-app';
  if (!/^[a-z][a-z0-9-]{0,49}$/.test(name) || name.endsWith('-') || name.includes('--')) {
    throw new Error('Angular project name must use lowercase letters, numbers, and single hyphens.');
  }
  const style = args.style ?? 'scss';
  if (!['css', 'scss', 'sass', 'less'].includes(String(style))) throw new Error('Invalid Angular stylesheet format.');
  for (const key of ['routing', 'standalone', 'skipGit']) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error(`Invalid ${key}.`);
  }
  return {
    name,
    routing: args.routing !== false,
    style: style as AngularProjectOptions['style'],
    standalone: args.standalone !== false,
    skipGit: args.skipGit !== false,
  };
}

export function angularCliArguments(options: AngularProjectOptions): string[] {
  return [
    '@angular/cli@v21-lts', 'new', options.name, '--defaults',
    options.routing ? '--routing' : '--no-routing',
    `--style=${options.style}`,
    options.standalone ? '--standalone' : '--no-standalone',
    options.skipGit ? '--skip-git' : '--no-skip-git',
    '--package-manager=npm',
  ];
}

export function angularCliInvocation(
  options: AngularProjectOptions,
  platform: NodeJS.Platform = process.platform,
  nodeExecutable?: string,
  npxCli?: string,
): { executable: string; args: string[] } {
  const args = angularCliArguments(options);
  if (platform !== 'win32') return { executable: 'npx', args };

  if (!nodeExecutable || !npxCli) throw new Error('Windows Angular CLI invocation requires resolved Node.js and npx paths.');

  // Node cannot reliably spawn .cmd launchers with shell disabled on Windows
  // (it can fail with EINVAL). Invoke npm's JavaScript entrypoint directly so
  // scaffolding remains shell-free and every CLI argument stays separate.
  return {
    executable: nodeExecutable,
    args: [npxCli, ...args],
  };
}

export async function resolveAngularCliInvocation(
  options: AngularProjectOptions,
  platform: NodeJS.Platform = process.platform,
): Promise<{ executable: string; args: string[] }> {
  if (platform !== 'win32') return angularCliInvocation(options, platform);

  const [nodeResult, npxResult] = await Promise.all([
    execFileAsync('where.exe', ['node.exe'], { windowsHide: true }),
    execFileAsync('where.exe', ['npx.cmd'], { windowsHide: true }),
  ]);
  const nodeExecutable = firstWindowsPath(nodeResult.stdout);
  const launchers = windowsPaths(npxResult.stdout);
  if (!nodeExecutable || !launchers.length) throw new Error('Node.js and npm must be installed and available on PATH to create an Angular project.');

  for (const launcher of launchers) {
    const npxCli = path.join(path.dirname(launcher), 'node_modules', 'npm', 'bin', 'npx-cli.js');
    try {
      await access(npxCli);
      return angularCliInvocation(options, platform, nodeExecutable, npxCli);
    } catch {}
  }
  throw new Error('npm was found, but its npx-cli.js entrypoint could not be resolved. Repair or reinstall Node.js/npm.');
}

function firstWindowsPath(output: string): string | undefined {
  return windowsPaths(output)[0];
}

function windowsPaths(output: string): string[] {
  return output.split(/\r?\n/).map(value => value.trim()).filter(value => path.win32.isAbsolute(value));
}
