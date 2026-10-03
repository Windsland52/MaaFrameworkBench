import { spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { serveFrames } from '../src/env/frames/service.ts'
import { sourcePath } from '../src/runner/main.ts'
import { loadTask } from '../src/runner/task.ts'
import { REPO_ROOT } from '../src/runner/root.ts'

/**
 * 自测入口的独立分发验收：把入口与必要依赖复制到独立临时目录，从那里完成一次
 * 真实自测（真设备、真 OCR、真识别），确认不依赖 Bench 仓库里的文件。
 *
 * 分发件 = 三份源文件（entry.ts / remote.ts / maa.ts）。这证明的是**源码侧**可离仓
 * 运行：多 import 任何一个未复制的仓库文件，在 dist 里就是 module not found，当场红。
 * npm 侧是完整 node_modules 的 junction 模拟，不构成「npm 依赖只需 maa-node」的证明 ——
 * 最小依赖闭包由镜像验收另行证（只安装声明的运行依赖）。
 */

const failures: string[] = []
const check = (ok: boolean, name: string, detail = ''): void => {
  if (!ok) failures.push(name)
  console.log((ok ? 'OK  ' : 'FAIL') + ' | ' + name + (detail === '' ? '' : ' | ' + detail))
}

function run(
  script: string,
  scriptArgs: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...scriptArgs], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
    const timer = setTimeout(() => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      killer.on('error', () => {})
      child.kill('SIGKILL')
    }, 120_000)
    child.on('error', (err) => {
      clearTimeout(timer)
      done({ code: null, stdout, stderr: stderr + String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code, stdout, stderr })
    })
  })
}

/* ---------- 分发目录：三份源文件 + junction 模拟镜像运行时 ---------- */

