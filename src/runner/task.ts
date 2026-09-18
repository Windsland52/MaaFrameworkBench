import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'

/**
 * 一屏的声明。transitions 表示点进矩形就切到 target；不声明则输入不改变画面。
 *
 * 一屏有三个名字，各服务一个读者：
 *   name         断言用（`env_state: equals: home`）—— held-out
 *   path         数据集里的文件名 —— 给人查问题看
 *   captured_at  交付进 agent 工作区时的文件名（按 MaaFW 截图规范）—— agent 看的
 */
export interface TaskScreen {
  name: string
  path: string
  /** 物化进工作区时用的名字，形如 2026.09.18-21.07.41.318.png */
  captured_at?: string
  transitions?: Array<{ area: [number, number, number, number]; target: string }>
}

export type EnvSpec = {
  type: 'frames'
  dataset: string
  /** 数据集内画面所在子目录 */ dir: string
  screens: TaskScreen[]
}

export type AssertSpec =
  | { kind: 'env_state'; path: string; equals: unknown }
  | { kind: 'node_hit'; order?: string[]; required?: string[] }
  /** 某个节点识别到的文本（答案是画面内容的任务靠它判"答对没有"） */
  /** node 可选：写了只认那个节点；不写就是「这一跑里任何节点读到过这段文本」——
      节点名只有在题面约定过的时候才是公平的判据，否则等于判了实现风格 */
  | { kind: 'reco_text'; node?: string; equals: string }
  | { kind: 'op_count'; max_screencaps?: number; max_clicks?: number }

export interface TaskDef {
  schema_version: number
  id: string
  kind: string
  covers: string[]
  env: EnvSpec
  /** agent 工作区里可见的文件，相对 datasets.yaml 的 data_root（或仓库根，以 tasks/ 开头） */
  visible: string[]
  entry: string
  prompt: string
  budget: {
    wall_ms?: number
    max_screencaps?: number
    /** 每个节点的识别等待上限，注入成 Default.timeout。不写 = 用框架默认（20 秒） */
    node_timeout_ms?: number
  }
  /** 允许的动作。默认空 = 禁 Command（见 preflight 的动作白名单） */
  allow_actions: string[]
  assert: AssertSpec[]
}

function fail(path: string, message: string): never {
  throw new Error(path + ': ' + message)
}

/** 预算里的数字直接决定杀进程的时机，写错了代价很大，所以这里逐项校验。 */
function parseBudget(path: string, raw: unknown): TaskDef['budget'] {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(path, 'budget 必须是映射')
  const o = raw as Record<string, unknown>
  const out: TaskDef['budget'] = {}
  for (const key of ['wall_ms', 'max_screencaps', 'node_timeout_ms'] as const) {
    const value = o[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      fail(path, 'budget.' + key + ' 必须是正整数，实际 ' + JSON.stringify(value))
    }
    out[key] = value
  }
  return out
}

function parseStringArray(path: string, key: string, raw: unknown): string[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) fail(path, key + ' 必须是字符串数组')
  return raw as string[]
}

/** 任务包是外部输入（手写 / 将来由造题脚本生成），错在哪儿必须报准，不能等跑起来才发现。 */
export function parseTask(path: string, raw: unknown): TaskDef {
  if (typeof raw !== 'object' || raw === null) fail(path, '顶层必须是映射')
  const o = raw as Record<string, unknown>
  const need = <T>(key: string): T => {
    if (o[key] === undefined) fail(path, '缺少字段 ' + key)
    return o[key] as T
  }

  if (o.schema_version !== 1) fail(path, 'schema_version 必须是 1，实际 ' + String(o.schema_version))

  const envRaw = need<Record<string, unknown>>('env')
  if (envRaw.type !== 'frames') fail(path, 'env.type=' + String(envRaw.type) + ' 尚未实现（当前只有 frames）')
  if (typeof envRaw.dataset !== 'string') fail(path, 'env.dataset 必须是数据集 id')
  if (typeof envRaw.dir !== 'string') fail(path, 'env.dir 必须是数据集目录（相对 datas.yaml 的 data_root）')
  const screens = envRaw.screens
  if (!Array.isArray(screens) || screens.length === 0) fail(path, 'env.screens 必须是非空数组')
  const names = new Set<string>()
  for (const screen of screens) {
    const s = screen as Record<string, unknown>
    if (typeof s.name !== 'string' || typeof s.path !== 'string') fail(path, 'env.screens 每项都要有 name 与 path')
    if (names.has(s.name)) fail(path, 'env.screens 出现重名屏 ' + s.name)
    names.add(s.name)
  }
  for (const screen of screens) {
    const s = screen as { name: string; transitions?: Array<{ target?: unknown }> }
    for (const t of s.transitions ?? []) {
      if (typeof t.target !== 'string' || !names.has(t.target)) {
        fail(path, '屏 ' + s.name + ' 的 transition.target ' + String(t.target) + ' 不在 env.screens 里')
      }
    }
  }

  const assertRaw = need<unknown[]>('assert')
  if (!Array.isArray(assertRaw) || assertRaw.length === 0) fail(path, 'assert 必须是非空数组')
  const kinds = new Set(['env_state', 'node_hit', 'reco_text', 'op_count'])
  for (const a of assertRaw) {
    const kind = (a as { kind?: unknown }).kind
    if (typeof kind !== 'string' || !kinds.has(kind)) fail(path, '未知断言 kind: ' + String(kind))
    if (kind === 'env_state') {
      const e = a as { path?: unknown; equals?: unknown }
      if (typeof e.path !== 'string') fail(path, 'env_state 缺少 path')
      if (e.equals === undefined) fail(path, 'env_state 缺少 equals')
    }
  }

  return {
    schema_version: 1,
    id: need<string>('id'),
    kind: need<string>('kind'),
    covers: (o.covers as string[] | undefined) ?? [],
    env: {
      type: 'frames',
      dataset: envRaw.dataset,
      dir: envRaw.dir,
      screens: screens as TaskScreen[],
    },
    visible: (o.visible as string[] | undefined) ?? [],
    entry: need<string>('entry'),
    prompt: need<string>('prompt'),
    budget: parseBudget(path, o.budget),
    allow_actions: parseStringArray(path, 'allow_actions', o.allow_actions),
    assert: assertRaw as AssertSpec[],
  }
}

/**
 * `visible` 里的一项在**工作区**里叫什么。
 *
 * 数据集帧交付时按该屏声明的 `captured_at` 改名（数据集里的名字有语义，是给我们查问题看的；
 * 工作区里那份不该有语义）；任务包自己的文件保持相对路径。
 *
 * 物化与痕迹检查共用这一个规则 —— 规则写两遍，早晚有一遍是错的。
 */
export function deliveredPath(task: TaskDef, visible: string): string {
  if (visible.startsWith('tasks/')) return visible.replace(/^tasks\/[^/]+\//, '')
  const screen = task.env.type === 'frames' ? task.env.screens.find((s) => s.path === visible) : undefined
  return 'frames/' + (screen?.captured_at ?? visible)
}

export function loadTask(repoRoot: string, taskId: string): { task: TaskDef; taskFile: string } {
  const taskFile = resolve(repoRoot, 'tasks', taskId, 'task.yaml')
  const raw = load(readFileSync(taskFile, 'utf8')) as Record<string, unknown>
  const task = parseTask(taskFile, raw)
  if (task.id !== taskId) throw new Error(taskFile + ': id (' + task.id + ') 与目录名 (' + taskId + ') 不一致')
  return { task, taskFile }
}
