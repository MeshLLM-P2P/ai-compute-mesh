// MeshLLM shared protocol: canonical serialization, hashes, pricing, frame types.
// Pure functions only — must produce byte-identical results in browser and Node.

const te = new TextEncoder()
const td = new TextDecoder()

export const FRAMES = {
  KX_A: 'kx-a',
  KX_B: 'kx-b',
  HELLO: 'hello',
  ACK: 'ack',
  PROMPT: 'prompt',
  TOKEN: 'token',
  RECEIPT: 'receipt',
  ACCEPT: 'accept',
  DISPUTE: 'dispute',
  PING: 'ping',
  PONG: 'pong',
  BYE: 'bye',
  ERROR: 'error',
}

export const METERING_CHARS_PER_TOKEN = 4

// ---------- encoding helpers ----------

export function utf8(str) {
  return te.encode(str)
}

export function fromUtf8(bytes) {
  return td.decode(bytes)
}

export function b64encode(bytes) {
  let bin = ''
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  for (const b of arr) bin += String.fromCharCode(b)
  return btoa(bin)
}

export function b64decode(s) {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

export async function sha256Hex(bytes) {
  return bytesToHex(await sha256(bytes))
}

// ---------- canonical JSON ----------

// Deterministic JSON: object keys sorted, no whitespace. Numbers must be
// integers or finite floats serialized the same way on both sides (we use
// integers everywhere money/hash-relevant).
export function canonical(value) {
  if (value === null || value === undefined) return 'null'
  const t = typeof value
  if (t === 'string' || t === 'boolean') return JSON.stringify(value)
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical: non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (t === 'object') {
    if (value instanceof Uint8Array) return bytesToHex(value)
    const keys = Object.keys(value).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  }
  throw new Error('canonical: unsupported type ' + t)
}

export async function digestOf(obj) {
  return sha256(utf8(canonical(obj)))
}

// ---------- token estimation (shared metering) ----------

export function estimateTokens(text) {
  return Math.ceil((text || '').length / METERING_CHARS_PER_TOKEN)
}

// 多轮计费:第 i 轮的"输入 token"= 该轮发给后端的全部上下文(历史里每条
// 消息的内容)之和 —— 后端每轮都要重放全部历史,真实扣费与此同阶。
// 回执里的 tokensIn/tokensOut 是各轮累计;provider 与 consumer 必须用同一
// 函数按同一 messages 序列计算,才能让回执校验通过(容差内)。
export function turnInputEstimate(messages) {
  let n = 0
  for (const m of messages) n += estimateTokens(m && m.content)
  return n
}

// ---------- pricing (integer micro-USDT, 1e-6 USDT) ----------

export const RAW_PER_USDT = 1_000_000

export function rawToUsdt(raw) {
  return (raw / RAW_PER_USDT).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0')
}

// price: { per1kInputRaw, per1kOutputRaw, per1kCacheRaw?, minFeeRaw } — all integer micro-USDT
// per 1000 tokens (minFee absolute). Cache-hit tokens bill at per1kCacheRaw
// (fallback: the input price when unset — backends may report 0 cache tokens).
// Result: integer micro-USDT, exact.
export function calcAmountRaw(price, tokensIn, tokensOut, tokensCache = 0) {
  const ceilDiv = (a, b) => Math.ceil(a / b)
  const cacheRate = price.per1kCacheRaw != null ? price.per1kCacheRaw : price.per1kInputRaw
  const raw =
    ceilDiv(tokensIn * price.per1kInputRaw, 1000) +
    ceilDiv(tokensOut * price.per1kOutputRaw, 1000) +
    (tokensCache > 0 ? ceilDiv(tokensCache * cacheRate, 1000) : 0)
  return Math.max(price.minFeeRaw, raw)
}

// Platform fee split per settled transaction (percent of the gross amount):
// 1% maintenance + 2% after-sales guarantee fund + 2% promotion commission = 5%.
// Each bucket is floored; the provider keeps the remainder (absorbs sub-micro-USDT rounding).
export const FEE_SPLIT = { maintenance: 1, guarantee: 2, promotion: 2 }

export function splitFees(amountRaw, split = FEE_SPLIT) {
  const parts = {}
  let totalRaw = 0
  for (const k of Object.keys(split)) {
    const v = Math.floor((amountRaw * split[k]) / 100)
    parts[k] = v
    totalRaw += v
  }
  return { parts, totalRaw, providerRaw: amountRaw - totalRaw }
}

// ---------- listing ----------

// Backend identity is part of the listing: the same model on two different
// backends must be two distinct listings (different price routing).
export function listingBackendForHash(b) {
  return { type: (b && b.type) || 'echo', url: (b && b.url) || '' }
}

// Fields covered by listingHash (price/identity anchor). updatedAt/lastSeen etc. excluded.
export function listingPayloadForHash(l) {
  return {
    provider: l.provider,
    p2pPublicKey: l.p2pPublicKey,
    model: l.model,
    pricing: l.pricing,
    limits: l.limits,
    metering: l.metering,
    bondUsdtRaw: l.bondUsdtRaw,
    version: l.version,
    backend: listingBackendForHash(l.backend),
  }
}

export async function listingHashOf(l) {
  return sha256Hex(utf8(canonical(listingPayloadForHash(l))))
}

// listing.id === listingHash (deterministic identity)

// ---------- receipt ----------

export function receiptPayloadForHash(r) {
  return {
    sessionId: r.sessionId,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    // Cache-hit tokens (billed separately at per1kCacheRaw). Old receipts
    // (field absent) canonicalize to 0 on both sides — digests stay consistent.
    tokensCache: r.tokensCache || 0,
    transcriptHash: r.transcriptHash,
    listingId: r.listingId,
    ts: r.ts,
  }
}

// digest bytes that the wallet signs for a receipt
export async function receiptDigest(r) {
  return digestOf(receiptPayloadForHash(r))
}

// ---------- transcript ----------

// canonical transcript per ARCHITECTURE §7.4
// messages: [{ role: 'system'|'user'|'assistant', content: string }]
export async function transcriptHash(sessionId, params, messages) {
  let body = sessionId + '\n' + canonical(params) + '\n'
  for (const m of messages) {
    body += m.role + '\u0001' + m.content + '\u0001'
  }
  return sha256Hex(utf8(body))
}

// ---------- session key mixing ----------

// Symmetric mix: sort the two P-256 public keys (raw bytes) lexicographically,
// then M = sha256(min || max || session). Both sides compute the same M.
function lessBytes(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i]
  }
  return a.length < b.length
}

export async function mixDigest(epkA, epkB, session) {
  const [lo, hi] = lessBytes(epkA, epkB) ? [epkA, epkB] : [epkB, epkA]
  const joined = new Uint8Array(lo.length + hi.length + session.length)
  joined.set(lo, 0)
  joined.set(hi, lo.length)
  joined.set(session, lo.length + hi.length)
  return sha256(joined)
}
