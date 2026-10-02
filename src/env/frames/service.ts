import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { createActor } from './actor.ts'
import type { FramesScreen } from './screen.ts'

/** 一台服务对应一次会话；状态与操作证据只交给宿主调用方。 */
export async function serveFrames(screens: FramesScreen[], options: { host?: string; shotsDir?: string } = {}) {
  const frames = createActor(screens, options.shotsDir)
  const token = randomBytes(32).toString('hex')
  const authorization = Buffer.from('Bearer ' + token)
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const json = (status: number, value: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    const provided = Buffer.from(req.headers.authorization ?? '')
    if (provided.length !== authorization.length || !timingSafeEqual(provided, authorization)) {
      json(401, { error: 'unauthorized' })
      req.resume()
      return
    }
    if (req.method !== 'POST') {
      json(405, { error: 'method not allowed' })
      req.resume()
      return
    }
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 4096) {
          json(413, { error: 'body too large' })
          return
        }
        chunks.push(Buffer.from(chunk))
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!Array.isArray(body)) {
        json(400, { error: 'expected argument array' })
        return
      }
      const numeric = (count: number): boolean =>
        body.length === count && body.every((n) => typeof n === 'number' && Number.isSafeInteger(n))
      switch (req.url) {
        case '/v1/screencap': {
          if (body.length !== 0) break
          const bytes = await frames.actor.screencap!()
          if (!bytes) throw new Error('screencap failed')
          res.writeHead(200, { 'Content-Type': 'image/png' })
          res.end(Buffer.from(bytes))
          return
        }
        case '/v1/click':
          if (!numeric(2)) break
          json(200, await frames.actor.click!(body[0], body[1]))
          return
        case '/v1/swipe':
          if (!numeric(5) || body[4] < 0) break
          json(200, await frames.actor.swipe!(body[0], body[1], body[2], body[3], body[4]))
          return
        case '/v1/shell':
          if (body.length !== 2 || typeof body[0] !== 'string' || !Number.isSafeInteger(body[1]) || body[1] < 0) break
          json(200, await frames.actor.shell!(body[0], body[1]))
          return
        default:
          json(404, { error: 'not found' })
          return
      }
      json(400, { error: 'invalid arguments' })
    } catch {
      // 错误响应不带宿主路径、内部屏名或异常堆栈。
      if (!res.headersSent) json(400, { error: 'request failed' })
      else res.end()
    }
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing listen address')
  const host = address.address.includes(':') ? '[' + address.address + ']' : address.address
  return {
    url: `http://${host}:${address.port}`,
    token,
    frames,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        server.closeAllConnections()
      }),
  }
}
