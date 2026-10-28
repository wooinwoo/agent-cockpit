#!/usr/bin/env node
// ─── Build Installer: auto-generate Tauri resources + build NSIS installer ───
// Uses ncc-bundled dist/ instead of full node_modules/ (129MB → ~5MB with native addons)
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync, cpSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

if (process.platform === 'linux') {
  const { buildNativeInstaller } = await import('./build-native-installer.mjs');
  buildNativeInstaller();
  process.exit(0);
}
if (process.platform === 'win32') {
  const { buildWslInstaller } = await import('./build-wsl-installer.mjs');
  buildWslInstaller();
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TAURI_CONF = join(ROOT, 'src-tauri', 'tauri.conf.json');

// ─── Helpers ───
function scanDirs(base, dir = '') {
  const dirs = [];
  const full = join(base, dir);
  if (!existsSync(full)) return dirs;
  const entries = readdirSync(full, { withFileTypes: true });
  const hasFiles = entries.some(e => e.isFile());
  if (dir && hasFiles) dirs.push(dir);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    dirs.push(...scanDirs(base, rel));
  }
  return dirs;
}

function dirSize(dir) {
  let total = 0;
  if (!existsSync(dir)) return 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) {
        try {
          const p = join(entry.parentPath || entry.path || dir, entry.name);
          total += statSync(p).size;
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return total;
}

function removeFiles(dir, predicate) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir, { recursive: true })) {
    const fp = join(dir, String(f));
    if (existsSync(fp) && statSync(fp).isFile() && predicate(String(f))) {
      unlinkSync(fp);
    }
  }
}

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const arch = process.arch; // x64 or arm64

// ─── Step 1: Run ncc bundle ───
const distDir = join(ROOT, 'dist');
console.log('📦 Step 1: Running ncc bundle (server.js → dist/)...');
try {
  execSync('npx ncc build server.js -o dist --minify', { cwd: ROOT, stdio: 'inherit' });
} catch (err) {
  console.error('❌ ncc bundle failed:', err.message);
  console.error('   Run: npm install --save-dev @vercel/ncc');
  process.exit(1);
}

const distSize = dirSize(distDir);
console.log(`   Bundle size: ${(distSize / 1024 / 1024).toFixed(1)}MB`);

// ─── Step 2: Copy native addon (node-pty) into dist/node_modules/ ───
// ncc can't bundle native .node files. The bundled index.js uses createRequire()
// which resolves node_modules/ relative to dist/index.js.
// We copy only: package.json, lib/*.js (no .map, no .test), prebuilds for current platform.
console.log('🔧 Step 2: Preparing native addons (node-pty)...');

const ptyNmDst = join(distDir, 'node_modules', 'node-pty');
mkdirSync(ptyNmDst, { recursive: true });

// 2a: package.json
cpSync(
  join(ROOT, 'node_modules', 'node-pty', 'package.json'),
  join(ptyNmDst, 'package.json')
);

// 2b: lib/*.js (no .map, no .test.js)
const ptyLibSrc = join(ROOT, 'node_modules', 'node-pty', 'lib');
const ptyLibDst = join(ptyNmDst, 'lib');
mkdirSync(ptyLibDst, { recursive: true });
for (const f of readdirSync(ptyLibSrc)) {
  const src = join(ptyLibSrc, f);
  if (statSync(src).isDirectory()) {
    // Copy subdirectories (shared/, worker/)
    cpSync(src, join(ptyLibDst, f), { recursive: true });
  } else if (f.endsWith('.js') && !f.includes('.test.') && !f.endsWith('.map')) {
    cpSync(src, join(ptyLibDst, f));
  }
}
// Remove .map files from copied subdirs
removeFiles(ptyLibDst, f => f.endsWith('.map'));

// 2c: prebuilds — current platform only (skip .pdb debug symbols)
const ptyPlatformDir = `${process.platform}-${arch}`;
const ptySrc = join(ROOT, 'node_modules', 'node-pty', 'prebuilds', ptyPlatformDir);
const ptyPrebuildsDst = join(ptyNmDst, 'prebuilds', ptyPlatformDir);

if (existsSync(ptySrc)) {
  mkdirSync(ptyPrebuildsDst, { recursive: true });
  cpSync(ptySrc, ptyPrebuildsDst, { recursive: true });
  // Remove .pdb files (17MB+ of debug symbols, not needed at runtime)
  removeFiles(ptyPrebuildsDst, f => f.endsWith('.pdb'));
  console.log(`   Copied node-pty prebuilds for ${ptyPlatformDir} (without .pdb)`);
} else {
  console.warn(`   ⚠️  node-pty prebuilds not found for ${ptyPlatformDir}`);
}

