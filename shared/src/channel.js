// MeshLLM 通话核心:kx 握手(钱包签名绑定)、加密帧编解码、模型后端调用、
// 流式 token 解析与用量提取。平台无关(browser / Node 通用)。
// 传输(DataChannel 或 WS)由调用方注入:KxSession 通过 sendKx 回调收发 kx 帧,
// 业务密文帧由调用方在帧文本回调里用 decodeEncrypted 解开。
import { b64encode, b64decode, utf8 as utf8of } from './protocol.js'
import {
  genEcdh,
  ecdhPubRaw,
  deriveSessionKeys,
  encryptFrame,
  decryptFrame,
  kxBindingDigest,
  ed25519Verify,
} from './e2ee.js'

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ---------- kx handshake (public frames, wallet-signed binding) ----------

export class KxSession {
  constructor({ sessionId, sign, peerIdPub, sendKx, onReady, onFail, log }) {
    this.sessionId = sessionId
    this.sign = sign
    this.peerIdPub = peerIdPub // Uint8Array of the peer's wallet pubkey
    this.pair = genEcdh()
    this.myEpk = ecdhPubRaw(this.pair)
    this.peerEpk = null
    this.mySigSent = false
    this.peerVerified = false
    this.keys = null
    this.pendingKxB = null // 对端 kx-b 早于 kx-a 到达时暂存(旧帧兼容路径)
    this.sendKx = sendKx
    this.onReady = onReady
    this.onFail = onFail
    this.log = log
    this.timer = setTimeout(() => this.fail(new Error('kx-timeout')), 25000)
    this.sendKx({ t: 'kx-a', epk: b64encode(this.myEpk) })
    // 通道刚 open 时,对端可能尚未入房间/挂 onmessage,帧可能丢失:
    // 在握手完成前每 500ms 重发 kx-a(幂等,对端重复接收无副作用)。
    // 注意:条件必须是 !keys 而不是 !peerEpk —— 对端收到我方 kx-a 后可能已
    // 停止重发其 kx-a 并直接发 kx-b,若此时我方 kx-a 尚未送达对方,
    // 仅凭 peerEpk 停发会导致双方各等各的帧而握手永不完成。
    this.resendTimer = setInterval(() => {
      if (!this.failed && !this.keys) {
        try {
          this.sendKx({ t: 'kx-a', epk: b64encode(this.myEpk) })
        } catch {}
      }
    }, 500)
  }

  fail(e) {
    clearTimeout(this.timer)
    clearInterval(this.resendTimer)
    if (this.failed) return
    this.failed = true
    this.onFail(e)
  }

  async handleKx(msg) {
    try {
      if (this.failed) return
      if (msg.t === 'kx-a') {
        const epk = b64decode(msg.epk)
        if (this.peerEpk && bytesEqual(this.peerEpk, epk)) return // 重发重复帧,忽略
        // 对端换了临时公钥(重启了握手):旧绑定签名对新的 epk 无效,
        // 必须作废旧状态并对新绑定重新签名
        this.peerEpk = epk
        this.peerVerified = false
        this.mySigSent = false
        this.keys = null
        if (this.pendingKxB) {
          const b = this.pendingKxB
          this.pendingKxB = null
          return this.handleKx(b) // 现在 kx-a 已就位,立即处理暂存的 kx-b
        }
      } else if (msg.t === 'kx-b') {
        // kx-b 携带发送方临时公钥:覆盖"对端 kx-a 在我入房间前发出而丢失"的
        // 竞态(服务端只转发给已在房间的成员),不必干等 kx-a 重发
        if (!this.peerEpk && msg.epk) this.peerEpk = b64decode(msg.epk)
        if (!this.peerEpk) {
          // 旧版帧(无 epk 字段)兜底:等对端 kx-a 重发
          this.pendingKxB = msg
          this.log && this.log('kx-b buffered (waiting for peer kx-a)')
          return
        }
        const m = await kxBindingDigest(this.myEpk, this.peerEpk, utf8of(this.sessionId))
        if (!ed25519Verify(this.peerIdPub, b64decode(msg.sig), m)) {
          throw new Error('kx-binding-verify-failed')
        }
        this.peerVerified = true
      }
      if (this.peerEpk && !this.mySigSent) {
        const m = await kxBindingDigest(this.myEpk, this.peerEpk, utf8of(this.sessionId))
        const sig = await this.sign(m)
        this.mySigSent = true
        // epk 冗余携带:接收方可能从未收到我方 kx-a
        this.sendKx({ t: 'kx-b', sig: b64encode(sig), epk: b64encode(this.myEpk) })
      }
      if (this.peerVerified && this.mySigSent && !this.keys) {
        this.keys = await deriveSessionKeys(this.pair, this.peerEpk, this.myEpk, utf8of(this.sessionId))
        clearTimeout(this.timer)
        clearInterval(this.resendTimer)
        this.onReady(this.keys)
      }
    } catch (e) {
      this.fail(e)
    }
  }
}

// ---------- shared frame helpers -----------------------------------------

