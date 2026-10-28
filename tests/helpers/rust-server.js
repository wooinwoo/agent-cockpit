import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

export const rustBuildProfile = process.argv.includes('--release') ? 'release' : 'debug';
export const rustBinary = fileURLToPath(new URL(`../../rust-server/target/${rustBuildProfile}/cockpit-server`, import.meta.url));
const binary = rustBinary;

export async function verifyImmediateRustShutdown({ root, directory, env }, check) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const child = spawn(binary, ['--root', root, '--sandbox-dir', directory], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    let output = '', errors = '', signalled = false;
    child.stderr.on('data', chunk => { errors += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!signalled && output.includes('\n')) {
        signalled = true;
        child.kill('SIGTERM');
      }
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 8000);
    try {
      const result = await exited;
      check(signalled, true, `Immediate shutdown received readiness: ${errors}`);
      check(result, [0, null], 'SIGTERM immediately after readiness must take the graceful shutdown path');
    } finally { clearTimeout(timeout); }
  }
}

export async function stopRustServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    const [code,signal]=await exit;
    if (code!==0) throw new Error(`Rust shutdown failed: code=${code}, signal=${signal}`);
  } finally { clearTimeout(timer); }
}

export async function startRustServer({ root, directory, env }) {
  const child = spawn(binary,['--root',root,'--sandbox-dir',directory],{env,stdio:['ignore','pipe','pipe']});
  let output = '', failure = '', spawnError;
  child.once('error',error=>{spawnError=error;});
  child.stdout.on('data',data=>{output+=data;});
  child.stderr.on('data',data=>{failure+=data;});
  try {
    for (let i=0;i<200;i++) {
      if (spawnError || child.exitCode !== null) throw spawnError || new Error(`Rust startup failed: ${failure}`);
      if (output.includes('\n')) {
        const started=JSON.parse(output.split('\n')[0]);
        return {child,url:`http://${started.listening}`,started,stop:()=>stopRustServer(child)};
      }
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw new Error('Rust startup timeout');
  } catch (error) { await stopRustServer(child); throw error; }
}
