import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FramesScreen } from './screen.ts'

/** Buffer -> ArrayBuffer（maa-node 的 ImageData = ArrayBuffer） */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

export interface ActorOp {
  /** 操作类型，与 Controller.Action 同名 */
  op: string
  /** screencap 之外的输入操作带的参数 */
  arg?: unknown
  /** 操作发生时的屏名 */
  screen: string
  /** 输入是否被环境接受（screencap 恒 true） */
  ok: boolean
  /** 输入是否真的改变了画面 —— 后面的 ops.jsonl 靠它看"点对了没有" */
  moved: boolean
  /**
   * screencap 交出去的那张图落在 `screens/` 里的文件名 —— 就是**它被交出去的时间**。
   * 不落盘（没给目录）时没有这一栏：名字指向一个不存在的文件比没有名字更糟。
   */
  shot?: string
  /** 单调时钟毫秒，仅用于诊断耗时，不作为判分依据 */
  at: number
}

export interface FramesActor {
  actor: maa.CustomControllerActor
  screen: () => string
  ops: () => ActorOp[]
  /** 场景结束时的快照，runner 把它落进 ops.jsonl */
  state: () => Array<{ screen: string; at: number }>
}

function inArea(area: [number, number, number, number], x: number, y: number): boolean {
  const [ax, ay, aw, ah] = area
  return x >= ax && x < ax + aw && y >= ay && y < ay + ah
}

/**
 * frames 环境的控制器侧：喂当前屏的图，输入只在命中 transitions 时切屏。
 *
 * 「没有应用」这条边界改不掉，但可以让画面**依赖输入**：镜头包本身就是那个序列。
 * 代价是同一屏只能有一条路径 —— 这正是 frames 支撑识别类任务的原因。
 */
export function createActor(screens: FramesScreen[], shotDir?: string): FramesActor {
  if (screens.length === 0) throw new Error('frames 环境至少需要一屏')
  const byName = new Map(screens.map((s) => [s.name, s]))
  const encoded = new Map(screens.map((s) => [s.name, toArrayBuffer(readFileSync(s.path))]))
  if (byName.size !== screens.length) throw new Error('frames 环境存在重名屏')

  const ops: ActorOp[] = []
  const history: Array<{ screen: string; at: number }> = []
  let current = screens[0]!
  history.push({ screen: current.name, at: Date.now() })

  const record = (op: string, screen: string, ok: boolean, moved: boolean, arg?: unknown, shot?: string): void => {
    ops.push({ op, arg, screen, ok, moved, ...(shot === undefined ? {} : { shot }), at: Date.now() })
  }

  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  /** 上一次交图的时间，用来保证同一毫秒连拍两张时名字不撞（撞了就静默覆盖）。 */
  let lastShotAt = 0
  /**
   * 与 MaaFW 自己保存截图同一种名字（`MaaUtils/Time.hpp` 的 `format_now_for_filename`）：
   * 一张图的名字就是**它被交出去的那一刻**。名字里没有屏名 —— 那是环境内部的事，
   * 图本身长什么样、什么时候给的，才是拿到图的人能用的信息。
   */
  const saveShot = (bytes: ArrayBuffer): string => {
    const now = Date.now()
    lastShotAt = now > lastShotAt ? now : lastShotAt + 1
    const d = new Date(lastShotAt)
    const name =
      d.getFullYear() +
      '.' +
      pad(d.getMonth() + 1) +
      '.' +
      pad(d.getDate()) +
      '-' +
      pad(d.getHours()) +
      '.' +
      pad(d.getMinutes()) +
      '.' +
      pad(d.getSeconds()) +
      '.' +
      pad(d.getMilliseconds(), 3) +
      '.png'
    if (shotDir !== undefined) {
      mkdirSync(shotDir, { recursive: true })
      writeFileSync(join(shotDir, name), Buffer.from(bytes))
    }
    return name
  }
  /**
   * 输入命中 transitions 就切屏；没命中不算失败 —— 真实环境里点空白也不报错。
   * 记的是**动作出发时**的屏，不是切完之后的那屏：同一份 ops.jsonl 里要能看出
   * "在哪屏上做的这个动作 / 这个动作把画面带到了哪"，两个都不丢。
   *
   * `moved` 只认"画面真的换了"：声明一条指回自己的 transition 时画面并没有动，
   * 记成 true 就等于在 ops 里撒谎，而"点对了没有"正是从这一栏读的。
   */
  const apply = (op: string, x: number, y: number, arg: unknown): boolean => {
    const from = current.name
    const hit = current.transitions?.find((t) => inArea(t.area, x, y))
    const target = (hit ? byName.get(hit.target) : undefined) ?? current
    const moved = target.name !== from
    if (moved) {
      current = target
      history.push({ screen: current.name, at: Date.now() })
    }
    record(op, from, true, moved, arg)
    return true
  }

  const actor: maa.CustomControllerActor = {
    connect: () => true,
    // 设备串号。**别写成带评测字样的东西**：框架会把它写进 maafw.log（实测 4 行），
    // 任何"让 agent 看一眼设备信息或日志"的路径都会顺手告诉它"你在被评测"。
    // Custom 控制器是 interface.json 里已经写着的事实，所以这个串号不额外泄漏什么。
    request_uuid: () => 'custom-ctrl-0001',
    get_features: () => [],
    screencap: () => {
      const bytes = encoded.get(current.name) ?? null
      record('screencap', current.name, true, false, undefined, bytes === null ? undefined : saveShot(bytes))
      return bytes
    },
    click: async (x: number, y: number) => apply('click', x, y, { x, y }),
    swipe: async (x1: number, y1: number, x2: number, y2: number) => apply('swipe', x2, y2, { x1, y1, x2, y2 }),
    touch_down: async (contact: number, x: number, y: number) => apply('touch_down', x, y, { contact, x, y }),
    touch_up: async (contact: number) => {
      record('touch_up', current.name, true, false, { contact })
      return true
    },
    shell: async (cmd: string) => {
      record('shell', current.name, false, false, { cmd })
      return null
    },
    inactive: () => true,
    get_info: () => JSON.stringify({ type: 'frames', screen: current.name, ops: ops.length }),
  }

  return {
    actor,
    screen: () => current.name,
    ops: () => ops,
    state: () => history.slice(),
  }
}
