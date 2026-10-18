// [跨 bootstrap 代理] 浏览器不直连远程 bootstrap,改由本机 bootstrap 转发。
//
// 为什么需要:consumer 调用"别人家的"模型时,原先让浏览器直接连
// https://<远端>:4011 —— 这要连过三道浏览器特有的墙:
//   ① 对方自签证书未被本浏览器信任(fetch 直接 TypeError: Failed to fetch)
//   ② 系统代理拦截局域网 IP
//   ③ 联邦上游误配 http:// 时的混合内容拦截
// 而本机 server 拉取联邦时用 rejectUnauthorized:false,以上全都不存在。
//
// 做法:把 "consumer → 远程 bootstrap" 的 HTTP 与 WS(/signal、/dc)全部改成
//   consumer → 本机 /xboot/<host:port>/... → 远程
// 浏览器只与本机通信(页面就是用同一张证书加载的,信任必然成立),
// 于是任意节点互调都不再需要用户手动信任对方证书 —— 这是无许可网络该有的样子。
//
// 安全性:与 /dc 中继同一信任模型 —— 代理只搬运字节,E2EE 密钥协商与密文帧
// 都在通道内完成,代理(乃至任何中转方)看不到提示词。
//
// 路径约定(浏览器无法给 WS 带自定义头,所以协议用路径表达):
//   /xboot/<host:port>/<path>        → https://<host:port>/<path>
//   /xboot/http/<host:port>/<path>   → http://<host:port>/<path>(本地测试实例)
import http from 'node:http'
import https from 'node:https'
import { WebSocketServer, WebSocket } from 'ws'

// 逐跳头 + 由 Node 自己重算的头,不转发
const HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
])

const PREFIX = '/xboot/'

// 解析 "/xboot/[http/]<host:port>/<tail?query>" → { scheme, hostPort, tail }
export function parseXbootPath(url) {
  if (!url || !url.startsWith(PREFIX)) return null
  let rest = url.slice(PREFIX.length)
  let scheme = 'https'
  if (rest.startsWith('http/')) {
    scheme = 'http'
    rest = rest.slice('http/'.length)
  }
  const i = rest.indexOf('/')
  const hostPort = i === -1 ? rest.split('?')[0] : rest.slice(0, i)
  const tail = i === -1 ? '/' + (rest.slice(hostPort.length) || '') : rest.slice(i)
  if (!hostPort) return null
  return { scheme, hostPort, tail: tail || '/' }
}

function splitHostPort(hostPort) {
  const i = hostPort.lastIndexOf(':')
  if (i === -1) return { host: hostPort, port: 443 }
  return { host: hostPort.slice(0, i), port: Number(hostPort.slice(i + 1)) || 443 }
}

function filterHeaders(src) {
  const out = {}
  for (const [k, v] of Object.entries(src || {})) {
    const lk = k.toLowerCase()
    if (HOP.has(lk)) continue
    // CORS 由本机 cors() 统一给出,不复制上游的(避免重复/冲突)
    if (lk.startsWith('access-control-')) continue
    out[k] = v
  }
  return out
}

// 挂 HTTP 转发路由(Express app)。必须放在 cors() 之后、鉴权路由之前。
export function attachXbootHttp(app) {
  app.all('/xboot/:host/*', (req, res) => {
    const target = parseXbootPath(req.originalUrl)
    if (!target) {
      res.status(400).json({ error: 'xboot-bad-path' })
      return
    }
    forwardHttp(req, res, target)
  })
  // 精确匹配无尾路径(如 /xboot/1.2.3.4:4011)
  app.all('/xboot/:host', (req, res) => {
    const target = parseXbootPath(req.originalUrl)
    if (!target) {
      res.status(400).json({ error: 'xboot-bad-path' })
      return
    }
    forwardHttp(req, res, target)
  })
}

// 协议不匹配的特征错误:明文打 TLS 端口(EPROTO/wrong version number),
// 或 TLS 打明文端口(连接被重置)。命中时换一种 scheme 重试一次。
const PROTO_ERR = /EPROTO|WRONG_VERSION|ECONNRESET|EPIPE/

function forwardHttp(req, res, target) {
  const { hostPort, tail } = target
  const { host, port } = splitHostPort(hostPort)
  const method = req.method
  // 只有无 body 的方法能安全重试(GET/HEAD);POST 的流已被消费,重试会发空体
  const canRetry = method === 'GET' || method === 'HEAD'
  let retried = false
  let finished = false

  const attempt = (scheme) => {
    const mod = scheme === 'http' ? http : https
    console.log('[xboot] ' + method + ' ' + scheme + '://' + hostPort + tail.slice(0, 90))
    const upstream = mod.request(
      {
        host,
        port,
        path: tail,
        method,
        headers: { ...filterHeaders(req.headers), host: hostPort },
        rejectUnauthorized: false, // devnet 自签证书:信任模型由 E2EE 承担,不是 TLS 层
      },
      (up) => {
        finished = true
        res.writeHead(up.statusCode || 502, filterHeaders(up.headers))
        up.pipe(res)
      }
    )
    upstream.setTimeout(30000, () => upstream.destroy(new Error('xboot-timeout')))
    upstream.on('error', (e) => {
      if (finished) return
      const code = e.code || ''
      // 联邦 origin 可能被配成 http:// 而对方其实是 TLS:自动换 scheme 重试,
      // 否则用户只会看到一句无从下手的 xboot-unreachable。
      if (!retried && canRetry && PROTO_ERR.test(code + ' ' + (e.message || ''))) {
        retried = true
        attempt(scheme === 'http' ? 'https' : 'http')
        return
      }
      finished = true
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' })
      // target/detail 会原样带到前端日志,便于一眼定位(连不上 / 协议不符 / 超时)
      res.end(
        JSON.stringify({
          error: 'xboot-unreachable',
          target: scheme + '://' + hostPort,
          detail: code || e.message,
        })
      )
    })
    if (canRetry) upstream.end()
    else req.pipe(upstream)
  }
  attempt(target.scheme)
}

// WS 转发:由 index.js 的唯一 upgrade 分发器在命中 /xboot/ 时调用
const proxyWss = new WebSocketServer({ noServer: true })

export function xbootUpgrade(req, socket, head) {
  proxyWss.handleUpgrade(req, socket, head, (ws) => proxyWss.emit('connection', ws, req))
}

proxyWss.on('connection', (ws, req) => {
  const target = parseXbootPath(req.url)
  if (!target) {
    ws.close(1008, 'xboot-bad-path')
    return
  }
  const remoteUrl = `${target.scheme === 'http' ? 'ws' : 'wss'}://${target.hostPort}${target.tail}`
  const upstream = new WebSocket(remoteUrl, { rejectUnauthorized: false })
  // 本地先到的帧排队,等上游 open 再发(浏览器侧可能一上来就 join)
  const queue = []
  upstream.on('open', () => {
    for (const [data, binary] of queue) {
      try {
        upstream.send(data, { binary })
      } catch {}
    }
    queue.length = 0
  })
  ws.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      try {
        upstream.send(data, { binary: isBinary })
      } catch {}
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      queue.push([data, isBinary])
    }
  })
  upstream.on('message', (data, isBinary) => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(data, { binary: isBinary })
      } catch {}
    }
  })
  const closeBoth = () => {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.close()
    } catch {}
    try {
      upstream.close()
    } catch {}
  }
  ws.on('close', closeBoth)
  ws.on('error', closeBoth)
  upstream.on('close', closeBoth)
  upstream.on('error', closeBoth)
})

export const XBOOT_PREFIX = PREFIX
