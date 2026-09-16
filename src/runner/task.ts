import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'

/** 一屏的声明。transitions 表示点进矩形就切到 target；不声明则输入不改变画面。 */
export interface TaskScreen {
  name: string
  path: string
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
  | { kind: 'reco_text'; node: string; equals: string }
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
  budget: { wall_ms?: number; max_screencaps?: number }
  assert: AssertSpec[]
}

function fail(path: string, message: string): never {
  throw new Error(path + ': ' + message)
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
    budget: (o.budget as TaskDef['budget'] | undefined) ?? {},
    assert: assertRaw as AssertSpec[],
  }
}

export function loadTask(repoRoot: string, taskId: string): { task: TaskDef; taskFile: string } {
  const taskFile = resolve(repoRoot, 'tasks', taskId, 'task.yaml')
  const raw = load(readFileSync(taskFile, 'utf8')) as Record<string, unknown>
  const task = parseTask(taskFile, raw)
  if (task.id !== taskId) throw new Error(taskFile + ': id (' + task.id + ') 与目录名 (' + taskId + ') 不一致')
  return { task, taskFile }
}
