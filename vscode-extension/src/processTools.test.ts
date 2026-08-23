import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNetstatOwners } from './processTools';

test('parses only listening owners for the requested port', () => {
  const output = '  TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    1234\r\n  TCP    127.0.0.1:4200  0.0.0.0:0 LISTENING 9999\r\n  TCP 127.0.0.1:3000 127.0.0.1:55 ESTABLISHED 3333';
  assert.deepEqual(parseNetstatOwners(output, 3000), [{ port: 3000, pid: 1234, address: '0.0.0.0', state: 'LISTENING' }]);
});
