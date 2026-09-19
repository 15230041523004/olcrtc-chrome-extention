#!/usr/bin/env node
/**
 * Rebuild extension/lib/vendor/tls-wasm from tls-wasm/.
 * Requires rustc, wasm-pack, and the wasm32-unknown-unknown target.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const crate = join(root, 'tls-wasm');
const out = join(root, 'extension', 'lib', 'vendor', 'tls-wasm');

if (process.platform === 'win32') {
  const home = process.env.USERPROFILE || '';
  const extraPaths = [
    join(home, '.cargo', 'bin'),
    'C:\\Program Files\\LLVM\\bin',
    'C:\\Program Files (x86)\\LLVM\\bin',
  ];
  process.env.PATH = extraPaths.concat(process.env.PATH || '').join(';');
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: crate, shell: true, ...opts });
  if (r.status !== 0) process.exit(r.status || 1);
}

{
  const check = spawnSync('wasm-pack', ['--version'], { shell: true });
  if (check.error || check.status !== 0) {
    console.error('wasm-pack not found. Install: cargo install wasm-pack');
    process.exit(1);
  }
}

run('wasm-pack', ['build', '--target', 'web', '--release']);
mkdirSync(out, { recursive: true });
const pkg = join(crate, 'pkg');
for (const name of ['rust_tls_wasm.js', 'rust_tls_wasm_bg.wasm', 'rust_tls_wasm.d.ts', 'package.json']) {
  const src = join(pkg, name);
  if (!existsSync(src)) {
    console.error(`missing ${src}`);
    process.exit(1);
  }
  copyFileSync(src, join(out, name));
}
console.log(`copied wasm to ${out}`);
