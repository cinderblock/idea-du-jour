/**
 * Generate PWA icons as PNGs (no native deps — hand-rolled PNG via node:zlib).
 * Design: full-bleed dark square, an amber "idea" dot, a soft white shine.
 * Full-bleed (no transparency/rounding) so iOS/Android masking looks right.
 *
 * Usage: bun run scripts/gen-icons.ts   → writes public/icon-*.png etc.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

const BG = [0x10, 0x10, 0x14] // near-black
const AMBER = [0xf5, 0x9e, 0x0b]
const SHINE = [0xff, 0xff, 0xff]

function iconPixels(n: number): Buffer {
  const buf = Buffer.alloc(n * n * 4)
  const cx = n / 2
  const cy = n / 2
  const r = n * 0.3 // dot radius (well within maskable safe zone)
  const shineX = cx - r * 0.35
  const shineY = cy - r * 0.35
  const shineR = r * 0.28
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4
      let c = BG
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      if (d <= r) c = AMBER
      const ds = Math.hypot(x + 0.5 - shineX, y + 0.5 - shineY)
      if (ds <= shineR) c = blend(AMBER, SHINE, 0.55 * (1 - ds / shineR))
      buf[i] = c[0]
      buf[i + 1] = c[1]
      buf[i + 2] = c[2]
      buf[i + 3] = 0xff
    }
  }
  return buf
}

function blend(a: number[], b: number[], t: number): number[] {
  const k = Math.max(0, Math.min(1, t))
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ]
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(n: number, rgba: Buffer): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(n, 0)
  ihdr.writeUInt32BE(n, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  // 10..12 = compression/filter/interlace = 0
  const raw = Buffer.alloc(n * (n * 4 + 1))
  for (let y = 0; y < n; y++) {
    raw[y * (n * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (n * 4 + 1) + 1, y * n * 4, (y + 1) * n * 4)
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync('public', { recursive: true })
for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
] as const) {
  writeFileSync(`public/${name}`, encodePng(size, iconPixels(size)))
  console.log(`wrote public/${name} (${size}x${size})`)
}
