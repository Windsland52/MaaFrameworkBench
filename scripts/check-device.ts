import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveFrames } from '../src/env/frames/service.ts'
import { remoteFramesActor } from '../src/env/frames/remote.ts'
import { createBitmap, encodePng } from './lib/png.ts'

const dir = mkdtempSync(join(tmpdir(), 'device-smoke-'))
const first = encodePng(createBitmap(2, 2, [255, 0, 0]))
const second = encodePng(createBitmap(2, 2, [0, 255, 0]))
writeFileSync(join(dir, 'first.png'), first)
writeFileSync(join(dir, 'second.png'), second)
const screens = [
  {
    name: 'private-first',
    path: join(dir, 'first.png'),
    transitions: [{ area: [0, 0, 1, 1] as [number, number, number, number], target: 'private-second' }],
  },
  { name: 'private-second', path: join(dir, 'second.png') },
]
const a = await serveFrames(screens, { shotsDir: join(dir, 'shots') })
let b: Awaited<ReturnType<typeof serveFrames>> | undefined
try {
  b = await serveFrames(screens)
  const actor = remoteFramesActor(a.url, a.token)
  const request = (path: string, body: string, token = a.token, method = 'POST') =>
    fetch(a.url + path, {
      method,
      headers: { Authorization: 'Bearer ' + token },
      // fetch 规范不允许 GET 带 body
      ...(method === 'GET' ? {} : { body }),
    })
  assert.equal((await request('/v1/click', '[0,0]', b.token)).status, 401)
  assert.equal(a.frames.ops().length, 0)
  assert.deepEqual(Buffer.from((await actor.screencap!())!), first)
  assert.deepEqual(Buffer.from((await actor.screencap!())!), first)
  assert.equal(await actor.click!(1, 1), true)
  assert.equal(a.frames.screen(), 'private-first')
  assert.equal((await request('/v1/click', '[0.5,0]')).status, 400)
  assert.equal((await request('/v1/click', '{}')).status, 400)
  assert.equal((await request('/v1/click', 'not json')).status, 400)
  assert.equal((await request('/v1/state', '[]')).status, 404)
  const large = await request('/v1/click', ' '.repeat(4097))
  assert.equal(large.status, 413)
  assert.equal(await actor.click!(0, 0), true)
  assert.deepEqual(Buffer.from((await actor.screencap!())!), second)
  assert.equal(b.frames.screen(), 'private-first')
  assert.equal(await actor.shell!('anything', 1000), null)
  assert.equal(await actor.swipe!(0, 0, 1, 1, 100), true)
  assert.equal(await actor.get_info!(), '{"type":"custom"}')
  assert.equal(a.frames.ops().length, 7)
  assert.equal(readdirSync(join(dir, 'shots')).length, 3)
  assert.equal(a.frames.ops().filter((op) => op.moved).length, 1)

  // —— 契约声明的其余边界 ——
  assert.equal((await request('/v1/click', '[0,0]', a.token, 'GET')).status, 405)
  assert.equal((await request('/v1/swipe', '[0,0,1,1,-1]', a.token)).status, 400)
  // 时长只做校验、不改变行为：duration=0 与任意值一样按终点坐标判定换屏
  const bActor = remoteFramesActor(b.url, b.token)
  assert.equal(await bActor.swipe!(5, 5, 0, 0, 0), true)
  assert.equal(b.frames.screen(), 'private-second')

  // 响应消毒：所有文本响应里不该出现内部屏名或宿主路径（PNG 是二进制，不在扫描之列）
  const leaks: string[] = []
  const scan = (text: string): void => {
    if (text.includes('private-') || text.includes(dir)) leaks.push(text)
  }
  for (const [path, body, token] of [
    ['/v1/click', '[0.5,0]', a.token],
    ['/v1/click', '{}', a.token],
    ['/v1/click', 'not json', a.token],
    ['/v1/state', '[]', a.token],
    ['/v1/click', ' '.repeat(4097), a.token],
    ['/v1/click', '[0,0]', b.token],
    ['/v1/swipe', '[0,0,1,1,-1]', a.token],
  ] as const) {
    scan(await (await request(path, body, token)).text())
  }
  scan((await actor.get_info!()) ?? '')
  scan((await bActor.get_info!()) ?? '')
  assert.deepEqual(leaks, [])

  console.log(
    '设备协议 smoke 通过：PNG、输入驱动换屏、独立状态、认证、非法输入、无状态查询、截图留档、405、负时长、响应消毒',
  )
} finally {
  await a.close()
  await b?.close()
  rmSync(dir, { recursive: true, force: true })
}
