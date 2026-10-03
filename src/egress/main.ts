import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomBytes, timingSafeEqual } from 'node:crypto'

/** 固定路由代理，不接受调用方提供上游 URL，也不支持 CONNECT 或重定向。 */
export async function serveEgress(options: {
  host: string
  port?: number
  routes: Record<string, { target: string; deadlineMs?: number }>
}) {
  const routes = new Map(
    Object.entries(options.routes).map(([path, route]) => {
      const url = new URL(route.target)
      const deadlineMs = route.deadlineMs ?? 300_000
      if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 2_147_483_647)
        throw new Error('invalid egress deadline')
      if (
        !path.startsWith('/') ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error('invalid egress route')
      return [path, { url, deadlineMs }] as const
    }),
  )
  const token = randomBytes(32).toString('hex')
  const expected = Buffer.from(token)
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const deny = (status: number): void => {
      res.writeHead(status)
      res.end()
      req.resume()
    }
    const supplied = Buffer.from(typeof req.headers['x-egress-token'] === 'string' ? req.headers['x-egress-token'] : '')
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return deny(401)
    const route = routes.get(req.url ?? '')
    if (!route) return deny(403)
    if (req.method !== 'POST') return deny(405)
    const limit = 4 * 1024 * 1024
    if (Number(req.headers['content-length']) > limit) return deny(413)
    // 未收完且验过大小的请求绝不接触上游；分块请求与定长请求使用同一上限。
    const chunks: Buffer[] = []
    let size = 0
    let rejected = false
    req.on('error', () => {
      rejected = true
      res.destroy()
    })
    req.on('data', (chunk: Buffer) => {
      if (rejected) return
      size += chunk.length
      if (size > limit) {
        rejected = true
        chunks.length = 0
        res.setHeader('Connection', 'close')
        deny(413)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (rejected || res.destroyed) return
      forward(Buffer.concat(chunks, size))
    })
    const forward = (body: Buffer): void => {
      const target = route.url
      const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
        target,
        {
          method: 'POST',
          headers: {
            'content-type': req.headers['content-type'] ?? 'application/json',
            ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
          },
        },
        (response) => {
          const status = response.statusCode ?? 502
          if (status >= 300 && status < 400) {
            response.resume()
            res.writeHead(502)
            res.end()
            return
          }
          res.writeHead(status, { 'Content-Type': response.headers['content-type'] ?? 'application/octet-stream' })
          response.pipe(res)
          response.on('error', () => res.destroy())
        },
      )
      // 固定墙钟而不是逐块重置的空闲超时；客户端断开也回收上游。
      const timer = setTimeout(() => upstream.destroy(new Error('deadline')), route.deadlineMs)
      res.on('close', () => {
        clearTimeout(timer)
        upstream.destroy()
      })
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
      upstream.end(body)
    }
  })
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // port 缺省 0（动态）；netns 拓扑要按已知端口放行防火墙，部署方固定它
    server.listen(options.port ?? 0, options.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing egress address')
  return {
    url: `http://${address.address.includes(':') ? '[' + address.address + ']' : address.address}:${address.port}`,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        server.closeAllConnections()
      }),
  }
}
