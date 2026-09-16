import { readFileSync } from 'node:fs'
import { maafw } from '../../maa.ts'

/** Buffer -> ArrayBuffer（maa-node 的 ImageData = ArrayBuffer） */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

/**
 * V1 最小模拟器：一张固定画面当"屏幕"，输入直接成功。
 * 目标只有一个 —— 证明主底座（自研 CustomController）能跑通。
 */
export function createActor(framePath: string): maa.CustomControllerActor {
  const frame = toArrayBuffer(readFileSync(framePath)) // PNG 编码字节，非原始像素
  let screencaps = 0

  return {
    connect: () => true,
    request_uuid: () => 'bench-uuid-0001',
    get_features: () => [],
    screencap: () => {
      screencaps += 1
      return frame
    },
    click: async (x: number, y: number) => {
      console.log(`  [actor] click(${x}, ${y})`)
      return true
    },
    swipe: async (x1: number, y1: number, x2: number, y2: number) => {
      console.log(`  [actor] swipe(${x1},${y1}) -> (${x2},${y2})`)
      return true
    },
    shell: async (cmd: string) => {
      console.log(`  [actor] shell(${cmd})  <- 模拟环境下我们完全控制`)
      return null
    },
    inactive: () => true,
    get_info: () => JSON.stringify({ type: 'sim', screencaps }),
  }
}
