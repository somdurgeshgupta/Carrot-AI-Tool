import { BadRequestException } from '@nestjs/common';

const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'];

export function assertTrustedLocalAiUrl(value: string, configuredHosts?: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('Local AI server URL must be a valid URL.');
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new BadRequestException('Local AI server URL must use HTTP(S) without credentials.');
  }

  const allowedHosts = (configuredHosts || DEFAULT_ALLOWED_HOSTS.join(','))
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new BadRequestException('Local AI server host is not allowed.');
  }

  return url.toString().replace(/\/$/, '');
}
