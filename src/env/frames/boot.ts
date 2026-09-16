import { maafw } from '../../maa.ts'
import { createActor, type FramesActor } from './actor.ts'
import type { FramesScreen } from './screen.ts'

export interface FramesEnvOptions {
  /** MaaFW 资源包目录（含 pipeline/）. **不含 model/** —— OCR 模型用 post_ocr_model 单独指定 */
  bundle: string
  /** 画面序列，第一屏是初始画面 */
  screens: FramesScreen[]
  /** ppocr 模型目录，由 datasets.yaml 拉取 */
  ocrModelDir: string
  /** MaaFW 自己的日志（含 all_results_ / filtered_results_）落在这里 */
  logDir: string
}

export interface FramesEnv {
  res: maa.Resource
  ctrl: maa.Controller
  tasker: maa.Tasker
  actor: FramesActor
  ok: boolean
  teardown: () => void
}

/**
 * 起一个 frames 环境：Resource + CustomController + Tasker，加载完毕可直接 post_task。
 *
 * 这套调用顺序是阶段 0 试出来的：
 *   1. post_bundle 加载资源包
 *   2. post_ocr_model 单独指定 OCR 模型（与资源包解耦）
 *   3. post_connection 连接控制器
 *   4. tasker.resource / tasker.controller 绑定
 * 顺序反了或漏了，症状都是"任务跑不起来"，很难定位。
 */
export async function bootFramesEnv(opts: FramesEnvOptions): Promise<FramesEnv> {
  maafw.Global.log_dir = opts.logDir
  maafw.Global.stdout_level = 'Off'

  const frames = createActor(opts.screens)
  const res = new maafw.Resource()
  const ctrl = new maafw.CustomController(frames.actor)
  const tasker = new maafw.Tasker()

  const loadJob = res.post_bundle(opts.bundle)
  await loadJob.wait()
  const ocrJob = res.post_ocr_model(opts.ocrModelDir)
  await ocrJob.wait()
  const connJob = ctrl.post_connection()
  await connJob.wait()

  tasker.resource = res
  tasker.controller = ctrl

  return {
    res,
    ctrl,
    tasker,
    actor: frames,
    ok: loadJob.succeeded && ocrJob.succeeded && connJob.succeeded,
    teardown: () => {
      ctrl.destroy()
      res.destroy()
      tasker.destroy()
    },
  }
}
