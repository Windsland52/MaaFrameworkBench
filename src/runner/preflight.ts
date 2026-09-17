import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 起进程之前的静态检查。两件事：
 *   1. 结构：pipeline 目录在不在、入口节点在不在 —— 框架自己的报错分不清
 *      「没交东西」和「交错了名字」（症状都是 task not exist）。
 *   2. **动作白名单**：默认禁止 Command 节点 —— pipeline 里写一个 Command，
 *      就是在跑评测的这台机器上执行任意程序（框架直接起本地进程、不走控制器）。
 *
 * 报错里的路径一律相对**工作区**：run.json 是给人看的，里面出现临时目录的绝对路径
 * 只会让读的人困惑。
 */

/* ---------- 容错解析 ---------- */

/** 去 "//" 与 "/* *\/" 注释，字符串里的不算。 */
function stripComments(text: string): string {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** 去掉 "}" / "]" 前面的尾随逗号。 */
function stripTrailingCommas(text: string): string {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j += 1
      if (text[j] === '}' || text[j] === ']') {
        i += 1 // 丢掉这个逗号
        continue
      }
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * 按框架的宽容度解析：实测它接受注释与尾随逗号（.jsonc 和 .json 都接受）。
 * 我们检查时也必须接受 —— 否则一份合法提交会因为"解析失败"被判违规，那是检查在误伤。
 *
 * 但**解析不了就必须拒**：解析不了 = 扫不到动作 = 不能放行。宽容在这里，拒绝在调用方。
 */
export function parseLooseJson(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripComments(text.replace(/^\uFEFF/, ''))))
}

/* ---------- 读包 ---------- */

interface BundleJson {
  /** 相对工作区的路径，进错误信息 */
  rel: string
  /** default_pipeline 里只有 Default 块会被所有节点继承；pipeline/ 里每个键都是节点 */
  isDefaultFile: boolean
  value: unknown | null
  parseError?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseOne(rel: string, path: string, isDefaultFile: boolean): BundleJson {
  try {
    return { rel, isDefaultFile, value: parseLooseJson(readFileSync(path, 'utf8')) }
  } catch (err) {
    return { rel, isDefaultFile, value: null, parseError: err instanceof Error ? err.message : String(err) }
  }
}

function readBundleJson(bundle: string): BundleJson[] {
  const out: BundleJson[] = []
  const pipelineDir = join(bundle, 'pipeline')
  if (existsSync(pipelineDir)) {
    for (const name of readdirSync(pipelineDir).sort()) {
      if (!name.endsWith('.json') && !name.endsWith('.jsonc')) continue
      out.push(parseOne('resource/base/pipeline/' + name, join(pipelineDir, name), false))
    }
  }
  for (const name of ['default_pipeline.jsonc', 'default_pipeline.json']) {
    const path = join(bundle, name)
    if (!existsSync(path)) continue
    out.push(parseOne('resource/base/' + name, path, true))
    break // 框架也是先 jsonc 后 json，只取其一
  }
  return out
}

/* ---------- 检查一：结构 ---------- */

export function preflightPipeline(bundle: string, entry: string): string[] {
  const files = readBundleJson(bundle)
  if (files.length === 0) return ['resource/base/pipeline 下没有任何可加载的 json：这次跑没有可执行的产出']

  const problems: string[] = []
  const nodeNames = new Set<string>()
  for (const file of files) {
    if (file.parseError !== undefined) {
      problems.push(file.rel + ' 解析失败: ' + file.parseError)
      continue
    }
    if (!isObject(file.value)) {
      problems.push(file.rel + ' 顶层不是对象')
      continue
    }
    for (const [name, value] of Object.entries(file.value)) {
      if (name === 'Default') continue // 默认值块不是节点
      if (file.isDefaultFile) continue // default_pipeline 里除 Default 外都是动作默认参数，不是节点
      if (isObject(value)) nodeNames.add(name)
    }
  }

  if (problems.length === 0 && !nodeNames.has(entry)) {
    problems.push('入口节点 ' + entry + ' 不在 pipeline 里（现有: ' + [...nodeNames].sort().join(', ') + '）')
  }
  return problems
}

/* ---------- 检查二：动作白名单 ---------- */

/** 默认禁止的动作。Custom 不在其列：它是必测项，而且没有注册回调时本来就跑不起来。 */
const FORBIDDEN_ACTIONS = ['Command']

/** 节点/默认块的动作名，两种写法都认："action": "Command" 与 "action": {"type": "Command"} */
function actionOf(node: unknown): string | null {
  if (!isObject(node)) return null
  const action = node.action
  if (typeof action === 'string') return action
  if (isObject(action) && typeof action.type === 'string') return action.type
  return null
}

/**
 * 扫提交里的动作。**只扫真正会被框架执行的键**，两个方向都要防：
 *   - 漏：Default 块里藏一个 Command，会让所有继承它的节点都变成 Command
 *   - 误伤：default_pipeline 里给 Command 预设参数（{"Command": {...}}）本身不执行任何东西
 * 所以 pipeline/ 里除 Default 外每个键都当节点扫；default_pipeline 里只扫 Default 块。
 */
export function scanForbiddenActions(bundle: string, allowed: string[] = []): string[] {
  const forbidden = FORBIDDEN_ACTIONS.filter((a) => !allowed.includes(a))
  if (forbidden.length === 0) return []

  const problems: string[] = []
  for (const file of readBundleJson(bundle)) {
    if (file.parseError !== undefined) {
      problems.push(file.rel + ' 解析失败，扫不到动作所以不放行: ' + file.parseError)
      continue
    }
    if (!isObject(file.value)) continue
    for (const [name, value] of Object.entries(file.value)) {
      const isDefaultBlock = name === 'Default'
      if (file.isDefaultFile && !isDefaultBlock) continue
      const action = actionOf(value)
      if (action === null || !forbidden.includes(action)) continue
      problems.push(
        file.rel +
          ' 里的 ' +
          (isDefaultBlock ? 'Default 块（所有节点都继承它）' : '节点 ' + name) +
          ' 用了被禁止的动作 ' +
          action +
          '：它会在跑评测的这台机器上直接执行程序',
      )
    }
  }
  return problems
}