const nativeSize = dirSize(join(distDir, 'node_modules'));
console.log(`   Native addons size: ${(nativeSize / 1024 / 1024).toFixed(1)}MB`);

// ─── Step 3: Build Tauri resource map ───
console.log('📝 Step 3: Building Tauri resource map...');

const resources = {
  // Bundled server (replaces server.js + lib/ + routes/ + most of node_modules/)
  '../dist/*': './dist/',
  // Frontend assets (served as static files by the bundled server)
  '../index.html': './',
  '../manifest.json': './',
  '../sw.js': './',
  '../package.json': './',
  // Frontend JS modules
  '../js/*': './js/',
  // CSS modules
  '../css/*': './css/',
  // Vendor libraries (xterm, chart.js — served as static)
  '../vendor/*': './vendor/',
  // Data directories
  '../workflows/*': './workflows/',
  '../defaults/*': './defaults/',
};

// Add dist subdirectories (node_modules/node-pty/...)
const distSubDirs = scanDirs(distDir);
for (const dir of distSubDirs) {
  resources[`../dist/${dir}/*`] = `./dist/${dir}/`;
}

console.log(`   Resource entries: ${Object.keys(resources).length} (was 1000+ with full node_modules)`);

// ─── Step 4: Update tauri.conf.json ───
console.log('📝 Step 4: Updating tauri.conf.json resources...');
const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf8'));
conf.bundle.resources = resources;
writeFileSync(TAURI_CONF, JSON.stringify(conf, null, 2) + '\n');
console.log('   Updated tauri.conf.json');

// ─── Step 5: Check icons ───
const iconsDir = join(ROOT, 'src-tauri', 'icons');
if (!existsSync(iconsDir)) {
  console.log('🎨 Step 5: Generating default icons...');
  mkdirSync(iconsDir, { recursive: true });
  try {
    execSync('npx tauri icon', { cwd: ROOT, stdio: 'inherit' });
  } catch {
    console.log('   Warning: Could not generate icons. Using defaults.');
  }
} else {
  console.log('🎨 Step 5: Icons already exist, skipping');
}

// ─── Step 6: Print size comparison & build ───
const totalBundleSize = dirSize(distDir);
const nmSize = dirSize(join(ROOT, 'node_modules'));
const bundleType = isMac ? 'DMG' : 'NSIS';

console.log(`\n🔨 Step 6: Building Tauri ${bundleType} installer...`);
console.log(`   📊 Size comparison:`);
console.log(`      node_modules (old): ${(nmSize / 1024 / 1024).toFixed(0)}MB`);
console.log(`      dist/ bundle (new): ${(totalBundleSize / 1024 / 1024).toFixed(1)}MB`);
console.log(`      reduction:          ${((1 - totalBundleSize / nmSize) * 100).toFixed(0)}%\n`);
console.log('   This may take several minutes on first build.\n');

try {
  execSync('cargo tauri build', {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, COCKPIT_PORT: undefined }
  });
} catch {
  console.error('\n❌ Build failed. Common fixes:');
  console.error('   - Install Rust: https://rustup.rs/');
  console.error('   - Install Tauri CLI: cargo install tauri-cli');
  console.error('   - Check Node.js is in PATH');
  if (isMac) console.error('   - Install Xcode Command Line Tools: xcode-select --install');
  process.exit(1);
}

// ─── Step 7: Locate output ───
if (isMac) {
  const dmgDir = join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'dmg');
  if (existsSync(dmgDir)) {
    const installers = readdirSync(dmgDir).filter(f => f.endsWith('.dmg'));
    if (installers.length) {
      console.log('\n✅ DMG built successfully!');
      console.log(`   📂 ${join(dmgDir, installers[0])}`);
    }
  } else {
    console.log('\n⚠️  Build completed but DMG output not found.');
    console.log('   Check src-tauri/target/release/bundle/');
  }
} else {
  const nsisDir = join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  if (existsSync(nsisDir)) {
    const installers = readdirSync(nsisDir).filter(f => f.endsWith('.exe'));
    if (installers.length) {
      console.log('\n✅ Installer built successfully!');
      console.log(`   📂 ${join(nsisDir, installers[0])}`);
    }
  } else {
    console.log('\n⚠️  Build completed but NSIS output not found.');
    console.log('   Check src-tauri/target/release/bundle/');
  }
}