// encryptFrame/decryptFrame 是 async:必须 await,否则 b64encode(Promise) 得到空串、
// TextDecoder.decode(Promise) 同步抛错 —— 曾导致提示词帧实际以空串上链、模型端收不到数据
export async function encodeEncrypted(key, frame) {
  return b64encode(await encryptFrame(key, frame))
}
// decryptFrame 内部已 JSON.parse,直接返回对象,不能再包一层 parse/decode
export async function decodeEncrypted(key, text) {
  return decryptFrame(key, b64decode(text))
}

export function callParams(listing) {
  return {
    model: listing.model.name,
    stream: true,
    maxTokens: (listing.limits && listing.limits.maxTokens) || 2000,
  }
}

// ---------- backend invocation (consumer/provider 共用) ------------------

// onUsage: 流式响应的最后一个 chunk 通常携带 usage(OpenAI 需 stream_options
// include_usage)。思维模型的 reasoning_content 不计费、不作为可见回复。
export async function* sseDeltas(res, onUsage) {
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') return
        const j = JSON.parse(data)
        if (j.usage) onUsage && onUsage(j.usage)
        const delta = j.choices?.[0]?.delta?.content
        if (delta) yield delta
      }
    }
  }
}

// Anthropic Messages API 流式:每个 SSE 事件带 `event: <name>` + `data: <json>`,
// 载荷形状与 OpenAI 完全不同:
//   message_start       → message.usage{ input_tokens, cache_read_input_tokens }
//   content_block_delta → delta.type==='text_delta' 时 delta.text 才是可见文本
//                         (thinking_delta / input_json_delta 不是回复,必须丢弃)
//   message_delta       → usage{ output_tokens }(累计值)
//   message_stop        → 流结束
// 与 OpenAI 的 `data: [DONE]` + choices[0].delta.content 无任何共同点,故独立实现。
export async function* anthropicSseDeltas(res, onUsage) {
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const usage = {}
  let emitted = false
  const emit = () => {
    if (!emitted && onUsage) {
      emitted = true
      onUsage(usage)
    }
  }
  // 单个 SSE 块 → { text, stop }。text 是可见文本增量,stop 表示 message_stop
  const parseBlock = (chunk) => {
    // 一个事件块里可能有 event:/data: 多行,只取 data 行
    let data = null
    for (const line of chunk.split('\n')) {
      if (line.startsWith('data:')) data = line.slice(5).trim()
    }
    if (!data) return { text: '', stop: false }
    let j
    try {
      j = JSON.parse(data)
    } catch {
      return { text: '', stop: false }
    }
    if (j.type === 'message_start' && j.message && j.message.usage) {
      Object.assign(usage, j.message.usage)
    } else if (j.type === 'message_delta' && j.usage) {
      // 累计值,覆盖 message_start 里的初始计数
      Object.assign(usage, j.usage)
    } else if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') {
      return { text: j.delta.text || '', stop: false }
    } else if (j.type === 'message_stop') {
      return { text: '', stop: true }
    }
    return { text: '', stop: false }
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const { text, stop } = parseBlock(chunk)
      if (text) yield text
      if (stop) {
        emit()
        return
      }
    }
  }
  // 流末尾缺少尾随空行时,最后一个事件块还留在 buf 里 —— 必须补解析,否则丢内容
  if (buf.trim()) {
    const { text } = parseBlock(buf)
    if (text) yield text
  }
  emit() // 未收到 message_stop 的兜底(流被截断也要把 usage 交出去)
}

// 缓存命中 token:OpenAI 系 usage.prompt_tokens_details.cached_tokens,
// Anthropic 系 usage.cache_read_input_tokens。后端不报 → 0(按普通输入计费)。
export function cachedTokensOf(usage) {
  if (!usage) return 0
  const v =
    (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) ||
    usage.cache_read_input_tokens ||
    0
  return Number.isFinite(v) ? v : 0
}

// 'echo' 后端:确定性回复,保证 devnet 无真实模型时全流程可跑通
export function echoReply(prompt, model) {
  return [
    `You asked: "${prompt}"`,
    '',
    'MeshLLM echo backend (deterministic, for the P2P + settlement demo):',
    '1) Transport: E2EE over the platform data channel (WS) — no inference bytes touch platform servers.',
    '2) E2E: P-256 ECDH ephemeral keys -> HKDF -> per-session AES-256-GCM keys.',
    '3) Metering: provider signs a receipt (tokensIn, tokensOut, transcriptHash).',
    '4) Settlement: per-call USDT release via the mesh-escrow state machine.',
    '',
    `(model=${model})`,
  ].join('\n')
}

// Anthropic Messages API 版本头(必填,缺失会 400)。
// 中继/直连都要带:它不属于鉴权,只是 API 版本协商。
export const ANTHROPIC_VERSION = '2023-06-01'

// Anthropic 鉴权:不是 Bearer,而是 x-api-key 头
export function anthropicHeaders(apiKey) {
  return {
    'anthropic-version': ANTHROPIC_VERSION,
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
  }
}

