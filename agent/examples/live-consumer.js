// 真实链路参考实现(手动运行,不属于 npm test):
//   consumer(Node)→ /dc → 运行中的 provider agent → 真实模型 → 回执验签 → 双签结算。
// 前提:server(:4011)与 provider agent(浏览器或方案 C 无头)均在运行。
// 运行:node agent/examples/live-consumer.js [listingId]
//   - 传 listingId:调用该 listing(完整 ID 或前缀均可,服务端按前缀匹配不到时
//     会 404,请传完整 ID;前缀可用 GET /listings 查)
//   - 不传:自动选 GET /listings?online=1 里第一个在线 listing
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const nacl = require('tweetnacl')
const bs58 = require('bs58')

const CERT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server/tls/cert.pem')
const caPem = fs.existsSync(CERT) ? fs.readFileSync(CERT, 'utf8') : null
const argListingId = (process.argv[2] || '').trim()

const {
  b64encode,
  b64decode,
  turnInputEstimate,
  estimateTokens,
  transcriptHash,
  receiptDigest,
} = await import('@mesh/shared/protocol')
const { ed25519Verify } = await import('@mesh/shared/e2ee')
const { openDcChannel, SignalClient } = await import('@mesh/shared/signal')
const { KxSession, encodeEncrypted, decodeEncrypted, callParams } = await import('@mesh/shared/channel')
const { api: rawApi, login } = await import('../src/http.js')

const BASE = 'https://127.0.0.1:4011'
const WS_BASE = 'wss://127.0.0.1:4011'
const a = (p, o = {}) => rawApi(BASE, p, { ...o, ca: caPem })
const socketFactory = (u) => new WebSocket(u, { rejectUnauthorized: false })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const timeout = (ms, label) => sleep(ms).then(() => {
  throw new Error('timeout: ' + label)
})

function makeWallet() {
  const kp = nacl.sign.keyPair()
  const address = bs58.encode(kp.publicKey)
  return {
    address,
    secretKey: kp.secretKey,
    signMessage: (bytes) => nacl.sign.detached(new Uint8Array(bytes), kp.secretKey),
  }
}

const consumer = makeWallet()
const cToken = await login(BASE, consumer, caPem)

let listing
if (argListingId) {
  listing = (await a('/listings/' + argListingId)).listing
} else {
  const r = await a('/listings?online=1')
  const online = (r.listings || []).filter((x) => x.online && x.status === 'active')
  if (online.length === 0) throw new Error('没有在线 listing(用法:node live-consumer.js <listingId>)')
  listing = online[0]
  console.log('[live] 未传 listingId,自动选择: ' + listing.id.slice(0, 10) + ' ' + listing.model.name)
}
const LISTING_ID = listing.id
console.log('[live] listing ' + listing.model.name + ' provider=' + listing.provider)
const params = callParams(listing)

// 充值托管
await a('/escrow/fund', {
  method: 'POST',
  body: { consumer: consumer.address, listingId: LISTING_ID, amountRaw: 1000000 },
  token: cToken,
})
console.log('[live] escrow funded 1 USDT')

const sessionId = crypto.randomUUID()
const signal = new SignalClient(WS_BASE, socketFactory)
await Promise.race([signal.connect(), timeout(8000, 'signal')])
await signal.join('lst:' + LISTING_ID, { msg() {} })
await signal.join('sess:' + sessionId, { msg() {} })

const preKx = []
let keys = null
let receipt = null
const turns = []
let turnOpen = false
let turnDoneResolve = null
let receiptResolve = null
let kxReadyResolve = null
let kxReadyReject = null
const kxReadyP = new Promise((res, rej) => { kxReadyResolve = res; kxReadyReject = rej })
const receiptP = new Promise((res) => { receiptResolve = res })

