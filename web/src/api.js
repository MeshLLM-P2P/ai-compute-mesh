// HTTP client for the MeshLLM server.
// 地址跟随页面所在的主机(本机 127.0.0.1:5173 或局域网 192.168.2.108:5173),
// API/信令端口固定 4011 —— 这样远端节点(如 192.168.2.174)打开同一页面时
// 请求会正确打到 .108 的 server,而不是节点本机。
//
// [跨 bootstrap 调用] 联邦目录里的远程 listing 带 origin(=它的家 bootstrap)。
// 调用它时,escrow 充值/锁定/结算、信令房间、/dc 数据通道全部必须连那个
// bootstrap —— 只有那边同时有 listing store、provider agent 的信令连接和
// escrow 账本。为此提供 makeApi(base, token) 工厂与 loginRemote() 登录辅助:
// consumer 钱包不变(签名证明所有权),每个 bootstrap 独立签发 session token。
import { b64encode, utf8 } from '@mesh/shared/protocol'

const _host = (typeof location !== 'undefined' && location.hostname) || '127.0.0.1'
const _proto = (typeof location !== 'undefined' && location.protocol) || 'http:'
const BASE = _proto + '//' + _host + ':4011'

let sessionToken = null
export function setSession(token) {
  sessionToken = token
}
export function getSession() {
  return sessionToken
}

async function _api(base, token, path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-mesh-session': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = new Error(data.error || `HTTP ${res.status}`)
    e.status = res.status
    throw e
  }
  return data
}

export async function api(path, { method = 'GET', body } = {}) {
  return _api(BASE, sessionToken, path, { method, body })
}

export const SERVER = BASE
export const SIGNAL_URL = (_proto === 'https:' ? 'wss://' : 'ws://') + _host + ':4011'

// http(s) base → ws(s) base(供 SignalClient / /dc 通道使用)
export function wsUrlOf(base) {
  return String(base).replace(/^http/, 'ws')
}

// [跨 bootstrap] 为指定 bootstrap 建立一套 API 客户端。返回对象上的
// api(path, opts) 与本地 api() 同签名,但请求打到 base 且带远程 token。
export function makeApi(base, token) {
  return {
    base,
    token,
    api: (path, opts) => _api(base, token, path, opts),
  }
}

// 远程 bootstrap 的 session 缓存:nonce→verify 登录一次,后续复用 token。
// token 过期(服务端 30 分钟)时清掉重登。
const remoteSessions = new Map()
export function clearRemoteSessions() {
  remoteSessions.clear()
}

// 在指定 bootstrap 上登录(同一钱包):nonce 由远端签发,本地签名,
// 每个 bootstrap 独立 session。返回 token(缓存命中直接返回)。
export async function loginRemote(base, wallet) {
  const cached = remoteSessions.get(base)
  if (cached) return cached
  const { nonce } = await _api(base, null, '/nonce?wallet=' + encodeURIComponent(wallet.address))
  const sigB64 = b64encode(await wallet.signMessage(utf8(nonce)))
  const { session } = await _api(base, null, '/verify', {
    method: 'POST',
    body: { wallet: wallet.address, signature: sigB64 },
  })
  if (!session) throw new Error('remote-login-failed')
  remoteSessions.set(base, session)
  return session
}

// [P1 可观测] 单会话/listing 时间线(服务器视角):events + dc 统计
// client 可选:跨 bootstrap 调用时传远程 bootstrap 的 API 客户端
export async function getConversation(consumer, listingId, sessionId, client) {
  const qs = new URLSearchParams({ consumer, listingId })
  if (sessionId) qs.set('sessionId', sessionId)
  return await (client || api)('/escrows/conversation?' + qs.toString())
}

// [P1 可观测] JSON Blob 下载(调用日志导出)
export function downloadJson(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name || 'meshllm-calls.json'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
