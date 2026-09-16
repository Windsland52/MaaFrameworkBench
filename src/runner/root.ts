import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 仓库根目录。脚本与 runner 都从这里出发找 tasks/ data/ vendor/。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** OCR 模型目录：datasets.yaml 的 ocr-ppocrv6-small，pnpm datasets 拉取，不进 git */
export const OCR_MODEL_DIR = resolve(REPO_ROOT, 'vendor/ocr')

export function requirePath(path: string, what: string): string {
  if (!existsSync(path)) throw new Error(what + ' 不存在: ' + path)
  return path
}
