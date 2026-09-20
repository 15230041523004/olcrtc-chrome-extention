#!/usr/bin/env node
/**
 * Generate default static PNG icons for extension/icons/
 * (16x16, 32x32, 48x48, 128x128) using pure Node.js zlib deflate.
 * Exact optical diaphragm matching the reference design.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'extension', 'icons');

function createPng(width, height, rgbaBuffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcVal = crc32(Buffer.concat([typeBuf, data]));
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crcVal >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const rowBytes = width * 4;
  const scanlines = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    scanlines[y * (rowBytes + 1)] = 0;
    rgbaBuffer.copy(scanlines, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }

  const idatData = deflateSync(scanlines);
  const ihdrChunk = chunk('IHDR', ihdr);
  const idatChunk = chunk('IDAT', idatData);
  const iendChunk = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function drawDefaultIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const outerR = size * 0.46;
  const rimR = size * 0.38;
  const housingR = rimR * 0.92;
  const coreR = size * 0.25;
  const numBlades = 8;
  const numNotches = 16;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - center + 0.5;
      const dy = y - center + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);
      const normAngle = (angle + Math.PI * 2) % (Math.PI * 2);
      const idx = (y * size + x) * 4;

      if (dist > outerR) {
        buf[idx] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 0;
        continue;
      }

      // Outer Grip Ring (Rim with 16 notches)
      if (dist >= rimR) {
        const notchPhase = (normAngle / (Math.PI * 2)) * numNotches;
        const isNotch = (notchPhase % 1) > 0.65;
        const alpha = dist > outerR - 0.7 ? Math.round(255 * (outerR - dist + 0.7)) : 255;

        if (isNotch) {
          buf[idx] = 125; buf[idx + 1] = 211; buf[idx + 2] = 252; buf[idx + 3] = Math.min(255, alpha); // #7dd3fc
        } else {
          buf[idx] = 56; buf[idx + 1] = 189; buf[idx + 2] = 248; buf[idx + 3] = Math.min(255, alpha);  // #38bdf8
        }
        continue;
      }

      // Bezel Groove Ring
      if (dist >= housingR) {
        buf[idx] = 15; buf[idx + 1] = 23; buf[idx + 2] = 42; buf[idx + 3] = 255; // #0f172a
        continue;
      }

      // Diaphragm Blades (Open state)
      if (dist > coreR) {
        const isBorder = (dist - coreR) < 1.0 || (housingR - dist) < 0.8;
        if (isBorder) {
          buf[idx] = 56; buf[idx + 1] = 189; buf[idx + 2] = 248; buf[idx + 3] = 255; // #38bdf8
        } else {
          buf[idx] = 3; buf[idx + 1] = 105; buf[idx + 2] = 161; buf[idx + 3] = 255;  // #0369a1
        }
        continue;
      }

      // Central Luminous Laser Core
      const coreT = dist / coreR;
      // Refractive concentric rings
      const isRefractRing = Math.abs(coreT - 0.58) < 0.08;

      if (coreT <= 0.35) {
        // Pure bright center
        buf[idx] = 240; buf[idx + 1] = 249; buf[idx + 2] = 255; buf[idx + 3] = 255;
      } else if (isRefractRing) {
        // Concentric refractive highlight
        buf[idx] = 224; buf[idx + 1] = 242; buf[idx + 2] = 254; buf[idx + 3] = 255;
      } else if (coreT <= 0.7) {
        // Radiant cyan
        const t = (coreT - 0.35) / 0.35;
        buf[idx] = Math.round(125 * (1 - t) + 56 * t);
        buf[idx + 1] = Math.round(211 * (1 - t) + 189 * t);
        buf[idx + 2] = Math.round(252 * (1 - t) + 248 * t);
        buf[idx + 3] = 255;
      } else {
        // Electric azure gradient
        const t = (coreT - 0.7) / 0.3;
        buf[idx] = Math.round(56 * (1 - t) + 2 * t);
        buf[idx + 1] = Math.round(189 * (1 - t) + 132 * t);
        buf[idx + 2] = Math.round(248 * (1 - t) + 199 * t);
        buf[idx + 3] = 255;
      }
    }
  }

  return createPng(size, size, buf);
}

await mkdir(outDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const png = drawDefaultIcon(size);
  const filePath = join(outDir, `icon${size}.png`);
  await writeFile(filePath, png);
  console.log(`Generated ${filePath} (${png.length} bytes)`);
}
