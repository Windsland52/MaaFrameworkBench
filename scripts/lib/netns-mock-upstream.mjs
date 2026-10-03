// netns 验收用模拟模型上游：OpenAI 兼容 SSE；每个到达的请求记一行 NDJSON（事实，断言在驱动侧做）
import { createServer } from 'node:http'

createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    process.stdout.write(
      JSON.stringify({
        url: req.url,
        auth: req.headers.authorization ?? null,
        tok: req.headers['x-egress-token'] ?? null,
      }) + '\n',
    )
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunks = [
      'data: {"id":"m1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"id":"m1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"链路已通"},"finish_reason":null}]}\n\n',
      'data: {"id":"m1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]
    let i = 0
    const tick = () => {
      if (i < chunks.length) {
        res.write(chunks[i++])
        setTimeout(tick, 20)
      } else res.end()
    }
    tick()
  })
}).listen(8788, '127.0.0.1')
