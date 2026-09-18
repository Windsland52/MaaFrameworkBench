import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { scorerIdentity } from '../runner/identity.ts'
import { REPO_ROOT } from '../runner/root.ts'
import { loadTask, type AssertSpec, type TaskDef } from '../runner/task.ts'

/**
 * 判分器是纯函数：只读 run 目录 + task.yaml，写 run 目录下的 score.json。
 * 它不看任务过程、不看框架的 succeeded —— 那两样都不是"业务做成了没有"。
 */

export interface AssertResult {
  kind: string
  ok: boolean
  detail: string
}

export interface ScoreResult {
  schema_version: number
  run_id: string
  task_id: string
  submission_sha256: string
  /** 这份分数是哪版判据打出来的（改判据后靠它判断该不该重打分） */
  scorer: { version: number; sha256: string }
  passed: boolean
  stages: { load: boolean; graph: boolean; execute: boolean; achieve: boolean }
  asserts: AssertResult[]
  metrics: Record<string, number>
  score: number
}

interface RunMeta {
  run_id?: string
  task_id?: string
  status?: string
  submission?: { sha256?: string }
  wall_ms?: number
}

function readJsonFile(path: string): unknown | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
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

/** 一条断言要的证据可能来自不同文件，这里只负责把三份记录交给判定函数。 */
interface Evidence {
  run: RunMeta
  ops: Array<Record<string, unknown>>
  events: Array<Record<string, unknown>>
  task: TaskDef
}

function judgeEnvState(assert: AssertSpec & { kind: 'env_state' }, ev: Evidence): AssertResult {
  const last = [...ev.ops].reverse().find((op) => typeof op.screen === 'string')
  const actual = last?.screen ?? null
  const ok = actual === assert.equals
  return {
    kind: 'env_state',
    ok,
    detail: assert.path + '=' + String(actual) + (ok ? '' : '（期望 ' + JSON.stringify(assert.equals) + '）'),
  }
}

/**
 * 节点命中序列。取 Starting 与 Succeeded 两种事件、按出现顺序、连续重名去重。
 *
 * 为什么两种都要：最后一个节点实测**只发 Succeeded 不发 Starting**（跑 3 节点流程时
 * Main.Quantity 有识别结果却没有 Starting），只认 Starting 会把它判成"没命中"。
 * 为什么只认这两种：失败节点在 node_detail() 里名字为空，用"名字出现过"当命中会把
 * 没跑到的节点也算进去。
 */
function hitNodes(events: Array<Record<string, unknown>>): string[] {
  const hits: string[] = []
  for (const e of events) {
    const name = nodeEventName(e)
    if (name === null) continue
    if (hits[hits.length - 1] === name) continue
    hits.push(name)
  }
  return hits
}

/**
 * Succeeded 事件顶层 name 是**父节点**（实测：跑 Main.AtInventory -> Main.Quantity 时，
 * 那条 Succeeded 的 name 是 Main.AtInventory），真正完成的节点在 node_details.name。
 * 拿顶层 name 当命中会把最后一步记到前一个节点头上。
 */
function nodeEventName(e: Record<string, unknown>): string | null {
  if (e.msg === 'PipelineNode.Starting') {
    return typeof e.name === 'string' && e.name !== '' ? e.name : null
  }
  if (e.msg !== 'PipelineNode.Succeeded') return null
  const details = e.node_details
  if (typeof details === 'object' && details !== null) {
    const name = (details as { name?: unknown }).name
    if (typeof name === 'string' && name !== '') return name
  }
  return typeof e.name === 'string' && e.name !== '' ? e.name : null
}

function judgeNodeHit(assert: AssertSpec & { kind: 'node_hit' }, ev: Evidence): AssertResult {
  const hits = hitNodes(ev.events)
  const problems: string[] = []
  if (assert.required) {
    for (const name of assert.required) if (!hits.includes(name)) problems.push('未命中 ' + name)
  }
  if (assert.order) {
    const order = assert.order
    let cursor = 0
    for (const name of hits) {
      if (name === order[cursor]) cursor += 1
    }
    if (cursor < order.length) problems.push('顺序缺 ' + order.slice(cursor).join(' -> '))
  }
  return {
    kind: 'node_hit',
    ok: problems.length === 0,
    detail:
      problems.length === 0 ? '命中 ' + hits.join(' -> ') : problems.join('；') + '（实际 ' + hits.join(' -> ') + '）',
  }
}

