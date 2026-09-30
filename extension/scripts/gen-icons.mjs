#!/usr/bin/env node
/**
 * Draws the extension's icons (16, 32, 48, 128 px): a blue rounded square with a white plane, anti-aliased by 4x4
 * supersampling, written as PNG with Node's zlib. No fonts, no image files, no dependencies, deterministic.
 *
 * Usage (from extension/): node scripts/gen-icons.mjs   -> icons/icon{16,32,48,128}.png
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

export const SIZES = [16, 32, 48, 128];
const BLUE = [29, 78, 216];
const WHITE = [255, 255, 255];
const SS = 4;

/** Plane pointing up in a unit square: fuselage ellipse, swept wings, tail. */
const WINGS = [[0.5, 0.33], [0.93, 0.56], [0.93, 0.645], [0.5, 0.5], [0.07, 0.645], [0.07, 0.56]];
const TAIL = [[0.5, 0.71], [0.7, 0.835], [0.7, 0.895], [0.5, 0.815], [0.3, 0.895], [0.3, 0.835]];

/**
 * @param {number} x
 * @param {number} y
 * @param {number[][]} poly
 */
function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = /** @type {[number, number]} */ (poly[i]);
    const [xj, yj] = /** @type {[number, number]} */ (poly[j]);
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point (unit square, y down) inside the plane, which is drawn turned 45 degrees clockwise (nose to the upper right). */
function inPlane(/** @type {number} */ x, /** @type {number} */ y) {
  // Inverse rotation of the sample point around the centre (cos 45 = sin 45 = SQRT1_2).
  const dx = x - 0.5;
  const dy = y - 0.5;
  const px = 0.5 + dx * Math.SQRT1_2 + dy * Math.SQRT1_2;
  const py = 0.5 - dx * Math.SQRT1_2 + dy * Math.SQRT1_2;
  const ex = (px - 0.5) / 0.065;
  const ey = (py - 0.475) / 0.37;
  return ex * ex + ey * ey <= 1 || inPolygon(px, py, WINGS) || inPolygon(px, py, TAIL);
}

/** Rounded square filling the icon, corner radius 22%. */
function inBackground(/** @type {number} */ x, /** @type {number} */ y) {
  const r = 0.22;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= 0 && x <= 1 && y >= 0 && y <= 1;
}

/**
 * RGBA pixels of one icon.
 * @param {number} size
 */
export function renderIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const n = SS * SS;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      let bg = 0;
      let plane = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (col + (sx + 0.5) / SS) / size;
          const y = (row + (sy + 0.5) / SS) / size;
          if (!inBackground(x, y)) continue;
          bg++;
          if (inPlane(x, y)) plane++;
        }
      }
      const o = (row * size + col) * 4;
      if (bg === 0) continue;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round((/** @type {number} */ (BLUE[c]) * (bg - plane) + /** @type {number} */ (WHITE[c]) * plane) / bg);
      px[o + 3] = Math.round((255 * bg) / n);
    }
  }
  return px;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** @param {Uint8Array} bytes */
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = /** @type {number} */ (CRC_TABLE[(c ^ b) & 0xff]) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type
 * @param {Uint8Array} data
 */
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * An 8-bit RGBA PNG (every row with filter 0).
 * @param {number} size
 * @param {Uint8Array} rgba
 */
export function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let row = 0; row < size; row++) Buffer.from(rgba.subarray(row * size * 4, (row + 1) * size * 4)).copy(raw, row * (size * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function main() {
  for (const size of SIZES) {
    const file = new URL(`../icons/icon${size}.png`, import.meta.url);
    writeFileSync(file, encodePng(size, renderIcon(size)));
    console.log(`gen-icons: wrote icons/icon${size}.png`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
