export function validateAgentCommand(command: string): void {
  if (/[;&|><`$]/.test(command)) throw new Error('Shell operators are not allowed.');
  const normalized = command.trim().replace(/\s+/g, ' ').toLowerCase();
  const allowed = [
    /^npm(?:\.cmd)? (?:test|run (?:test|build|lint))(?: -- .+)?$/,
    /^npx(?:\.cmd)? tsc --noemit$/,
  ];
  if (!allowed.some(pattern => pattern.test(normalized))) throw new Error('Command is not in the P4 validation allowlist.');
}

export function parseAgentCommand(command: string, platform = process.platform): string[] {
  const parts = command.trim().split(/\s+/);
  if (platform === 'win32' && parts[0].toLowerCase() === 'npm') parts[0] = 'npm.cmd';
  if (platform === 'win32' && parts[0].toLowerCase() === 'npx') parts[0] = 'npx.cmd';
  return parts;
}
