// 模型健康探测:GET {backendBase}/models(Bearer key 可选)。
// 2xx/404/405 视为健康(模型没挂只是没实现 /models 端点);5xx 或网络错误视为不健康。
// echo 后端没有真实服务,恒为健康;mock 后端探平台服务器自己的 /mock-llm。
// 注意:custom 后端若是自签 https,devnet 环境下探测会判不健康(限制,见 README)。
import { getStatus } from './http.js'
import { anthropicHeaders } from '@mesh/shared/channel'

function baseOf(listing) {
  // 后端 URL 可能是 .../v1 或 .../v1/chat/completions,归一到 /models 的根
  const t = String((listing.backend && listing.backend.url) || '').trim()
  if (!t) return null
  const m = t.match(/^(https?:\/\/[^/]+(?::\d+)?)(\/v\d+)?/i)
  if (!m) return null
  return m[1] + (m[2] || '')
}

// node:https 的 `ca` 选项会替换(而非追加)系统信任库,
// 因此自签 CA 只能用于指向平台 server 自身 host 的探测;
// 公网后端必须走系统信任库(不传 ca)。
function caFor(url, base, ca) {
  try {
    return new URL(url).host === new URL(base).host ? ca : null
  } catch {
    return null
  }
}

export async function probeModel(listing, { apiKey, base, ca, rejectUnauthorized }) {
  const kind = (listing.backend && listing.backend.type) || 'echo'
  if (kind === 'echo') return true
  if (kind === 'mock') {
    try {
      const url = base + '/mock-llm/v1/models'
      const status = await getStatus(url, { ca: caFor(url, base, ca), rejectUnauthorized })
      return status === 200 || status === 404 || status === 405
    } catch {
      return false
    }
  }
  const root = baseOf(listing)
  if (!root) return false
  try {
    // Anthropic 的 /v1/models 同样要 x-api-key + anthropic-version,
    // 用 Bearer 会 401 → 被判不健康 → agent 永远不上线
    const headers =
      kind === 'anthropic'
        ? anthropicHeaders(apiKey)
        : apiKey
          ? { Authorization: 'Bearer ' + apiKey }
          : {}
    const url = root + '/models'
    const status = await getStatus(url, { headers, ca: caFor(url, base, ca), rejectUnauthorized })
    return status === 200 || status === 404 || status === 405
  } catch {
    return false
  }
}
