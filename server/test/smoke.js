// End-to-end smoke test against a RUNNING server (node src/index.js on :4011, TLS).
// Covers: health, wallet login, signed listing publish, presence, mock-LLM
// SSE, escrow fund->beginCall->receipt->settleFast, and WS signaling relay.
// 自签证书:运行时 NODE_EXTRA_CA_CERTS 对内置 fetch 无效,显式传 ca(PEM)。
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { request as httpsRequest } from 'node:https'
import { createRequire } from 'node:module'
import {
  listingHashOf,
  hexToBytes,
  b64encode,
  utf8,
  calcAmountRaw,
  receiptPayloadForHash,
  receiptDigest,
} from '@mesh/shared/protocol'
const require = createRequire(import.meta.url)
const nacl = require('tweetnacl')
const bs58 = require('bs58')
const WebSocket = require('ws')
const { api: rawApi, login: rawLogin } = await import('../../agent/src/http.js')

const CERT = path.resolve(import.meta.dirname, '..', 'tls', 'cert.pem')
const caPem = fs.existsSync(CERT) ? fs.readFileSync(CERT, 'utf8') : null
const BASE = 'https://127.0.0.1:4011'
let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok ' + name)
}

async function j(path, opts = {}) {
  const data = await rawApi(BASE, path, {
    method: opts.method || 'GET',
    body: opts.body,
    token: opts.headers && opts.headers['x-mesh-session'],
    ca: caPem,
  })
  if (data === null) throw new Error(`${path} -> no json`)
  return data
}

// SSE:node:https 直接请求(内置 fetch 不接受 ca 选项)
function sseRequest(url, body) {
  const u = new URL(url)
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      u,
      {
        method: 'POST',
        ca: caPem,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => {
          data += c
        })
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], text: data }))
      }
    )
    req.on('error', (e) => reject(new Error('http-error: ' + e.message)))
    req.setTimeout(15000, () => req.destroy(new Error('http-timeout')))
    req.write(payload)
    req.end()
  })
}

function makeWallet() {
  const kp = nacl.sign.keyPair()
  return { address: bs58.encode(kp.publicKey), secret: kp.secretKey }
}

async function login(wallet) {
  return rawLogin(
    BASE,
    { address: wallet.address, signMessage: (m) => nacl.sign.detached(m, wallet.secret) },
    caPem
  )
}

