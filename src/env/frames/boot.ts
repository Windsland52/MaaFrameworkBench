import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { maafw } from '../../maa.ts'
import { createActor } from './actor.ts'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** OCR 模型目录：datasets.yaml 的 ocr-ppocrv6-small，npm run fetch 拉取，不进 git */
export const OCR_MODEL_DIR = resolve(ROOT, 'vendor/ocr')

export interface FramesEnvOptions {
  /** MaaFW 资源包目录。**不含 model/** —— OCR 模型用 post_ocr_model 单独指定 */
  bundle: string
  /** 这个环境喂什么画面（screencap 的返回值） */
  framePath: string
  ocrModelDir?: string
}

/**
 * 起一个 frames 环境：Resource + CustomController + Tasker，加载完毕可直接 post_task。
 *
 * 这套调用顺序是阶段 0 试出来的（见 docs/interfaces.md 实施事实）：
 *   1. post_bundle 加载资源包
 *   2. post_ocr_model 单独指定 OCR 模型（与资源包解耦）
 *   3. post_connection 连接控制器
 *   4. tasker.resource / tasker.controller 绑定
 * 顺序反了或漏了，症状都是"任务跑不起来"，很难定位。
 */
export async function bootFramesEnv(opts: FramesEnvOptions) {
  const res = new maafw.Resource()
  const ctrl = new maafw.CustomController(createActor(opts.framePath))
  const tasker = new maafw.Tasker()

  const loadJob = res.post_bundle(opts.bundle)
  await loadJob.wait()
  const ocrJob = res.post_ocr_model(opts.ocrModelDir ?? OCR_MODEL_DIR)
  await ocrJob.wait()
  const connJob = ctrl.post_connection()
  await connJob.wait()

  tasker.resource = res
  tasker.controller = ctrl

  return {
    res,
    ctrl,
    tasker,
    ok: loadJob.succeeded && ocrJob.succeeded && connJob.succeeded,
    teardown: () => {
      ctrl.destroy()
      res.destroy()
      tasker.destroy()
    },
  }
}
