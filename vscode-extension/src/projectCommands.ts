export type ProjectAction = 'build' | 'test' | 'lint' | 'typecheck' | 'start';
export type PackageManager = 'npm' | 'yarn' | 'pnpm';

export interface ProjectCommand {
  action: ProjectAction;
  command: string;
  source: 'package.json' | 'nx' | 'angular' | 'nestjs' | 'typescript';
  script?: string;
  project?: string;
}

export interface ProjectCommandDiscovery {
  packageManager: PackageManager;
  frameworks: string[];
  commands: ProjectCommand[];
}

export function detectProjectCommands(
  packageJson: Record<string, any> | undefined,
  fileNames: Iterable<string>,
): ProjectCommandDiscovery {
  const files = new Set([...fileNames].map(value => value.toLowerCase()));
  const packageManager = detectPackageManager(packageJson, files);
  const runner = packageManager === 'npm' ? 'npm run' : packageManager;
  const scripts = objectStrings(packageJson?.scripts);
  const dependencies = new Set(Object.keys({ ...(packageJson?.dependencies ?? {}), ...(packageJson?.devDependencies ?? {}) }));
  const frameworks = [
    files.has('nx.json') || dependencies.has('nx') || dependencies.has('@nx/workspace') ? 'Nx' : undefined,
    files.has('angular.json') || dependencies.has('@angular/core') ? 'Angular' : undefined,
    files.has('nest-cli.json') || dependencies.has('@nestjs/core') ? 'NestJS' : undefined,
  ].filter((value): value is string => !!value);
  const commands: ProjectCommand[] = [];

  for (const [script, value] of Object.entries(scripts)) {
    const action = classifyScript(script, value);
    if (!action) continue;
    commands.push({ action, command: `${runner} ${script}`, source: 'package.json', script });
  }

  if (!commands.some(item => item.action === 'typecheck') && (files.has('tsconfig.json') || dependencies.has('typescript'))) {
    commands.push({ action: 'typecheck', command: packageManager === 'npm' ? 'npx tsc --noEmit' : `${packageManager} exec tsc --noEmit`, source: 'typescript' });
  }

  return { packageManager, frameworks, commands: uniqueCommands(commands) };
}

export function commandForAction(discovery: ProjectCommandDiscovery, action: ProjectAction, project?: string): ProjectCommand | undefined {
  const candidates = discovery.commands.filter(item => item.action === action);
  if (!project) return candidates[0];
  const target = project.toLowerCase();
  return candidates.find(item => item.script?.toLowerCase().includes(target) || item.project?.toLowerCase() === target) ?? candidates[0];
}

function detectPackageManager(packageJson: Record<string, any> | undefined, files: Set<string>): PackageManager {
  const declared = typeof packageJson?.packageManager === 'string' ? packageJson.packageManager.split('@')[0] : '';
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'npm') return declared;
  if (files.has('pnpm-lock.yaml')) return 'pnpm';
  if (files.has('yarn.lock')) return 'yarn';
  return 'npm';
}

function classifyScript(name: string, value: string): ProjectAction | undefined {
  const normalized = `${name} ${value}`.toLowerCase();
  if (/\b(typecheck|type-check|check:types)\b|tsc\s+.*--noemit/.test(normalized)) return 'typecheck';
  if (/^build(?::|$)|\b(nx|ng|nest)\s+build\b/.test(normalized)) return 'build';
  if (/^(test|e2e)(?::|$)|\b(nx|ng)\s+test\b|\b(jest|vitest)\b/.test(normalized)) return 'test';
  if (/^lint(?::|$)|\b(nx|ng)\s+lint\b|\beslint\b/.test(normalized)) return 'lint';
  if (/^(start|serve|dev)(?::|$)|\b(nx|ng)\s+serve\b|\bnest\s+start\b/.test(normalized)) return 'start';
  return undefined;
}

function objectStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function uniqueCommands(commands: ProjectCommand[]): ProjectCommand[] {
  const seen = new Set<string>();
  return commands.filter(item => !seen.has(item.command.toLowerCase()) && !!seen.add(item.command.toLowerCase()));
}
