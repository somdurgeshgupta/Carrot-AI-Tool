import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';

interface Ipv4Network {
  address: number;
  mask: number;
}

function ipv4ToNumber(address: string): number {
  return address
    .split('.')
    .reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

export function localIpv4Networks(): Ipv4Network[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter(
      (entry) =>
        entry.family === 'IPv4' &&
        !entry.internal &&
        isIP(entry.address) === 4 &&
        isIP(entry.netmask) === 4,
    )
    .map((entry) => ({
      address: ipv4ToNumber(entry.address),
      mask: ipv4ToNumber(entry.netmask),
    }));
}

export function createCorsOriginValidator(
  configuredOrigins: string[],
  networks: Ipv4Network[] = localIpv4Networks(),
) {
  const allowedOrigins = new Set(configuredOrigins);

  return (
    origin: string | undefined,
    callback: (error: Error | null, allowed?: boolean) => void,
  ): void => {
    // Requests without Origin are not browser cross-origin requests.
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol)) {
        callback(null, false);
        return;
      }

      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (host === 'localhost' || host === '127.0.0.1') {
        callback(null, true);
        return;
      }

      if (isIP(host) !== 4) {
        callback(null, false);
        return;
      }

      const address = ipv4ToNumber(host);
      const onLocalSubnet = networks.some(
        (network) =>
          (address & network.mask) === (network.address & network.mask),
      );
      callback(null, onLocalSubnet);
    } catch {
      callback(null, false);
    }
  };
}
