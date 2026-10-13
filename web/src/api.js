// HTTP client for the MeshLLM server.
// 地址跟随页面所在的主机(本机 127.0.0.1:5173 或局域网 192.168.2.108:5173),
// API/信令端口固定 4011 —— 这样远端节点(如 192.168.2.174)打开同一页面时
// 请求会正确打到 .108 的 server,而不是节点本机
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

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionToken ? { 'x-mesh-session': sessionToken } : {}),
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

export const SERVER = BASE
export const SIGNAL_URL = (_proto === 'https:' ? 'wss://' : 'ws://') + _host + ':4011'

// [P1 可观测] 单会话/listing 时间线(服务器视角):events + dc 统计
export async function getConversation(consumer, listingId, sessionId) {
  const qs = new URLSearchParams({ consumer, listingId })
  if (sessionId) qs.set('sessionId', sessionId)
  return await api('/escrows/conversation?' + qs.toString())
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
