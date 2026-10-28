// The production function receives private interface and process providers.
// This oracle never enumerates the host or launches Tailscale/Windows commands.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { getNetworkIPs } from '../../lib/network-addresses.js';

const record = (address, extra = {}) => ({ family: 'IPv4', internal: false, address, ...extra });
const local = [['eth0', [record('172.26.1.2')]]];
const status = (DNSName = 'Desktop.tail123.ts.net.', TailscaleIPs = ['100.89.45.85'], extra = {}) =>
  JSON.stringify({ BackendState: 'Running', Self: { DNSName, TailscaleIPs }, ...extra });

export function makeFixtures() {
  const inputs = [];
  const add = (name, extra = {}) => inputs.push({ name, groups: local, wsl: false, ...extra });
  add('ordinary LAN');
  add('empty interfaces', { groups: [] });
  add('unavailable interfaces', { interfaceThrows: true });
  add('WSL host when Linux interfaces unavailable', { interfaceThrows: true, wsl: true, output: status() });
  add('Windows host preferred', { wsl: true, output: status() });
  add('CLI not installed', { wsl: true, execThrows: true });
  add('not WSL never runs the command', { output: status() });
  add('LAN duplicate addresses retained', { groups: [['eth0', [record('10.0.0.1'), record('10.0.0.1')]], ['eth1', [record('10.0.0.1')]]] });
  add('tailscale stable first partition', { groups: [['e0', [record('10.0.0.1'), record('100.90.1.1'), record('192.168.0.1'), record('100.100.0.2')]], ['e1', [record('100.100.0.3'), record('10.0.0.2')]]] });
  add('Windows list reverses new addresses and deduplicates', { groups: [['eth0', [record('172.26.1.2'), record('100.90.1.1')]]], wsl: true,
    output: status('desktop.tail123.ts.net.', ['100.90.1.1', '100.90.1.2', '100.90.1.3', '100.90.1.2']) });
  add('duplicate native address keeps native metadata', { groups: [['tailscale0', [record('100.89.45.85')]]], wsl: true, output: status() });
  add('integer interface name enumeration', { groups: [['eth0', [record('10.0.0.1')]], ['10', [record('10.0.0.10')]], ['2', [record('10.0.0.2')]], ['01', [record('10.0.0.3')]], ['4294967294', [record('10.0.0.4')]], ['4294967295', [record('10.0.0.5')]]] });
  for (const nets of [null, false, 1, {}, 'string', []]) {
    add('invalid interface group ' + JSON.stringify(nets), { groups: [['before', [record('10.0.0.1')]], ['invalid', nets], ['after', [record('10.0.0.2')]]] });
  }
  add('null address entry stops remaining enumeration', { groups: [['first', [record('10.0.0.1'), null, record('10.0.0.2')]], ['later', [record('10.0.0.3')]]], wsl: true, output: status() });
  for (const family of ['IPv6', 4, 'ipv4', null, false, 'IPv4']) {
    for (const internal of [true, false, '', 'false', 0, 1]) {
      add('family/internal ' + JSON.stringify([family, internal]), { groups: [['test', [record('100.90.1.1', { family, internal })]]] });
    }
  }
  for (const address of [
    '0.0.0.0', '255.255.255.255', '127.0.0.1', '169.254.0.1', '224.0.0.1',
    '100.63.255.255', '100.64.0.0', '100.127.255.255', '100.128.0.0',
    '99.64.1.1', '101.64.1.1', '010.0.0.1', '100.064.0.1', '100.64.01.1',
    '100.64.1.001', '100.64.1.256', '256.64.1.1', '1.2.3', '1.2.3.4.5',
    '1.2.3.4\n', ' 1.2.3.4', '+1.2.3.4', '-1.2.3.4', '0x64.64.1.1',
    '::1', '::ffff:100.64.1.1', '100.64.1.1/32', '100.64.1.1:80',
    '\ud800', '', null, true, 1, {}, [], ['100.64.1.1'],
  ]) {
    add('IPv4 ' + JSON.stringify(address), { groups: [['test', [record(address)]]] });
    add('Windows IPv4 ' + JSON.stringify(address), { wsl: true, output: status('host.ts.net.', [address]) });
  }
  for (const host of [
    'foo.ts.net', 'foo.ts.net.', 'FOO.TS.NET.', 'foo.bar.ts.net',
    'ts.net', '.ts.net', '-a.ts.net', 'a-.ts.net', 'a-b.ts.net',
    'a'.repeat(63) + '.ts.net', 'a'.repeat(64) + '.ts.net',
    'a.ts.net..', 'a..ts.net', 'a.ts.net/path', 'a.ts.net:443', 'a.ts.net?x=1',
    'a.ts.net#frag', '<script>.ts.net', ' a.ts.net', 'a.ts.net ',
    'a.ts.net\n', 'a.ts.net\r\n', 'a.ts.net.\n', 'a.ts.net\u2028',
    'a.ts.net\u0000', 'example.com', 'localhost', '127.0.0.1',
    '한글.ts.net', 'K.ts.net', 'İ.ts.net', '\ud800.ts.net',
    '', null, false, 42, {}, [], ['foo.ts.net'],
  ]) add('MagicDNS ' + JSON.stringify(host), { wsl: true, output: status(host) });
  for (const BackendState of ['Stopped', 'NeedsLogin', 'running', '', null, true, 1, 'Running']) {
    add('backend ' + JSON.stringify(BackendState), { wsl: true, output: status(undefined, undefined, { BackendState }) });
  }
  for (const ips of [null, false, '', '100.64.1.1', 5, {}, [], [null, '100.64.1.1', {}, '100.64.1.2']]) {
    add('TailscaleIPs ' + JSON.stringify(ips), { wsl: true, output: status('foo.ts.net', ips) });
  }
  for (const output of ['', '{broken', 'permission denied', 'null', '[]', '{}', 'false', '1', '{"BackendState":"Running","Self":null}', '{"BackendState":"Running","Self":{"DNSName":"foo.ts.net"}}']) {
    add('raw status ' + JSON.stringify(output), { wsl: true, output });
  }
  return inputs.map(input => {
    const calls = [];
    const value = getNetworkIPs({
      interfaces: () => { if (input.interfaceThrows) throw new Error('fixture interfaces unavailable'); return Object.fromEntries(input.groups); },
      wsl: input.wsl,
      exec: (program, args, options) => {
        calls.push({ program, args, options });
        assert.equal(program, '/mnt/c/Program Files/Tailscale/tailscale.exe');
        assert.deepEqual(args, ['status', '--json']);
        assert.equal(options.timeout, 3000);
        if (input.execThrows) throw new Error('fixture CLI unavailable');
        return input.output;
      },
    });
    assert.equal(calls.length, input.wsl ? 1 : 0);
    return { input, expected: { value, calls } };
  });
}

export const fixtures = makeFixtures();
if (process.argv.includes('--emit') || process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(fixtures) + '\n');
}