let ch = null
ch = openDcChannel({
  url: WS_BASE,
  room: 'sess:' + sessionId,
  socketFactory,
  log: (s) => console.log('[dc] ' + s),
  onFrame: (text) => {
    if (text.startsWith('kx:')) {
      let f
      try { f = JSON.parse(text.slice(3)) } catch { return }
      if (f.t === 'bye') return
      if (kx) kx.handleKx(f)
      else preKx.push(f)
      return
    }
    if (!keys) return
    decodeEncrypted(keys.recvKey, text)
      .then((frame) => {
        if (frame.t === 'token') {
          const tr = turns[turns.length - 1]
          if (tr) tr.reply += frame.chunk || ''
          if (frame.done) {
            turnOpen = false
            if (turnDoneResolve) turnDoneResolve(tr)
          }
        } else if (frame.t === 'receipt') {
          receipt = frame.receipt
          receiptResolve(receipt)
        } else if (frame.t === 'error') {
          console.log('[live] provider error: ' + (frame.msg || ''))
          if (kxReadyReject) kxReadyReject(new Error('provider-error: ' + (frame.msg || '')))
        }
      })
      .catch(() => {})
  },
  onDead: () => console.log('[live] dc dead'),
})
await ch.ready

let kx = null
kx = new KxSession({
  sessionId,
  sign: consumer.signMessage,
  peerIdPub: bs58.decode(listing.provider),
  sendKx: (f) => ch.send('kx:' + JSON.stringify(f)),
  onReady: (k) => { keys = k; kxReadyResolve(k) },
  onFail: (e) => kxReadyReject(e),
  log: () => {},
})
for (const f of preKx.splice(0)) kx.handleKx(f)

const offer = { t: 'call', listingId: LISTING_ID, sessionId, consumerPub: consumer.address }
const offerTimer = setInterval(() => { try { signal.sendTo('lst:' + LISTING_ID, offer) } catch {} }, 1500)
signal.sendTo('lst:' + LISTING_ID, offer)
try {
  await Promise.race([kxReadyP, timeout(25000, 'kx handshake')])
} finally {
  clearInterval(offerTimer)
}
console.log('[live] kx ready')

await a('/escrow/begin-call', {
  method: 'POST',
  body: { consumer: consumer.address, listingId: LISTING_ID, sessionId },
  token: cToken,
})

const sendTurn = (text) =>
  new Promise((resolve, reject) => {
    turnDoneResolve = resolve
    turnOpen = true
    turns.push({ prompt: text, reply: '' })
    encodeEncrypted(keys.sendKey, { t: 'prompt', prompt: text, params })
      .then((p) => {
        ch.send(p)
        setTimeout(() => {
          if (turnOpen) { turnOpen = false; reject(new Error('turn-timeout')) }
        }, 90000)
      })
      .catch(reject)
  })

const t1 = await sendTurn('用一句话介绍你自己,并说出你的模型名字。')
console.log('[live] reply1 (' + t1.reply.length + ' chars): ' + t1.reply.slice(0, 200))

encodeEncrypted(keys.sendKey, { t: 'end' }).then((p) => ch.send(p)).catch(() => {})
const rc = await Promise.race([receiptP, timeout(30000, 'receipt')])
console.log('[live] receipt: tokensIn=' + rc.tokensIn + ' tokensOut=' + rc.tokensOut + ' txHash=' + rc.transcriptHash.slice(0, 16) + '...')

// 本地复核
const messages = []
for (const tr of turns) {
  messages.push({ role: 'user', content: tr.prompt })
  messages.push({ role: 'assistant', content: tr.reply })
}
const myHash = await transcriptHash(sessionId, params, messages)
if (rc.transcriptHash !== myHash) throw new Error('transcript hash mismatch')
const digest = await receiptDigest(rc)
if (!ed25519Verify(bs58.decode(listing.provider), b64decode(rc.signature), digest)) {
  throw new Error('receipt signature invalid')
}
console.log('[live] receipt verified locally')

await a('/escrow/receipt', {
  method: 'POST',
  body: { consumer: consumer.address, listingId: LISTING_ID, receipt: rc },
  token: cToken,
})
const acceptSig = b64encode(consumer.signMessage(digest))
const { escrow } = await a('/escrow/settle-fast', {
  method: 'POST',
  body: {
    consumer: consumer.address,
    listingId: LISTING_ID,
    acceptSigB64: acceptSig,
    attestSigB64: rc.signature,
  },
  token: cToken,
})
if (escrow.state !== 'SETTLED') throw new Error('escrow not settled: ' + escrow.state)
console.log('[live] SETTLED. tokensIn=' + rc.tokensIn + ' tokensOut=' + rc.tokensOut)

try { if (ch.isOpen()) ch.send('kx:' + JSON.stringify({ t: 'bye' })) } catch {}
ch.close()
signal.close()
console.log('[live] DONE')
process.exit(0)
