import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bundledJcodeBinary } from '@1jehuang/jcode-sdk';

if (process.platform === 'win32') throw new Error('This launcher requires a POSIX shell.');
const destination = join(homedir(), '.local', 'bin', 'jcode');
const marker = '# Cockpit managed jcode launcher';
try {
  if (!(await readFile(destination, 'utf8')).includes(marker)) throw new Error('Existing launcher is not managed by Cockpit.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const reuseLogin = process.argv.includes('--reuse-codex-login');
await mkdir(join(homedir(), '.local', 'bin'), { recursive: true });
await writeFile(destination, `#!/bin/sh\n${marker}\nexport JCODE_NO_TELEMETRY=1\n${reuseLogin ? 'export JCODE_ALLOW_CODEX_LEGACY_AUTH=1\n' : ''}exec ${quote(bundledJcodeBinary())} --no-update --no-selfdev "$@"\n`, { mode: 0o755 });
console.log(destination);
