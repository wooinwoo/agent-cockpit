import { execFileSync, spawn } from 'node:child_process';
import { dirname } from 'node:path';

const parentPid = Number(process.argv[2]);
const serverPath = process.argv[3];
if (!Number.isInteger(parentPid) || parentPid < 2 || !serverPath) process.exit(2);

// Parse the replacement before the current server commits to shutting down.
// Keep standalone compatibility with older servers that do not use IPC.
try {
  execFileSync(process.execPath, ['--check', serverPath], { timeout: 5000, stdio: 'pipe' });
} catch { process.exit(1); }
if (process.send) process.send({ type: 'ready' });

for (let attempt = 0; attempt < 100; attempt++) {
  try { process.kill(parentPid, 0); }
  catch (error) {
    if (error.code !== 'ESRCH') process.exit(1);
    const child = spawn(process.execPath, [serverPath, '--no-open'], {
      cwd: dirname(serverPath), env: process.env, detached: true, stdio: 'ignore',
    });
    child.unref();
    process.exit(0);
  }
  await new Promise(resolve => setTimeout(resolve, 100));
}

process.exit(1);
