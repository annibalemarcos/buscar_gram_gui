#!/usr/bin/env node
/**
 * build-python.js — runs PyInstaller to produce a standalone binary
 * of buscar_gram.py into ./pybin/ (per-platform).
 *
 * Called automatically before electron-builder (prebuild script).
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, 'pybin');
const BIN_NAME = process.platform === 'win32' ? 'buscar_gram.exe' : 'buscar_gram';
const FINAL_BIN = path.join(OUT_DIR, BIN_NAME);

function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')} (exit ${r.status})`);
  }
}

function pickPython() {
  const candidates = process.platform === 'win32'
    ? ['python', 'py']
    : ['python3', 'python'];
  for (const c of candidates) {
    const r = spawnSync(c, ['--version']);
    if (r.status === 0) return c;
  }
  throw new Error('Python 3.9+ não encontrado no PATH. Instale Python pra empacotar com PyInstaller.');
}

function main() {
  // Skip rebuild if binary already exists and SKIP_PYBUILD=1
  if (process.env.SKIP_PYBUILD === '1' && fs.existsSync(FINAL_BIN)) {
    console.log(`[build-python] SKIP_PYBUILD=1 e ${FINAL_BIN} já existe. Pulando.`);
    return;
  }

  const py = pickPython();
  console.log(`[build-python] Python: ${py}`);

  // Install deps (idempotente)
  run(py, ['-m', 'pip', 'install', '--upgrade', 'pip']);
  run(py, ['-m', 'pip', 'install', 'pyinstaller', 'telethon', 'python-dotenv']);

  // Clean previous build
  for (const d of ['build', 'dist-py']) {
    const p = path.join(ROOT, d);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }

  // Run PyInstaller (one file, no console window flicker — we *want* console
  // because the Electron PTY captures it).
  run(py, [
    '-m', 'PyInstaller',
    '--clean',
    '--noconfirm',
    '--onefile',
    '--name', 'buscar_gram',
    '--distpath', 'dist-py',
    '--workpath', 'build',
    '--specpath', 'build',
    '--hidden-import=telethon',
    '--hidden-import=telethon.sync',
    '--hidden-import=telethon.tl.types',
    '--hidden-import=telethon.errors',
    '--hidden-import=dotenv',
    'buscar_gram.py',
  ]);

  // Copy into pybin/
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const built = path.join(ROOT, 'dist-py', BIN_NAME);
  if (!fs.existsSync(built)) {
    throw new Error(`Binário não foi gerado em ${built}`);
  }
  fs.copyFileSync(built, FINAL_BIN);
  if (process.platform !== 'win32') {
    fs.chmodSync(FINAL_BIN, 0o755);
  }
  console.log(`[build-python] OK → ${FINAL_BIN}`);
}

try {
  main();
} catch (e) {
  console.error(`[build-python] ERRO: ${e.message}`);
  process.exit(1);
}
