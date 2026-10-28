import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const explicitNode = args[0] === '--node';
if (explicitNode) args.shift();

if (explicitNode || process.platform !== 'linux') {
  if (!explicitNode) {
    console.error('Cockpit: native startup currently supports Linux/WSL. This platform still uses the Node backend.');
  }
  const server = new URL('../server.js', import.meta.url);
  process.argv = [process.execPath, fileURLToPath(server), ...args];
  await import(server.href);
} else {
  const command = '/bin/sh';
  const argv = [command, fileURLToPath(new URL('./start-cockpit.sh', import.meta.url)), ...args];
  // Replace the launcher where supported, so it retains no Node heap or signal
  // forwarding process while the native manager is running.
  if (typeof process.execve === 'function') {
    process.execve(command, argv, process.env);
  } else {
    const child = spawn(command, argv.slice(1), { stdio: 'inherit' });
    const signals = ['SIGINT', 'SIGTERM'];
    const forward = signal => child.kill(signal);
    for (const signal of signals) process.on(signal, forward);
    child.once('error', error => {
      console.error(`Cockpit startup failed: ${error.message}`);
      process.exitCode = 1;
    });
    child.once('exit', (code, signal) => {
      for (const name of signals) process.off(name, forward);
      process.exitCode = code ?? 128 + (constants.signals[signal] || 0);
    });
  }
}
