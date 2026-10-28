import { networkInterfaces, release } from 'node:os';
import { isIPv4 } from 'node:net';
import { execFileSync } from 'node:child_process';
import { IS_WSL } from './platform.js';

const isTailscale = ip => isIPv4(ip) && ip.split('.')[0] === '100'
  && Number(ip.split('.')[1]) >= 64 && Number(ip.split('.')[1]) <= 127;

export function getNetworkIPs({ interfaces = networkInterfaces, wsl = IS_WSL || /microsoft/i.test(release()), exec = execFileSync } = {}) {
  const result = [];
  try {
    for (const nets of Object.values(interfaces())) for (const net of nets) {
      if (net.family !== 'IPv4' || net.internal || !isIPv4(net.address)) continue;
      result.push({ ip: net.address, type: isTailscale(net.address) ? 'tailscale' : 'lan' });
    }
  } catch { /* Network interfaces may be unavailable during startup. */ }
  if (wsl) {
    // WSL interfaces do not include the Windows host's Tailscale adapter.
    try {
      const output = exec('/mnt/c/Program Files/Tailscale/tailscale.exe', ['status', '--json'], {
        encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      });
      const status = JSON.parse(output);
      const host = status.Self?.DNSName?.replace(/\.$/, '').toLowerCase();
      // HTTP Serve routes by the MagicDNS host, not the Windows adapter IP.
      if (status.BackendState === 'Running' && typeof host === 'string'
          && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/.test(host)) {
        for (const ip of status.Self.TailscaleIPs || []) {
          if (isTailscale(ip) && !result.some(item => item.ip === ip)) result.unshift({ ip, host, type: 'tailscale' });
        }
      }
    } catch { /* Tailscale is optional; retain the available LAN addresses. */ }
  }
  return result.sort((a, b) => Number(b.type === 'tailscale') - Number(a.type === 'tailscale'));
}