const dist = mkdtempSync(join(tmpdir(), 'maafwbench-dist-'))
const { task } = loadTask(REPO_ROOT, 't001-enter-inventory')
const screens = task.env.screens.map((s) => ({ ...s, path: sourcePath(REPO_ROOT, task, s.path) }))
const projects: string[] = []
try {
  mkdirSync(join(dist, 'selftest'), { recursive: true })
  mkdirSync(join(dist, 'env', 'frames'), { recursive: true })
  cpSync(resolve(REPO_ROOT, 'src/selftest/entry.ts'), join(dist, 'selftest', 'entry.ts'))
  cpSync(resolve(REPO_ROOT, 'src/env/frames/remote.ts'), join(dist, 'env', 'frames', 'remote.ts'))
  cpSync(resolve(REPO_ROOT, 'src/maa.ts'), join(dist, 'maa.ts'))
  // junction 不需要管理员权限；rmSync 前显式摘掉，不碰仓库真实目录
  symlinkSync(resolve(REPO_ROOT, 'node_modules'), join(dist, 'node_modules'), 'junction')
  symlinkSync(resolve(REPO_ROOT, 'vendor/ocr'), join(dist, 'ocr'), 'junction')

  const entry = join(dist, 'selftest', 'entry.ts')

  /** 项目目录：种子 + 指定夹具。注入短节点超时 —— 验收要的是退出码语义，不是重试耐力 */
  function makeProject(fixture: string): string {
    const p = mkdtempSync(join(tmpdir(), 'maafwbench-proj-'))
    projects.push(p)
    cpSync(resolve(REPO_ROOT, 'tasks/t001-enter-inventory/seed'), p, { recursive: true })
    mkdirSync(join(p, 'resource', 'base', 'pipeline'), { recursive: true })
    cpSync(
      resolve(REPO_ROOT, 'tasks/t001-enter-inventory/fixtures', fixture),
      join(p, 'resource', 'base', 'pipeline', 'main.json'),
    )
    writeFileSync(join(p, 'resource', 'base', 'default_pipeline.json'), JSON.stringify({ Default: { timeout: 3000 } }))
    return p
  }

  function runSelftest(
    p: string,
    url: string,
    token: string,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return run(
      entry,
      ['--project', p, '--entry', task.entry, '--device', url, '--token', token, '--ocr', join(dist, 'ocr')],
      p,
    )
  }

  /* ---------- 缺参数：用法与退出码 ---------- */

  const usage = await run(entry, [], tmpdir())
  check(usage.code === 1 && usage.stderr.includes('用法'), '缺参数：报用法、退出码 1', 'code=' + usage.code)

  // 缺省 OCR 配置：--ocr 与 MAAFW_OCR_DIR 都没有 → 参数错误（显式清掉变量，
  // 本机恰好设过也不能让这条变成假绿/假红）
  {
    const p = makeProject('correct.json')
    const noOcrEnv: NodeJS.ProcessEnv = { ...process.env }
    delete noOcrEnv.MAAFW_OCR_DIR
    const missing = await run(
      entry,
      ['--project', p, '--entry', task.entry, '--device', 'http://127.0.0.1:1', '--token', 'x'],
      p,
      noOcrEnv,
    )
    check(
      missing.code === 1 && missing.stderr.includes('OCR 目录没给'),
      '缺省 OCR 配置：报参数错误、退出码 1',
      'code=' + missing.code,
    )
  }

  /* ---------- 健康路径：从 dist 跑，cwd 是项目目录 ---------- */

  const project = makeProject('correct.json')
  const svc = await serveFrames(screens)
  try {
    const r = await runSelftest(project, svc.url, svc.token)
    check(
      r.code === 0,
      '独立分发目录里完成一次真实自测',
      '退出码=' + r.code + (r.stderr.trim() === '' ? '' : ' stderr=' + r.stderr.trim().slice(0, 120)),
    )
    check(r.stdout.includes('状态: succeeded'), '报告执行状态', '')
    check(r.stdout.includes('"STOCK"') && r.stdout.includes('"12"'), '识别轨迹带文本', '')
    check(
      !r.stdout.includes('inventory-zero') && !r.stdout.includes('MaaFrameworkBench') && !r.stdout.includes(REPO_ROOT),
      '输出不含环境内部状态与仓库路径',
      '',
    )
    const shotsDir = join(project, '.self-test', 'shots')
    const shotFiles = existsSync(shotsDir) ? readdirSync(shotsDir).sort() : []
    check(shotFiles.length > 0, '调试截图落在 <project>/.self-test/', shotFiles.length + ' 张')
    if (shotFiles.length > 0) {
      const homePng = readFileSync(resolve(REPO_ROOT, 'data/maafw-demo-frames/home.png'))
      check(
        readFileSync(join(shotsDir, shotFiles[0]!)).equals(homePng),
        '首张截图与设备交出的首屏逐字节一致',
        shotFiles[0],
      )
    }
    // 环境证据在宿主侧对账：自测确实把设备点过去了（入口进程看不到这些）
    check(svc.frames.screen() === 'inventory', '设备最终屏 = inventory（自测真驱动了设备）', svc.frames.screen())
    check(
      svc.frames.ops().some((op) => op.moved),
      '有一次输入真的把画面带过去',
      '',
    )
  } finally {
    await svc.close()
  }

  /* ---------- 退出码语义：业务失败 ≠ 链路故障 ---------- */

  // 错误业务夹具：task failed 但设备全程通信正常 → 必须仍是退出码 0
  {
    const p = makeProject('wrong-answer.json')
    const svc = await serveFrames(screens)
    try {
      const r = await runSelftest(p, svc.url, svc.token)
      check(
        r.code === 0 && r.stdout.includes('状态: failed') && !r.stdout.includes('设备通信异常'),
        '错误业务夹具：task failed 且无设备通信异常 → 退出码 0',
        'code=' + r.code,
      )
    } finally {
      await svc.close()
    }
  }

  // 错 token：基础设施故障不得伪装成"链路健康、只是没做成"
  {
    const p = makeProject('correct.json')
    const svc = await serveFrames(screens)
    try {
      const r = await runSelftest(p, svc.url, '0'.repeat(64))
      check(
        r.code === 1 && r.stdout.includes('设备通信异常') && r.stdout.includes('401'),
        '错 token：设备通信异常 → 退出码 1',
        'code=' + r.code,
      )
    } finally {
      await svc.close()
    }
  }

  // 死端口：设备中途不在了，同样要退出码 1
  {
    const p = makeProject('correct.json')
    const svc = await serveFrames(screens)
    const url = svc.url
    const token = svc.token
    await svc.close()
    const r = await runSelftest(p, url, token)
    check(
      r.code === 1 && r.stdout.includes('设备通信异常') && r.stdout.includes('fetch failed'),
      '死端口：设备通信异常 → 退出码 1',
      'code=' + r.code,
    )
  }
} finally {
  unlinkSync(join(dist, 'node_modules'))
  unlinkSync(join(dist, 'ocr'))
  rmSync(dist, { recursive: true, force: true })
  for (const p of projects) rmSync(p, { recursive: true, force: true })
}

console.log(failures.length === 0 ? '自测入口独立分发验收通过' : '自测入口独立分发验收失败：' + failures.join('；'))
process.exitCode = failures.length === 0 ? 0 : 1
