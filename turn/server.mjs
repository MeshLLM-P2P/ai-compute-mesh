// MeshLLM 联调用的 TURN 服务。
//
// 为什么不用 coturn:108 上没有 Docker、WSL 被安全策略拦截、Hyper-V 关闭,
// coturn 没有官方 Windows 构建 —— 真 coturn 装不上。turn-server 是纯 JS 的
// STUN/TURN 服务端(RFC 8489/8656),npm 装完即用,协议层与 coturn 等价,
// 浏览器侧无差别。
//
// 与 MeshLLM 的关系:TURN 只中继 ICE/DTLS 报文,E2EE 在通道内完成,
// 中继方看到的始终是密文 —— 加了 TURN 不等于放弃端到端加密。
//
// 全部用环境变量驱动,便于脚本/联调临时改参数:
//   MESH_TURN_PORT           监听端口(UDP+TCP 同端口),默认 3478
//   MESH_TURN_REALM          认证域,默认 meshllm
//   MESH_TURN_USERNAME       静态用户名,默认 meshllm
//   MESH_TURN_CREDENTIAL     静态密码,默认 meshllm-devnet
//   MESH_TURN_EXTERNAL_IP    公网 IP(NAT 后必填,否则下发的中继地址是内网地址)
//   MESH_TURN_RELAY_MIN/MAX  中继端口范围,默认 49160-49200
//   MESH_TURN_ALLOW_PRIVATE  允许中继到私网 peer,默认 1(局域网联调必须开)
//   MESH_TURN_ALLOW_LOOPBACK 允许中继到回环 peer,默认 0(防 CVE-2020-26262)
//   MESH_TURN_ALLOW_TCP_RELAY RFC 6062 TCP 中继,默认 0
//   MESH_TURN_MAX_CONN       最大连接数,默认 2000
//   MESH_TURN_IDLE_MS        空闲连接回收时间,默认 120000
import { createServer } from 'turn-server'

const env = process.env
const num = (k, d) => {
  const v = Number(env[k])
  return Number.isFinite(v) && v > 0 ? v : d
}
const bool = (k, d) => {
  const v = env[k]
  if (v === undefined || v === '') return d
  return /^(1|true|yes|on)$/i.test(v)
}

const PORT = num('MESH_TURN_PORT', 3478)
const REALM = env.MESH_TURN_REALM || 'meshllm'
const USERNAME = env.MESH_TURN_USERNAME || 'meshllm'
const CREDENTIAL = env.MESH_TURN_CREDENTIAL || 'meshllm-devnet'
const EXTERNAL_IP = env.MESH_TURN_EXTERNAL_IP || ''
const RELAY_MIN = num('MESH_TURN_RELAY_MIN', 49160)
const RELAY_MAX = num('MESH_TURN_RELAY_MAX', 49200)
const ALLOW_PRIVATE = bool('MESH_TURN_ALLOW_PRIVATE', true)
const ALLOW_LOOPBACK = bool('MESH_TURN_ALLOW_LOOPBACK', false)
const ALLOW_TCP_RELAY = bool('MESH_TURN_ALLOW_TCP_RELAY', false)
const MAX_CONN = num('MESH_TURN_MAX_CONN', 2000)
const IDLE_MS = num('MESH_TURN_IDLE_MS', 120000)

const stamp = () => new Date().toISOString().slice(11, 23)
const log = (...a) => console.log('[' + stamp() + ']', ...a)

const relay = { ip: '0.0.0.0', portRange: [RELAY_MIN, RELAY_MAX] }
if (EXTERNAL_IP) relay.externalIp = EXTERNAL_IP

const server = createServer({
  software: 'MeshLLM-TURN/0.1',
  auth: { mechanism: 'long-term', realm: REALM, credentials: { [USERNAME]: CREDENTIAL } },
  relay,
  allowPrivatePeers: ALLOW_PRIVATE,
  allowLoopback: ALLOW_LOOPBACK,
  allowTcpRelay: ALLOW_TCP_RELAY,
  maxConnections: MAX_CONN,
  idleTimeout: IDLE_MS,
})

log('TURN 配置: realm=' + REALM + ' user=' + USERNAME + ' 中继端口=' + RELAY_MIN + '-' + RELAY_MAX +
  ' 私网peer=' + (ALLOW_PRIVATE ? '允许' : '拒绝') + ' 回环peer=' + (ALLOW_LOOPBACK ? '允许' : '拒绝') +
  (EXTERNAL_IP ? ' 公网IP=' + EXTERNAL_IP : ' 公网IP=(未配置,下发内网地址)'))

const endpoints = []
server.on('listening', (info) => {
  endpoints.push(info.transport + ' ' + info.address + ':' + info.port)
  log('监听 ' + info.transport.toUpperCase() + ' ' + info.address + ':' + info.port)
})

server.on('allocate', (sock, alloc) => {
  const ra = (alloc && alloc.relayAddress) || {}
  log('分配中继 ' + (ra.ip || '?') + ':' + (ra.port || '?') +
    ' 用户=' + ((alloc && alloc.username) || '?') +
    ' 存活=' + ((alloc && alloc.lifetime) || '?') + 's')
})

server.on('allocate:expired', () => log('中继分配过期回收'))

server.on('peer:blocked', (info) => {
  const p = (info && (info.peer || info)) || {}
  log('已拦截 peer ' + (p.ip || '?') + ':' + (p.port || '?') + ' 原因=' + ((info && info.reason) || '策略'))
})

server.on('auth:failure', (info) => {
  log('鉴权失败 ' + JSON.stringify(info && info.username ? { user: info.username } : info || {}))
})

server.on('error', (err) => {
  log('错误 ' + (err && err.transport ? err.transport + ':' + err.port + ' ' : '') + (err && err.message ? err.message : err))
})

// 周期性输出统计:联调时用来判断"到底有没有流量真的走中继"
let lastRelayed = 0
const statsTimer = setInterval(() => {
  let stats = null
  try {
    stats = typeof server.getStats === 'function' ? server.getStats() : null
  } catch {
    stats = null
  }
  if (!stats) return
  const relayed = stats.packetsRelayed || 0
  if (relayed !== lastRelayed || stats.activeAllocations > 0) {
    log('统计 连接=' + (stats.activeConnections || 0) + ' 中继分配=' + (stats.activeAllocations || 0) +
      ' 累计包=' + relayed + ' 累计字节=' + (stats.bytesRelayed || 0))
    lastRelayed = relayed
  }
}, 15000)
statsTimer.unref?.()

server.listen({ port: PORT })

let closing = false
const shutdown = (sig) => {
  if (closing) return
  closing = true
  log('收到 ' + sig + ',开始关闭 TURN')
  clearInterval(statsTimer)
  try {
    if (typeof server.drain === 'function') {
      server.drain(3000, () => process.exit(0))
      setTimeout(() => process.exit(0), 4000).unref()
      return
    }
    server.close?.()
  } catch (e) {
    log('关闭异常 ' + e.message)
  }
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
