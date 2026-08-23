import { createCorsOriginValidator } from './cors-origin';

function check(origin?: string): Promise<boolean> {
  const validator = createCorsOriginValidator(
    ['http://localhost:4200', 'https://trusted.example'],
    [{ address: 0xc0a80164, mask: 0xffffff00 }], // 192.168.1.100/24
  );

  return new Promise((resolve, reject) => {
    validator(origin, (error, allowed) =>
      error ? reject(error) : resolve(Boolean(allowed)),
    );
  });
}

describe('createCorsOriginValidator', () => {
  it('allows configured origins and requests without an Origin header', async () => {
    await expect(check('https://trusted.example')).resolves.toBe(true);
    await expect(check()).resolves.toBe(true);
  });

  it('allows browser origins on a dynamically discovered local subnet', async () => {
    await expect(check('http://192.168.1.42:4200')).resolves.toBe(true);
  });

  it('rejects other subnets, hostnames, and unsupported protocols', async () => {
    await expect(check('http://192.168.2.42:4200')).resolves.toBe(false);
    await expect(check('https://untrusted.example')).resolves.toBe(false);
    await expect(check('file://192.168.1.42')).resolves.toBe(false);
  });
});
