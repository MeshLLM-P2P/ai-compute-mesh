import { defineConfig } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// 与 server 共用同一张自签证书(web 页面与 API/信令同源信任,避免混合内容)
const tlsKey = path.join(here, '../server/tls/key.pem')
const tlsCert = path.join(here, '../server/tls/cert.pem')
const hasTls = fs.existsSync(tlsKey) && fs.existsSync(tlsCert)

// devnet:局域网节点(如 192.168.2.174)也要能打开应用页面,所以 Vite 绑定所有网卡。
// HTTPS 是浏览器安全上下文的硬性要求(crypto.subtle 依赖),自签证书首访需手动信任一次。
export default defineConfig({
  server: {
    host: '0.0.0.0',
    ...(hasTls
      ? { https: { key: fs.readFileSync(tlsKey), cert: fs.readFileSync(tlsCert) } }
      : {}),
  },
})
