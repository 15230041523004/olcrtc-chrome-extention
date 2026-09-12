#!/usr/bin/env node
/**
 * Pack extension/ into dist/olcrtc-chrome-extension-<version>.zip
 * with a versioned folder at the zip root for Chrome "Load unpacked".
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'extension');
const dist = join(root, 'dist');
const skip = new Set(['vp8-wire-test.html']);

function zipPath(filePath) {
  return relative(source, filePath).split(sep).join(posix.sep);
}

function shouldSkip(filePath) {
  const name = zipPath(filePath);
  const base = posix.basename(name);
  return skip.has(base) || base.endsWith('.map');
}

async function walk(dir, files = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, files);
    else if (entry.isFile() && !shouldSkip(full)) files.push(full);
  }
  return files;
}

function dosDateTime(date) {
  const year = Math.max(date.getFullYear() - 1980, 0);
  const dosDate = (year << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  return { dosDate, dosTime };
}

function u16(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value);
  return buf;
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

function zipEntry(name, data, date) {
  const nameBuf = Buffer.from(name, 'utf8');
  const compressed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data) >>> 0;
  const { dosDate, dosTime } = dosDateTime(date);
  const flags = 0x0800;
  const method = 8;
  const local = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(flags),
    u16(method),
    u16(dosTime),
    u16(dosDate),
    u32(crc),
    u32(compressed.length),
    u32(data.length),
    u16(nameBuf.length),
    u16(0),
    nameBuf,
    compressed,
  ]);
  const central = Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(flags),
    u16(method),
    u16(dosTime),
    u16(dosDate),
    u32(crc),
    u32(compressed.length),
    u32(data.length),
    u16(nameBuf.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    nameBuf,
  ]);
  return { local, central, compressedSize: compressed.length, size: data.length };
}

const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
const version = manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`invalid manifest version: ${version}`);
  process.exit(1);
}

const tag = process.env.GITHUB_REF_NAME;
if (tag && /^v\d+\.\d+\.\d+$/.test(tag) && tag !== `v${version}`) {
  console.error(`tag ${tag} does not match manifest version ${version}`);
  process.exit(1);
}

const folder = `olcrtc-chrome-extension-${version}`;
const files = (await walk(source)).sort((a, b) => zipPath(a).localeCompare(zipPath(b)));
if (!files.some((file) => zipPath(file) === 'manifest.json')) {
  console.error('pack is missing manifest.json');
  process.exit(1);
}
if (!files.some((file) => zipPath(file) === 'lib/vendor/tls-wasm/rust_tls_wasm_bg.wasm')) {
  console.error('pack is missing rust_tls_wasm_bg.wasm');
  process.exit(1);
}

const locals = [];
const centrals = [];
let offset = 0;
let bytes = 0;
for (const file of files) {
  const data = await readFile(file);
  const mtime = (await stat(file)).mtime;
  const name = `${folder}/${zipPath(file)}`;
  const entry = zipEntry(name, data, mtime);
  entry.central.writeUInt32LE(offset, 42);
  locals.push(entry.local);
  centrals.push(entry.central);
  offset += entry.local.length;
  bytes += entry.size;
}

const central = Buffer.concat(centrals);
const eocd = Buffer.concat([
  u32(0x06054b50),
  u16(0),
  u16(0),
  u16(files.length),
  u16(files.length),
  u32(central.length),
  u32(offset),
  u16(0),
]);

// Keep previously built versions alongside the new archive.
await mkdir(dist, { recursive: true });
const zipPathOut = join(dist, `${folder}.zip`);
await writeFile(zipPathOut, Buffer.concat([...locals, central, eocd]));
console.log(JSON.stringify({
  version,
  files: files.length,
  bytes,
  zip: relative(root, zipPathOut).split(sep).join(posix.sep),
  size: (await stat(zipPathOut)).size,
}, null, 2));
