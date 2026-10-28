import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { getNetworkIPs } from '../../lib/network-addresses.js';

test('WSL QR prefers a valid Windows Tailscale address and never treats CLI errors as hosts', () => {
  const interfaces = () => ({ eth0: [{ family: 'IPv4', internal: false, address: '172.26.1.2' }] });
  const result = getNetworkIPs({ interfaces, wsl: true, exec: (file, args) => {
    assert.equal(file, '/mnt/c/Program Files/Tailscale/tailscale.exe');
    assert.deepEqual(args, ['status', '--json']);
    return JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'desktop.tail123.ts.net.', TailscaleIPs: ['100.89.45.85', '100.89.45.85', 'invalid', '100.128.1.2'] } });
  } });
  assert.deepEqual(result, [{ ip: '100.89.45.85', host: 'desktop.tail123.ts.net', type: 'tailscale' }, { ip: '172.26.1.2', type: 'lan' }]);
  for (const DNSName of ['bad.ts.net/path', '<script>.ts.net', 'desktop.example.com', '', null]) {
    assert.deepEqual(getNetworkIPs({ interfaces, wsl: true, exec: () => JSON.stringify({ BackendState: 'Running', Self: { DNSName, TailscaleIPs: ['100.89.45.85'] } }) }), [{ ip: '172.26.1.2', type: 'lan' }]);
  }
  assert.deepEqual(getNetworkIPs({ interfaces, wsl: true, exec: () => { throw new Error('not installed'); } }), [{ ip: '172.26.1.2', type: 'lan' }]);
  assert.deepEqual(getNetworkIPs({ interfaces, wsl: false, exec: () => assert.fail('not WSL') }), [{ ip: '172.26.1.2', type: 'lan' }]);
});

test('proxied loopback requests cannot inherit local HTTP, WebSocket or CLI privileges', () => {
  const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function isLocalhost(req)');
  const fn = runInNewContext(source.slice(start, source.indexOf('// ──────────── Host allowlist', start)) + ';isLocalhost');
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(fn({ socket: { remoteAddress }, headers: {} }), true);
    for (const name of ['x-forwarded-for', 'forwarded', 'tailscale-user-login']) {
      assert.equal(fn({ socket: { remoteAddress }, headers: { [name]: '' } }), false);
      assert.equal(fn({ socket: { remoteAddress }, headers: { [name]: '127.0.0.1' } }), false);
    }
  }
  assert.equal(fn({ socket: { remoteAddress: '100.89.45.86' }, headers: {} }), false);
});
