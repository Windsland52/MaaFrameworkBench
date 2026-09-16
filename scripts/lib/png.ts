import { deflateSync } from 'node:zlib'

/** 8-bit RGB 位图。帧素材只有纯色块与文字，不需要 alpha 通道。 */
export interface Bitmap {
  width: number
  height: number
  /** RGB 三元组，行优先，长度 = width * height * 3 */
  pixels: Uint8Array
}

export function createBitmap(width: number, height: number, rgb: [number, number, number]): Bitmap {
  const pixels = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 3] = rgb[0]
    pixels[i * 3 + 1] = rgb[1]
    pixels[i * 3 + 2] = rgb[2]
  }
  return { width, height, pixels }
}

export function fillRect(bmp: Bitmap, x: number, y: number, w: number, h: number, rgb: [number, number, number]): void {
  const x0 = Math.max(0, Math.floor(x))
  const y0 = Math.max(0, Math.floor(y))
  const x1 = Math.min(bmp.width, Math.floor(x + w))
  const y1 = Math.min(bmp.height, Math.floor(y + h))
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const i = (py * bmp.width + px) * 3
      bmp.pixels[i] = rgb[0]
      bmp.pixels[i + 1] = rgb[1]
      bmp.pixels[i + 2] = rgb[2]
    }
  }
}

/** 空心矩形：识别类任务里"按钮"的视觉特征就是边框 + 底色，实心块反而不像控件。 */
export function strokeRect(
  bmp: Bitmap,
  x: number,
  y: number,
  w: number,
  h: number,
  thickness: number,
  rgb: [number, number, number],
): void {
  fillRect(bmp, x, y, w, thickness, rgb)
  fillRect(bmp, x, y + h - thickness, w, thickness, rgb)
  fillRect(bmp, x, y, thickness, h, rgb)
  fillRect(bmp, x + w - thickness, y, thickness, h, rgb)
}

/* ---- PNG 编码（最小实现：IHDR + IDAT + IEND） ---- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([head, body, tail])
}

/**
 * 编码为 PNG。生成脚本要写的是文件，不是 buffer，所以这里返回 Buffer。
 * 逐行 filter 固定为 0（None）—— 帧是纯色块，压不压缩对结果没影响，但必须**确定性**：
 * 同样输入必须逐字节相同，否则 datasets.yaml 里的 sha256 每次都会漂。
 */
export function encodePng(bmp: Bitmap): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(bmp.width, 0)
  ihdr.writeUInt32BE(bmp.height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor RGB
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  const stride = bmp.width * 3
  const raw = Buffer.alloc((stride + 1) * bmp.height)
  for (let y = 0; y < bmp.height; y += 1) {
    raw[y * (stride + 1)] = 0
    Buffer.from(bmp.pixels.buffer, bmp.pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ])
}
