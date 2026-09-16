import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 起进程之前的静态检查。
 *
 * 为什么非要先查一遍：框架自己的报错在「资源包加载不了」和「入口节点不存在」之间是含糊的
 * （症状都是 task not exist），而这两种情况的下一步动作完全不同 ——
 * 一个是没交东西，一个是交错了名字。这里多说一句，报告里就少一次翻日志。
 *
 * 报错里的路径一律相对**工作区**，不写绝对路径：run.json 是要给人看的，
 * 里面出现 `C:\Users\<某台机器>\AppData\Local\Temp\...` 只会让读的人困惑。
 */
export function preflightPipeline(bundle: string, entry: string): string[] {
  const rel = 'resource/base'
  const pipelineDir = join(bundle, 'pipeline')
  if (!existsSync(pipelineDir)) {
    return [rel + '/pipeline 不存在：资源包里没有 pipeline/ 目录']
  }

  const files = readdirSync(pipelineDir).filter((f) => f.endsWith('.json') || f.endsWith('.jsonc'))
  if (files.length === 0) {
    return [rel + '/pipeline 里没有任何 .json：这次跑没有可执行的产出']
  }

  const nodeNames = new Set<string>()
  const problems: string[] = []
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(pipelineDir, file), 'utf8')) as Record<string, unknown>
      for (const [name, value] of Object.entries(raw)) {
        // 默认值对象（Default）不是节点
        if (name === 'Default' && typeof value === 'object' && !('recognition' in (value as object))) continue
        nodeNames.add(name)
      }
    } catch (err) {
      problems.push(rel + '/pipeline/' + file + ' 解析失败: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  if (problems.length === 0 && !nodeNames.has(entry)) {
    problems.push('入口节点 ' + entry + ' 不在 pipeline 里（现有: ' + [...nodeNames].sort().join(', ') + '）')
  }
  return problems
}
