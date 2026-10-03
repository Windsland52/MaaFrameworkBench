import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { serveEgress } from '../src/egress/main.ts'

let calls = 0
let auth: string | undefined
let proxyToken: string | undefined
const upstream = createServer((req, res) => {
  calls += 1
  auth = req.headers.authorization
  proxyToken = req.headers['x-egress-token'] as string | undefined
  req.resume()
  if (req.url === '/slow') return
  if (req.url === '/redirect') res.writeHead(302, { Location: 'http://127.0.0.1:1/forbidden' })
  else res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end('{"ok":true}')
})
await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const address = upstream.address()
assert(address && typeof address !== 'string')
const target = 'http://127.0.0.1:' + address.port
const proxy = await serveEgress({
  host: '127.0.0.1',
  routes: {
    '/model': { target: target + '/allowed' },
    '/redirect': { target: target + '/redirect' },
    '/slow': { target: target + '/slow', deadlineMs: 100 },
  },
})
try {
  const call = (path: string, token = proxy.token, method = 'POST') =>
    fetch(proxy.url + path, {
      method,
      headers: { 'x-egress-token': token, Authorization: 'Bearer synthetic-test-key' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    })
  assert.equal((await call('/model', 'wrong')).status, 401)
  assert.equal((await call('/other')).status, 403)
  assert.equal((await call('/model?url=https://example.com')).status, 403)
  assert.equal((await call('/model', proxy.token, 'GET')).status, 405)
  assert.equal(calls, 0)
  assert.deepEqual(await (await call('/model')).json(), { ok: true })
  assert.equal(auth, 'Bearer synthetic-test-key')
  assert.equal(proxyToken, undefined)
  assert.equal((await call('/redirect')).status, 502)
  await new Promise<void>((resolve, reject) => {
    const req = request(proxy.url, { method: 'CONNECT', path: 'example.com:443' })
    req.on('connect', (res, socket) => {
      socket.destroy()
      try {
        assert.equal(res.statusCode, 403)
        resolve()
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(calls, 2)
  const oversized = Buffer.alloc(5 * 1024 * 1024)
  assert.equal(
    (
      await fetch(proxy.url + '/model', {
        method: 'POST',
        headers: { 'x-egress-token': proxy.token },
        body: oversized,
      })
    ).status,
    413,
  )
  assert.equal(calls, 2, '定长超限请求不得触达上游')
  await new Promise<void>((resolve, reject) => {
    const req = request(
      proxy.url + '/model',
      {
        method: 'POST',
        headers: { 'x-egress-token': proxy.token, 'Transfer-Encoding': 'chunked' },
      },
      (res) => {
        res.resume()
        res.on('end', () => {
          try {
            assert.equal(res.statusCode, 413)
            resolve()
          } catch (err) {
            reject(err)
          }
        })
      },
    )
    req.on('error', reject)
    req.end(oversized)
  })
  assert.equal(calls, 2, '分块超限请求不得触达上游')
  assert.equal(
    (
      await fetch(proxy.url + '/model', {
        method: 'POST',
        headers: { 'x-egress-token': proxy.token },
        body: Buffer.alloc(4 * 1024 * 1024),
      })
    ).status,
    200,
  )
  assert.equal((await call('/slow')).status, 502)
  assert.deepEqual(await (await call('/model')).json(), { ok: true })
  console.log('出站代理测试通过：固定路由、认证、方法限制、拒绝重定向与 CONNECT、合成 key 转发且不转发代理令牌')
} finally {
  await proxy.close()
  await new Promise<void>((resolve) => {
    upstream.close(() => resolve())
    upstream.closeAllConnections()
  })
}
