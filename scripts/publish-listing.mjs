// 发布一个 agent 钱包名下、echo 后端的 listing 到指定服务器。
// 完全复用 agent 的 http 客户端 + 钱包加载 + 登录流程，复刻 server 的
// directory.upsertSigned 校验逻辑，保证 hash 与 Ed25519 签名一致。
// 用法: node scripts/publish-listing.mjs <serverUrl> <walletFile> <caCert> [modelName]
// 例:   node scripts/publish-listing.mjs https://68.64.183.89:4011 agent/wallet.json certs/public-cert.pem auto
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import nacl from 'tweetnacl'
import {
  b64encode, utf8, canonical, bytesToHex, sha256, listingPayloadForHash,
} from '@mesh/shared/protocol'
import { loadWallet } from '../agent/src/wallet.js'
import { api, login } from '../agent/src/http.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
if (args.length < 3) {
  console.error('usage: node scripts/publish-listing.mjs <serverUrl> <walletFile> <caCert> [modelName]')
  console.error('  serverUrl  http/https://host:port   (本例 https://68.64.183.89:4011)')
  console.error('  walletFile  agent 钱包 (例 agent/wallet.json)')
  console.error('  caCert      目标服务器自签证书 PEM(例 certs/public-cert.pem)')
  console.error('  modelName   可选, 默认 "auto"')
  process.exit(1)
}
const [serverUrl, walletFileIn, caCertFile, modelNameArg] = args
const modelName = modelNameArg || 'auto'
const walletPath = path.resolve(here, '..', walletFileIn)
const caPath = path.resolve(here, '..', caCertFile)

// ---- 钱包(复用 agent 的 loadWallet:bs58 校验 + makeWallet) ----
const wallet = loadWallet(walletPath)
let caPem = null
if (caCertFile && fs.existsSync(caPath)) caPem = fs.readFileSync(caPath, 'utf8')
// devnet: 公网 IP 未在证书 SAN 中,需跳过 node:https 主机名校验
const rejectUnauthorized = false

console.log('[publish] server   = ' + serverUrl)
console.log('[publish] wallet   = ' + wallet.address)
console.log('[publish] caCert   = ' + (caCertFile ? caCertFile : 'none'))
console.log('[publish] model    = ' + modelName)

// ---- 构建 listing(echo 后端,探测恒健康; 结构对齐 local 的 agent 现有 listing) ----
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

// ---- 计算 hash 与签名(与 server 的 upsertSigned 一致) ----
//   server:  computed = listingHashOf(listing)                 (不含 id)
//            校验 1: listing.id === computed
//            校验 2: listing.provider === req.wallet
//            校验 3: nacl.sign.detached.verify(hexToBytes(computed), b64decode(sig), pub)
const payload = listingPayloadForHash(listing)
const rawDigest = await sha256(utf8(canonical(payload)))      // raw 32-byte SHA-256 digest
const id = bytesToHex(rawDigest)                               // = sha256Hex(...) 即 listingHashOf 的 hex
// tweetnacl.sign.detached 返回单个签名数组(64 字节);不要解构(解构只拿到第一字节)
const sig = nacl.sign.detached(rawDigest, wallet.secretKey)
const signatureB64 = b64encode(sig)

const listingWithId = { ...listing, id }
console.log('[publish] id       = ' + id)
console.log('[publish] signature b64 len = ' + signatureB64.length)

// ---- 登录(nonce → verify) ----
console.log('[publish] logging in…')
const session = await login(serverUrl, wallet, caPem, { rejectUnauthorized })
console.log('[publish] session ok')

// ---- 发布 ----
const res = await api(serverUrl, '/listings', {
  method: 'POST',
  token: session,
  body: { listing: listingWithId, signature: signatureB64 },
  ca: caPem,
  rejectUnauthorized,
})
console.log('[publish] response:', JSON.stringify(res))

if (res && res.listing) {
  console.log('\n[PUBLISHED] 已发布到 ' + serverUrl)
  console.log('  id       : ' + res.listing.id)
  console.log('  provider : ' + res.listing.provider)
  console.log('  model    : ' + res.listing.model.name)
  console.log('  status   : ' + res.listing.status)
  console.log('\n接下来把 agent/config.json 里 对应 listing 的 listingId 改成上面的 id,')
  console.log('并把 server 改成 ' + serverUrl.replace(/^https?:\/\//, '') + ',')
  console.log('caCert 改成 certs/public-cert.pem,然后重跑 agent 即可。')
}