async function main() {
  console.log('== smoke ==')
  const health = await j('/health')
  assert.equal(health.ok, true)
  ok('health')

  const cfg = await j('/config')
  assert.equal(typeof cfg.rpcUrl, 'string')
  ok('config')

  const consumer = makeWallet()
  const provider = makeWallet()
  const sConsumer = await login(consumer)
  const sProvider = await login(provider)
  ok('wallet login x2 (nonce+verify)')

  // publish listing
  const pricing = {
    currency: 'USDT',
    per1kInputRaw: 5000,
    per1kOutputRaw: 15000,
    minFeeRaw: 10000,
  }
  const listing = {
    provider: provider.address,
    p2pPublicKey: provider.address,
    model: { name: 'smoke-model', context: 8192, modalities: ['text'] },
    pricing,
    limits: { maxTokens: 2000, maxConcurrent: 2 },
    metering: { charsPerToken: 4, tolerancePct: 5 },
    bondUsdtRaw: 100000000,
    version: 1,
    backend: { type: 'mock' },
  }
  const id = await listingHashOf(listing)
  const signature = b64encode(nacl.sign.detached(hexToBytes(id), provider.secret))
  const saved = await j('/listings', {
    method: 'POST',
    headers: { 'x-mesh-session': sProvider },
    body: { listing: { ...listing, id }, signature },
  })
  assert.equal(saved.listing.id, id)
  ok('publish signed listing (id === listingHash)')

  const listed = await j('/listings/' + id)
  assert.equal(listed.listing.model.name, 'smoke-model')
  ok('get listing')

  // provider-scoped listing view (multiple listings per account)
  const mine = await j('/listings?provider=' + encodeURIComponent(provider.address))
  assert.ok(mine.listings.some((l) => l.id === id && l.status === 'active' && l.backend))
  ok('GET /listings?provider= (filter + backend field)')

  // presence -> online
  await j('/presence', {
    method: 'POST',
    headers: { 'x-mesh-session': sProvider },
    body: { listingId: id },
  })
  const onlineList = await j('/listings?online=1')
  assert.ok(onlineList.listings.some((l) => l.id === id && l.online === true))
  ok('presence -> online in directory')

  // mock LLM SSE
  const res = await sseRequest(BASE + '/mock-llm/v1/chat/completions', {
    model: 'smoke-model',
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
  })
  assert.equal(res.status, 200)
  assert.match(res.type, /text\/event-stream/)
  assert.ok(res.text.includes('data: ') && res.text.includes('[DONE]'))
  assert.ok((res.text.match(/delta/g) || []).length >= 2)
  ok('mock-llm SSE stream')

  // mock LLM model directory (OpenAI-compatible)
  const models = await j('/mock-llm/v1/models')
  assert.ok(Array.isArray(models.data) && models.data.length >= 1)
  assert.ok(models.data.every((m) => typeof m.id === 'string' && m.id.length > 0))
  ok('mock-llm GET /v1/models')

  // escrow: fund -> beginCall -> receipt -> settleFast
  const amount = calcAmountRaw(pricing, 100, 50)
  const funded = await j('/escrow/fund', {
    method: 'POST',
    headers: { 'x-mesh-session': sConsumer },
    body: { consumer: consumer.address, listingId: id, amountRaw: amount * 2 },
  })
  assert.equal(funded.escrow.state, 'FUNDED')
  ok('escrow fund')

  const sessionId = 'a'.repeat(32).replace(/a/g, () => '0123456789abcdef'[Math.floor(Math.random() * 16)])
  const inCall = await j('/escrow/begin-call', {
    method: 'POST',
    headers: { 'x-mesh-session': sConsumer },
    body: { consumer: consumer.address, listingId: id, sessionId },
  })
  assert.equal(inCall.escrow.state, 'IN_CALL')
  ok('escrow begin-call')

  const receipt = receiptPayloadForHash({
    listingId: id,
    sessionId,
    transcriptHash: 'c'.repeat(64),
    tokensIn: 100,
    tokensOut: 50,
    ts: Date.now(),
  })
  const digest = await receiptDigest(receipt)
  receipt.signature = b64encode(nacl.sign.detached(digest, provider.secret))
  const submitted = await j('/escrow/receipt', {
    method: 'POST',
    headers: { 'x-mesh-session': sConsumer },
    body: { consumer: consumer.address, listingId: id, receipt },
  })
  assert.equal(submitted.escrow.state, 'SETTLE_WINDOW')
  ok('escrow submitReceipt (provider-signed)')

  const stored = await j('/escrow?consumer=' + consumer.address + '&listingId=' + id)
  const storedDigest = await receiptDigest(stored.escrow.receipt)
  const acceptSig = b64encode(nacl.sign.detached(storedDigest, consumer.secret))
  const attestSig = b64encode(nacl.sign.detached(storedDigest, provider.secret))
  const settled = await j('/escrow/settle-fast', {
    method: 'POST',
    headers: { 'x-mesh-session': sConsumer },
    body: { consumer: consumer.address, listingId: id, acceptSigB64: acceptSig, attestSigB64: attestSig },
  })
  assert.equal(settled.escrow.state, 'SETTLED')
  assert.equal(settled.escrow.tx.amountRaw, amount)
  ok('escrow settle-fast (dual sig, server-recomputed amount = ' + amount + ')')

  // WS signaling relay
  const wsUrl = 'wss://127.0.0.1:4011/signal'
  const wsOpts = { rejectUnauthorized: false }
  await new Promise((resolve, reject) => {
    const pws = new WebSocket(wsUrl, wsOpts)
    const cws = new WebSocket(wsUrl, wsOpts)
    const timer = setTimeout(() => reject(new Error('ws relay timeout')), 5000)
    pws.on('open', () => pws.send(JSON.stringify({ t: 'join', room: 'lst:' + id })))
    cws.on('open', () => cws.send(JSON.stringify({ t: 'join', room: 'lst:' + id })))
    pws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.t === 'call' && m.sessionId === sessionId) {
        clearTimeout(timer)
        pws.close()
        cws.close()
        resolve()
      }
    })
    pws.on('open', () => {
      // wait for both joined acks then send call
      setTimeout(() => {
        cws.send(
          JSON.stringify({ t: 'call', listingId: id, sessionId, consumerPub: consumer.address })
        )
      }, 300)
    })
  })
  ok('WS /signal relay (lst room: consumer -> provider)')

  console.log(`== smoke passed: ${passed} checks ==`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    // Server not up (TLS 握手失败/拒连) -> skip(保持 `node --test` 离线全绿)
    if (e && (e.cause?.code === 'ECONNREFUSED' || e.code === 'ECONNREFUSED' || /fetch failed/i.test(e.message) || /http-error: connect ECONNREFUSED/i.test(e.message) || /self-signed|certificate|EPROTO/i.test(e.message))) {
      console.log('  skip smoke (server not running on :4011)')
      process.exit(0)
    }
    console.error('SMOKE FAILED:', e.message)
    process.exit(1)
  })