function countOps(ops: Array<Record<string, unknown>>, op: string): number {
  return ops.filter((o) => o.op === op).length
}

/**
 * 答案是不是画面里的那个值：只看识别结果，不看 agent 自己的话。
 *
 * 不写 node 时扫全部节点的识别结果 —— 题面没约定过节点名，判它叫什么就不公平：
 * 同一份正确的产出，换个命名就挂，那判的是实现风格不是业务达成。
 */
function judgeRecoText(assert: AssertSpec & { kind: 'reco_text' }, ev: Evidence): AssertResult {
  const texts = ev.events
    .filter((e) => e.msg === 'Recognition.Succeeded' && (assert.node === undefined || e.name === assert.node))
    .map((e) => (typeof e.text === 'string' ? e.text : null))
    .filter((t): t is string => t !== null)
  const ok = texts.includes(assert.equals)
  const who = assert.node ?? '任一节点'
  const seen = [...new Set(texts)].map((t) => JSON.stringify(t)).join(', ')
  return {
    kind: 'reco_text',
    ok,
    detail:
      who + ' 识别到 ' + (texts.length === 0 ? '（无）' : seen) + (ok ? '' : '，期望 ' + JSON.stringify(assert.equals)),
  }
}

function judgeOpCount(assert: AssertSpec & { kind: 'op_count' }, ev: Evidence): AssertResult {
  const screencaps = countOps(ev.ops, 'screencap')
  const clicks = countOps(ev.ops, 'click')
  const problems: string[] = []
  if (assert.max_screencaps !== undefined && screencaps > assert.max_screencaps) {
    problems.push('识别 ' + screencaps + ' 次 > ' + assert.max_screencaps)
  }
  if (assert.max_clicks !== undefined && clicks > assert.max_clicks) {
    problems.push('点击 ' + clicks + ' 次 > ' + assert.max_clicks)
  }
  return {
    kind: 'op_count',
    ok: problems.length === 0,
    detail: problems.length === 0 ? '识别 ' + screencaps + ' 次 / 点击 ' + clicks + ' 次' : problems.join('；'),
  }
}

function judge(assert: AssertSpec, ev: Evidence): AssertResult {
  switch (assert.kind) {
    case 'env_state':
      return judgeEnvState(assert, ev)
    case 'node_hit':
      return judgeNodeHit(assert, ev)
    case 'reco_text':
      return judgeRecoText(assert, ev)
    case 'op_count':
      return judgeOpCount(assert, ev)
  }
}

export async function score(runDir: string): Promise<ScoreResult> {
  const run = (readJsonFile(resolve(runDir, 'run.json')) as RunMeta | null) ?? {}
  const ops = readJsonl(resolve(runDir, 'ops.jsonl'))
  const events = readJsonl(resolve(runDir, 'events.jsonl'))

  const taskId = run.task_id
  if (!taskId) throw new Error('run.json 缺少 task_id，无法定位任务包: ' + runDir)
  const { task } = loadTask(REPO_ROOT, taskId)

  const ev: Evidence = { run, ops, events, task }
  const asserts = task.assert.map((a) => judge(a, ev))

  // stages 是诊断列，不进通过率：难任务上全员 0 分时靠它区分"加载失败 / 跑崩 / 没达成"
  const loadOk = existsSync(resolve(runDir, 'logs', 'maafw.log')) && events.length > 0
  const graphOk = events.some((e) => e.msg === 'Task.Starting' || e.msg === 'PipelineNode.Starting')
  const executeOk = run.status === 'succeeded'
  const achieveOk = asserts.every((a) => a.ok) && run.status === 'succeeded'

  const wallMs = typeof run.wall_ms === 'number' ? run.wall_ms : 0
  const result: ScoreResult = {
    schema_version: 1,
    run_id: run.run_id ?? '',
    task_id: taskId,
    submission_sha256: run.submission?.sha256 ?? '',
    scorer: scorerIdentity(),
    passed: achieveOk,
    stages: { load: loadOk, graph: graphOk, execute: executeOk, achieve: achieveOk },
    asserts,
    metrics: {
      screencaps: countOps(ops, 'screencap'),
      clicks: countOps(ops, 'click'),
      wall_ms: wallMs,
    },
    score: achieveOk ? 1 : 0,
  }
  writeFileSync(resolve(runDir, 'score.json'), JSON.stringify(result, null, 2))
  return result
}
