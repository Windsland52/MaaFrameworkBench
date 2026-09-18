import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 执行方法的自检 —— 两条**静默失效**的底线：
 *
 *   1. **一次 run 只 post 一次 task**：整条 next 链由框架走完，我们不做逐节点投喂。
 *   2. **画面只由输入驱动**：不是像 Dbg 那样按截图次数轮播 —— 那会让多屏流程静默错位。
 *
 * 两条坏掉都不报错，只会让分数悄悄失去意义（多识别一次、少识别一次，帧就错位了；
 * 逐节点投喂则让"轨迹"不再是框架跑出来的轨迹）。所以要有人守着，
 * 而不是靠"记得它是这么写的"。
 */

/** 能把画面带走的输入。screencap / shell / touch_up 不会。 */
const MOVING_OPS = ['click', 'swipe', 'touch_down']

export interface MethodEvidence {
  events: Array<Record<string, unknown>>
  ops: Array<Record<string, unknown>>
  /** 本次 run 应当 post 的入口节点名 */
  entry: string
}

export function methodProblems(ev: MethodEvidence): string[] {
  // 子进程被硬杀时没有过程证据：那是"没跑到"，不是"方法坏了"
  if (ev.events.length === 0 && ev.ops.length === 0) return []
  return [...taskPostProblems(ev.events, ev.entry), ...frameProblems(ev.ops)]
}

/** 从 run 产物读证据。文件缺失当"没有证据"，不当失败 —— 那是判分器 stages 的事。 */
export function runMethodProblems(runDir: string, entry: string): string[] {
  return methodProblems({
    events: readJsonl(resolve(runDir, 'events.jsonl')),
    ops: readJsonl(resolve(runDir, 'ops.jsonl')),
    entry,
  })
}

function taskPostProblems(events: Array<Record<string, unknown>>, entry: string): string[] {
  const problems: string[] = []
  const starts = events.filter((e) => e.msg === 'Task.Starting')
  if (events.length > 0 && starts.length !== 1) {
    problems.push('事件流里有 ' + starts.length + ' 个 Task.Starting —— 一次 run 只该 post 一次 task')
  }
  const ends = events.filter((e) => e.msg === 'Task.Succeeded' || e.msg === 'Task.Failed')
  if (ends.length > 1) problems.push('事件流里有 ' + ends.length + ' 个任务结束事件')
  if (starts.length === 1 && starts[0]!.entry !== entry) {
    problems.push('post 的入口是 ' + JSON.stringify(starts[0]!.entry) + '，任务声明的是 ' + entry)
  }
  return problems
}

/**
 * 画面推进的账：每次换屏都必须由**上一条真的把画面带走了的输入**造成。
 *
 * 按顺序判而不是只看总数：Dbg 型错位在总数上完全看不出来 —— 它的特征恰恰是
 * "换屏出现在 screencap 那一行"，而这只有对着序列才看得见。
 *
 * 两条规则各挡一个方向：
 *   - 换屏了却不是输入造成的 → 画面在跟着截图次数走
 *   - 输入说自己把画面带走了，画面却没换 → moved 这一栏是假的
 */
function frameProblems(ops: Array<Record<string, unknown>>): string[] {
  const problems: string[] = []
  if (ops.length === 0) return problems

  let screen = String(ops[0]!.screen)
  for (let i = 1; i < ops.length; i += 1) {
    const prev = ops[i - 1]!
    const row = ops[i]!
    const here = String(row.screen)

    if (here !== screen) {
      const causedByInput = MOVING_OPS.includes(String(prev.op)) && prev.moved === true
      if (!causedByInput) {
        problems.push(
          '第 ' +
            (i + 1) +
            ' 条记录的画面从 ' +
            screen +
            ' 变成 ' +
            here +
            '，而上一条（' +
            brief(prev) +
            '）并没有把画面带走 —— 画面在跟着截图次数走',
        )
      }
      screen = here
    }

    if (MOVING_OPS.includes(String(row.op)) && row.moved === true) {
      const next = ops[i + 1]
      // 最后一条无从对证：不指控（宁可漏，不可冤）
      if (next !== undefined && String(next.screen) === screen) {
        problems.push('第 ' + (i + 1) + ' 条输入记着 moved=true，但画面没换（仍是 ' + screen + '）')
      }
    }
  }
  return problems
}

/** 进报错信息的那种"一句话说清这条记录干了什么"。 */
function brief(row: Record<string, unknown>): string {
  const op = String(row.op)
  if (op === 'screencap') return 'screencap'
  return op + (row.moved === true ? '（记着 moved=true）' : '（没把画面带走）')
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })
}
