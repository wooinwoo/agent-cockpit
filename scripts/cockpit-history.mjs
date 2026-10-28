#!/usr/bin/env node
import { exportRecovery } from '../lib/recovery-history.js';

if (process.argv.length !== 4) {
  console.error('사용법: node scripts/cockpit-history.mjs <복구본 JSON 절대경로> <새 출력 폴더 절대경로>');
  process.exitCode = 1;
} else {
  try { console.log(`복구 파일 생성: ${exportRecovery(process.argv[2], process.argv[3])}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
