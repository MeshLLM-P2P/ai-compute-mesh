// Path B 自包含 echo provider
// ============================================================
// 作用:发布一个 backend.type='echo' 的 listing 并上线,
//   然后跑 startNodeAgent 接 E2EE + 托管结算的请求。
// 没有真实模型、没有 CORS/relay、不需要浏览器。
// 用途:验证 MeshLLM 桥 (bridge/server.js) 的完整 P2P + 托管回路,
//   让 bridge 的 auto-listing 选中它并完成 一次 call -> receipt -> settle。
// 运行: node bridge/echo-provider.mjs   (stdout 打印 LISTING_ID=xxx)
// ============================================================
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const nacl = require('tweetnacl')
const bs58 = require('bs58')

const here = path.dirname(fileURLToPath(import.meta.url)) // bridge/
const root = path.join(here, '..')                          // ai-compute-mesh

const BASE = 'https://127.0.0.1:4011'
const WS_BASE = 'wss://127.0.0.1:4011'
const caPem = fs.existsSync(path.join(root, 'server/tls/cert.pem'))
  ? fs.readFileSync(path.join(root, 'server/tls/cert.pem'), 'utf8')
  : null

const { b64encode, b64decode, listingHashOf, hexToBytes } = await import(
  pathToFileURL(path.join(root, 'shared/src/protocol.js'))
)
const { api, login } = await import(
  pathToFileURL(path.join(root, 'agent/src/http.js'))
)
const { startNodeAgent } = await import(
  pathToFileURL(path.join(root, 'agent/src/agent.js'))
)

// ---------- 钱包 ----------
function loadWallet(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (typeof raw.address !== 'string' || typeof raw.secretKeyB64 !== 'string')
    throw new Error('wallet file format error')
  const secretKey = b64decode(raw.secretKeyB64)
  if (secretKey.length !== 64) throw new Error('secretKey must be 64 bytes')
  const expected = bs58.encode(secretKey.subarray(32))
  if (expected !== raw.address) throw new Error('address/secretKey mismatch')
  return {
    address: expected,
    secretKey,
    signMessage: (bytes) => nacl.sign.detached(new Uint8Array(bytes), secretKey),
    publicKey: new Uint8Array(secretKey.subarray(32)),
  }
}
const walletFile = process.env.ECHO_WALLET_FILE || path.join(root, 'agent', 'wallet.json')
const wallet = loadWallet(walletFile)
console.log('[echo-provider] wallet=' + wallet.address)
console.log('[echo-provider] base=' + BASE + ' ws=' + WS_BASE + (caPem ? ' (tls ca)' : ' (no ca)'))

// ---------- 发布 listing ----------
// 唯一模型名,避免与任何既有 listing 同哈希(相同 provider+model+backend 会互相 supersede)。
const modelName = 'echo-bridge-' + Date.now().toString(36)
const listing = {
  provider: wallet.address,
  p2pPublicKey: wallet.address,
  model: { name: modelName, context: 8192, modalities: ['text'] },
  pricing: { currency: 'USDT', per1kInputRaw: 5000, per1kOutputRaw: 15000, minFeeRaw: 10000 },
  limits: { maxTokens: 2000, maxConcurrent: 1 },
  metering: { charsPerToken: 4, tolerancePct: 5 },
  bondUsdtRaw: 100000000,
  version: 1,
  backend: { type: 'echo', url: '' },
}
const id = await listingHashOf(listing)
const signature = b64encode(nacl.sign.detached(hexToBytes(id), wallet.secretKey))
console.log('[echo-provider] publishing listing id=' + id)
const saved = await api(BASE, '/listings', {
  method: 'POST',
  body: { listing: { ...listing, id }, signature },
  token: (await login(BASE, wallet, caPem)),
  ca: caPem,
})
console.log('[echo-provider] saved id=' + saved.listing.id)
if (saved.listing.id !== id) throw new Error('published id mismatch')

// ---------- presence 心跳 ----------
let token = await login(BASE, wallet, caPem)
async function apiP(p, o = {}) {
  try {
    return await api(BASE, p, { ...o, token, ca: caPem })
  } catch (e) {
    if (e.message && e.message.includes('401')) {
      console.log('[echo-provider] session expired, re-login…')
      token = await login(BASE, wallet, caPem)
      return await api(BASE, p, { ...o, token, ca: caPem })
    }
    throw e
  }
}
async function markOnline() {
  const r = await apiP('/presence', { method: 'POST', body: { listingId: id } })
  console.log('[echo-provider] presence ts=' + r.ts)
}
markOnline().catch((e) => {
  console.error('[echo-provider] initial presence failed: ' + e.message)
})

const heartbeatSec = 30
setInterval(async () => {
  try {
    await apiP('/presence', { method: 'POST', body: { listingId: id } })
  } catch (e) {
    console.error('[echo-provider] heartbeat failed: ' + e.message)
  }
}, heartbeatSec * 1000)

// ---------- startNodeAgent ----------
let agent
try {
  agent = startNodeAgent({
    wsBase: WS_BASE,
    listing: { ...listing, id },
    wallet,
    apiKey: '',
    env: { serverBase: BASE, allowRelay: false },
    log: (s) => console.log('[echo-provider] [' + s.slice(0, 200) + ']'),
    onCall: (info) => console.log('[echo-provider] call ' + info.sessionId.slice(0, 8) + ' ' + info.phase),
    onCallEnd: (info) =>
      console.log('[echo-provider] call ' + info.sessionId.slice(0, 8) + ' ended ok=' + info.ok + (info.error ? ' (' + info.error + ')' : '')),
  })
} catch (e) {
  console.error('[echo-provider] startNodeAgent failed: ' + e.message)
  process.exit(1)
}

console.log('LISTING_ID=' + id)
console.log('[echo-provider] online; waiting for calls from bridge (Ctrl+C to stop)')

// ---------- shutdown ----------
process.on('SIGINT', async () => {
  console.log('[echo-provider] shutting down...')
  try {
    await apiP('/presence/offline', { method: 'POST', body: { listingId: id } })
  } catch {}
  if (agent) agent.stop()
  process.exit(0)
})
process.on('SIGTERM', async () => {
  console.log('[echo-provider] shutting down...')
  try {
    await apiP('/presence/offline', { method: 'POST', body: { listingId: id } })
  } catch {}
  if (agent) agent.stop()
  process.exit(0)
})