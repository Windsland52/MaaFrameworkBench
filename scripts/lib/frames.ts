import { DIGIT_GLYPHS, LETTER_GLYPHS, type Glyph } from './font.ts'
import { type Bitmap, createBitmap, encodePng, fillRect, strokeRect } from './png.ts'

/**
 * maafw-demo 帧素材，1280x720。
 *
 *   home           主页 —— STOCK / STATU 两个按钮，只有 STOCK 能进库存页
 *   inventory      库存页 —— 数量 12
 *   inventory-zero 库存页 —— 数量 34，held-out 变体（同屏不同值）
 *
 * 两个按钮**同尺寸、同颜色、只差一个字**：想点对就得真去读画面，
 * 靠"左边那个按钮"这种形状特征猜不过去。
 */

export const FRAME_WIDTH = 1280
export const FRAME_HEIGHT = 720

const BG: [number, number, number] = [0x1b, 0x20, 0x2c]
const PANEL: [number, number, number] = [0x28, 0x30, 0x42]
const INK: [number, number, number] = [0xf2, 0xf5, 0xfa]
const ACCENT: [number, number, number] = [0x3d, 0x8b, 0xfd]
const MUTED: [number, number, number] = [0x8a, 0x94, 0xa8]

function glyphFor(text: string, table: Record<string, Glyph>): Glyph {
  const shapes = [...text].map((ch) => {
    const shape = table[ch]
    if (!shape) throw new Error('缺字形: ' + ch)
    return shape
  })
  const height = shapes[0]!.length
  // 字间距 1 列：不留缝时 OCR 会把相邻字连成一个 token
  return Array.from({ length: height }, (_, row) => shapes.map((s) => s[row] ?? '.').join('.'))
}

/** 点阵按 scale 放大后逐行画；返回占用的宽度，便于居中。 */
function drawText(
  bmp: Bitmap,
  text: string,
  x: number,
  y: number,
  scale: number,
  rgb: [number, number, number],
  table: Record<string, Glyph>,
  digitsFirst = false,
): number {
  const glyph = glyphFor(text, digitsFirst ? DIGIT_GLYPHS : table)
  for (let row = 0; row < glyph.length; row += 1) {
    for (let col = 0; col < glyph[row]!.length; col += 1) {
      if (glyph[row]![col] === '#') fillRect(bmp, x + col * scale, y + row * scale, scale, scale, rgb)
    }
  }
  return glyph[0]!.length * scale
}

function textWidth(text: string, scale: number, table: Record<string, Glyph>): number {
  return glyphFor(text, table)[0]!.length * scale
}

function drawCentered(
  bmp: Bitmap,
  text: string,
  centerX: number,
  y: number,
  scale: number,
  rgb: [number, number, number],
  table: Record<string, Glyph>,
): void {
  drawText(bmp, text, Math.round(centerX - textWidth(text, scale, table) / 2), y, scale, rgb, table)
}

const LABEL = LETTER_GLYPHS
const DIGITS = DIGIT_GLYPHS

/** 界面外壳：三屏共用，只有内容在变。 */
function drawChrome(bmp: Bitmap, page: string): void {
  fillRect(bmp, 0, 0, FRAME_WIDTH, 96, PANEL)
  fillRect(bmp, 0, 96, FRAME_WIDTH, 2, ACCENT)
  drawText(bmp, page, 48, 36, 4, INK, LABEL)
  fillRect(bmp, 48, 660, 360, 6, MUTED)
}

/** 按钮的两种状态用同一个矩形：位置/尺寸/描边完全一致，只有文字不同。 */
function drawButton(
  bmp: Bitmap,
  x: number,
  y: number,
  text: string,
  rgb: [number, number, number],
  scale: number,
): void {
  strokeRect(bmp, x, y, 320, 140, 4, ACCENT)
  fillRect(bmp, x + 4, y + 4, 312, 132, PANEL)
  drawCentered(bmp, text, x + 160, y + 70 - (7 * scale) / 2, scale, rgb, LABEL)
}

export interface DemoFrame {
  name: string
  png: Buffer
}

/**
 * 帧的文件名按 **MaaFW 自己的截图命名规范**来：`MaaUtils/Time.hpp` 的
 * `format_now_for_filename()` —— `YYYY.MM.DD-HH.MM.SS.mmm`。
 * 框架保存截图（`VisionBase` / `PipelineTask` / `Actuator`）用的就是这个格式。
 *
 * 为什么要这样：语义化的名字（home.png / inventory.png）会替 agent 做判断 ——
 * 文件名直接告诉它"这是主页 / 这是库存页"。真实截图流没有语义，只有时间戳。
 *
 * 时间戳是**固定常量**，不是取当前时间：帧要能被确定性重建，sha256 钉在 datasets.yaml 里。
 */
const FRAME_TIMESTAMPS = ['2026.09.18-21.07.41.318', '2026.09.18-21.07.46.902', '2026.09.18-21.07.52.477']

export function renderFrames(): DemoFrame[] {
  return [
    { name: FRAME_TIMESTAMPS[0] + '.png', png: renderHome() },
    { name: FRAME_TIMESTAMPS[1] + '.png', png: renderInventory('12') },
    { name: FRAME_TIMESTAMPS[2] + '.png', png: renderInventory('34') },
  ]
}

function renderHome(): Buffer {
  const bmp = createBitmap(FRAME_WIDTH, FRAME_HEIGHT, BG)
  drawChrome(bmp, 'HOME')
  drawButton(bmp, 140, 300, 'STOCK', INK, 6)
  drawButton(bmp, 820, 300, 'STATU', INK, 6)
  drawCentered(bmp, 'MAIN MENU', 640, 560, 4, MUTED, LABEL)
  return encodePng(bmp)
}

function renderInventory(quantity: string): Buffer {
  const bmp = createBitmap(FRAME_WIDTH, FRAME_HEIGHT, BG)
  drawChrome(bmp, 'INVENTORY')
  drawText(bmp, 'THE QUANTITY', 120, 220, 4, MUTED, LABEL)
  drawText(bmp, quantity, 120, 300, 8, ACCENT, DIGITS, true)
  drawButton(bmp, 1040, 480, 'BACK', INK, 4)
  return encodePng(bmp)
}
