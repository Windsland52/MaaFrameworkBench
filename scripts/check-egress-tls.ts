import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { serveEgress } from '../src/egress/main.ts'

// 证书由调用方临时生成；信任通过 Node 的 NODE_EXTRA_CA_CERTS 在进程启动时设置。
const [keyFile, certFile, mode] = process.argv.slice(2)
if (!keyFile || !certFile || !['trusted', 'untrusted'].includes(mode ?? ''))
  throw new Error('用法: node scripts/check-egress-tls.ts <key.pem> <cert.pem> <trusted|untrusted>')
let calls = 0
const upstream = createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (req, res) => {
  calls += 1
  req.resume()
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write('data: first\n\n')
  setTimeout(() => res.end('data: last\n\n'), 50)
})
await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const address = upstream.address()
assert(address && typeof address !== 'string')
const proxy = await serveEgress({
  host: '127.0.0.1',
  routes: { '/model': { target: `https://127.0.0.1:${address.port}/model` } },
})
try {
  const response = await fetch(proxy.url + '/model', {
    method: 'POST',
    headers: { 'x-egress-token': proxy.token },
    body: '{}',
  })
  if (mode === 'trusted') {
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
    assert.equal(await response.text(), 'data: first\n\ndata: last\n\n')
    assert.equal(calls, 1)
  } else {
    assert.equal(response.status, 502)
    assert.equal(calls, 0)
    await response.arrayBuffer()
  }
  console.log('HTTPS 出站代理验收通过: ' + mode)
} finally {
  await proxy.close()
  await new Promise<void>((resolve) => {
    upstream.close(() => resolve())
    upstream.closeAllConnections()
  })
}