// 用户填的后端 URL 可能是 `.../v1` 或 `.../v1/chat/completions`,统一归一到 chat completions 端点;
// Anthropic 归一到 Messages API 的 `.../v1/messages`。
export function normalizeBackendUrl(u, kind = 'custom') {
  const t = String(u || '').trim()
  if (!t) return t
  if (kind === 'anthropic') {
    if (/\/messages\/?$/i.test(t)) return t.replace(/\/+$/, '')
    return t.replace(/\/+$/, '') + '/messages'
  }
  if (/\/chat\/completions\/?$/i.test(t)) return t.replace(/\/+$/, '')
  return t.replace(/\/+$/, '') + '/chat/completions'
}

// env: { serverBase, sessionToken, allowRelay }
// - serverBase:   mock 后端与 relay 的服务地址
// - sessionToken: relay 透传会话头(浏览器);Node agent 直连后端不需要
// - allowRelay:   browser true(CORS 受限);Node agent false(无 CORS,永远直连)
export async function runBackend({ listing, messages, params, onToken, apiKey, env = {} }) {
  const kind = (listing.backend && listing.backend.type) || 'echo'
  let full = ''
  const push = (c) => {
    full += c
    onToken(c)
  }
  if (kind === 'echo') {
    const prompt = (messages[messages.length - 1] || {}).content || ''
    const text = echoReply(prompt, params.model)
    for (const w of text.split(/(?<=\s)/)) push(w)
    return { text: full, usage: null }
  }
  const isAnthropic = kind === 'anthropic'
  const useRelay =
    (kind === 'custom' || isAnthropic) &&
    listing.backend &&
    listing.backend.relay &&
    env.allowRelay !== false
  const backendUrl = normalizeBackendUrl(listing.backend && listing.backend.url, kind)
  // Direct browser fetch requires the backend to send CORS headers; with the
  // relay the platform server forwards the request (v1; see README).
  const url = useRelay
    ? env.serverBase + '/relay'
    : kind === 'mock'
      ? env.serverBase + '/mock-llm/v1/chat/completions'
      : backendUrl
  let chatBody
  if (isAnthropic) {
    // Anthropic Messages API 与 OpenAI 的两处硬差异:
    // 1) system 是顶层独立字段,不能作为 role:'system' 混进 messages(会 400);
    // 2) max_tokens 是必填(OpenAI 那里只是建议值)。
    const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const rest = messages.filter((m) => m.role !== 'system')
    chatBody = {
      model: params.model,
      // 多轮:把整段历史发给后端(第 i 轮含之前所有轮)
      messages: rest.length ? rest : [{ role: 'user', content: ' ' }],
      // 强制后端按 listing 声明的上限截断输出:不带上限时后端会自由生成,
      // 费用超出 consumer 托管 → 结算失败
      max_tokens: params.maxTokens,
      stream: true,
    }
    if (sys) chatBody.system = sys
    // 注意:Anthropic 不支持 stream_options(带了不会回 usage,且可能报错)
  } else {
    chatBody = {
      model: params.model,
      messages,
      stream: true,
      max_tokens: params.maxTokens,
      // 让后端在流末尾回 usage(含 cached_tokens),用于缓存命中单独计费
      stream_options: { include_usage: true },
    }
  }
  // 后端自身的鉴权头:Anthropic 用 x-api-key + anthropic-version,其余走 Bearer。
  // 直连时作为外层请求头;走中继时作为 body.headers 由 /relay 透传给上游。
  const backendHeaders = isAnthropic
    ? anthropicHeaders(apiKey)
    : apiKey
      ? { Authorization: 'Bearer ' + apiKey }
      : {}
  let res
  try {
    // relay 端点有 auth.requireSession:必须带 x-mesh-session 头,
    // 否则服务器返回 401 {error:'session-required'}(23:15/23:17 故障根因)。
    // 直连 backend 时不需要。
    const session = env.sessionToken
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(useRelay && session ? { 'x-mesh-session': session } : {}),
        // 直连时 key 直接放在请求头;走中继时服务端 /relay 会把 body.headers
        // 转给上游(外层这个头对 /relay 无害)
        ...backendHeaders,
      },
      body: JSON.stringify(
        useRelay
          ? { url: backendUrl, method: 'POST', headers: backendHeaders, body: chatBody }
          : chatBody
      ),
    })
  } catch (e) {
    // fetch() 直接拒绝(拿不到 HTTP 状态)几乎总是浏览器 CORS 或网络不通
    throw new Error(
      'backend-fetch-failed: ' +
        (e.message || 'Failed to fetch') +
        (useRelay ? '' : ' (直连被 CORS/网络拦截,请发布 listing 时勾选「使用平台中继」)')
    )
  }
  if (!res.ok) {
    const msg = await res.text().catch(() => '')
    throw new Error('backend-http-' + res.status + (msg ? ' ' + msg.slice(0, 200) : ''))
  }
  let usage = null
  const onUsage = (u) => {
    usage = u
  }
  // Anthropic 的 SSE 事件形状与 OpenAI 完全不同,走独立解析器
  const stream = isAnthropic ? anthropicSseDeltas(res, onUsage) : sseDeltas(res, onUsage)
  for await (const d of stream) push(d)
  return { text: full, usage }
}
