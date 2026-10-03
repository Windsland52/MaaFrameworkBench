// netns 验收用固定路由代理：挂 veth 宿主端 IP（与 netns-session.sh 的 HOST_IP 一致），
// url + token 写到 argv[2] 指定的文件后常驻
import { writeFileSync } from 'node:fs'
import { serveEgress } from './egress/main.ts'

const target = 'http://127.0.0.1:8788/v1/chat/completions'
const proxy = await serveEgress({
  host: '10.212.61.1',
  port: 8787,
  routes: { '/v1/chat/completions': { target }, '/chat/completions': { target } },
})
writeFileSync(process.argv[2], JSON.stringify({ url: proxy.url, token: proxy.token }))
setInterval(() => {}, 60000)
