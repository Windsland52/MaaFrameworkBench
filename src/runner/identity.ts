import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { SCORER_SOURCES, SCORER_VERSION } from '../scorer/version.ts'
import { hashFiles, hashTree } from './hash.ts'
import { REPO_ROOT } from './root.ts'

/**
 * 三份身份，回答的是同一个问题：**这两个分数能不能放在一起比？**
 *
 * 规则（契约 §2）：可比 ⟺ 任务包哈希 + 判分器版本 + 系统身份 三者相同。
 * `schema_version` 不参与判断 —— 它是文件格式版本，只管"读不读得出来"。
 *
 * 缺了这些字段，改一次断言或判据就会让老分数**静默过期**（同一份 run 前后能判出不同结果）。
 */

/** 任务身份 = `task.yaml` + `seed/`。**不含 fixtures/** —— 换夹具不影响这道题是什么。 */
export function taskIdentity(taskId: string): string {
  return hashTree(resolve(REPO_ROOT, 'tasks', taskId), (rel) => rel.startsWith('fixtures')).sha256
}

/**
 * 环境身份 = 数据集在 `datasets.yaml` 里的**声明**（含每个文件的 sha256），
 * 不读实际文件：声明的哈希就是"如果一切正常，落地的东西该是什么"。
 */
export function envIdentity(datasetId: string): string {
  const manifest = load(readFileSync(resolve(REPO_ROOT, 'datasets.yaml'), 'utf8')) as {
    datasets?: Record<string, { target?: string; files?: Array<{ name?: string; sha256?: string }> }>
  }
  const spec = manifest.datasets?.[datasetId]
  if (!spec) throw new Error('datasets.yaml 里找不到数据集: ' + datasetId)
  const lines = [
    'target=' + (spec.target ?? ''),
    ...(spec.files ?? []).map((f) => (f.name ?? '') + '\t' + (f.sha256 ?? '')).sort(),
  ]
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** 判分器身份 = 判定逻辑那份源码（自动） + 人手声明的语义版本 */
export function scorerIdentity(): { version: number; sha256: string } {
  return { version: SCORER_VERSION, sha256: hashFiles(REPO_ROOT, [...SCORER_SOURCES]) }
}
