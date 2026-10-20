// 端到端 RTC 直连(阶段 2b):真实 server(:4011) + Node agent + werift consumer。
// 与 server/test/e2e-echo.test.js 的区别仅在于数据面走 WebRTC DataChannel,
// 信令面仍走 /signal 的 sess 房间(accept/sdp/ice/fallback)。
//
// 验证链路:consumer(注入 werift) → offer(带 transport=['rtc','relay']) →
//   agent 回 accept(rtc) → SDP/ICE 交换 → DC open → kx 握手 →
//   prompt → echo → receipt → 本地复核 hash + signature。
//
// 不测结算(已有 e2e-echo 覆盖),不测多轮(单轮足够验证数据面)。
import test from 'node:test'
import assert from 'node:assert'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const nacl = require('tweetnacl')
const bs58 = require('bs58')

const CERT = path.resolve(import.meta.dirname, '..', 'tls', 'cert.pem')
const caPem = fs.existsSync(CERT) ? fs.readFileSync(CERT, 'utf8') : null

const {
  b64encode,
  b64decode,
  hexToBytes,
  listingHashOf,
  turnInputEstimate,
  estimateTokens,
  transcriptHash,
  receiptDigest,
} = await import('@mesh/shared/protocol')
const { ed25519Verify } = await import('@mesh/shared/e2ee')
const { SignalClient, openRtcChannel } = await import('@mesh/shared/signal')
const { KxSession, encodeEncrypted, decodeEncrypted, callParams } = await import('@mesh/shared/channel')
const { api: rawApi, login } = await import('../../agent/src/http.js')
const { startNodeAgent } = await import('../../agent/src/agent.js')

const BASE = 'https://127.0.0.1:4011'
const a = (p, o = {}) => rawApi(BASE, p, { ...o, ca: caPem })
const WS_BASE = 'wss://127.0.0.1:4011'
const socketFactory = (u) => new WebSocket(u, { rejectUnauthorized: false })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const timeout = (ms, label) => sleep(ms).then(() => { throw new Error('timeout: ' + label) })

function makeWallet() {
  const kp = nacl.sign.keyPair()
  const address = bs58.encode(kp.publicKey)
  return { address, secretKey: kp.secretKey, signMessage: (bytes) => nacl.sign.detached(new Uint8Array(bytes), kp.secretKey) }
}

test('node e2e over WebRTC: single-turn echo, signed receipt', async (t) => {
  let up = true
  try { await a('/health') } catch { up = false }
  if (!up) return t.skip('server on :4011 unreachable')

  const provider = makeWallet()
  const consumer = makeWallet()
  const pToken = await login(BASE, provider, caPem)
  const cToken = await login(BASE, consumer, caPem)

  const payload = {
    provider: provider.address,
    p2pPublicKey: provider.address,
    model: { name: 'echo-rtc-e2e-' + Date.now(), context: 8192, modalities: ['text'] },
    pricing: { currency: 'USDT', per1kInputRaw: 5000, per1kOutputRaw: 15000, per1kCacheRaw: 1000, minFeeRaw: 100 },
    limits: { maxTokens: 500, maxConcurrent: 1 },
    metering: { charsPerToken: 4, tolerancePct: 5 },
    bondUsdtRaw: 0,
    version: 1,
    backend: { type: 'echo', url: '', relay: false },
  }
  const listingId = await listingHashOf(payload)
  const signature = b64encode(provider.signMessage(hexToBytes(listingId)))
  const { listing } = await a('/listings', { method: 'POST', body: { listing: { ...payload, id: listingId }, signature }, token: pToken })

  let agent = null
  let signal = null
  let rtcCh = null
  let ch = null
  let kx = null
  try {
    // ---- 启动 agent(带 getIce,让 agent 能拿到 TURN 凭据) ----
    agent = startNodeAgent({
      wsBase: WS_BASE,
      listing,
      wallet: provider,
      apiKey: '',
      env: { serverBase: BASE, allowRelay: false },
      // 预热 ICE:agent 侧直连协商需要 /ice 的 TURN 凭据
      getIce: async () => {
        try {
          const r = await a('/ice', { token: pToken })
          return r || { iceServers: [] }
        } catch {
          return { iceServers: [] }
        }
      },
      rtcEnabled: true,
      log: (s) => console.log('[e2e-agent] ' + s),
    })

    // ---- consumer 侧:信令 + RTC 直连 + kx ----
    const sessionId = crypto.randomUUID()
    const params = callParams(listing)
    signal = new SignalClient(WS_BASE, socketFactory)
    await Promise.race([signal.connect(), timeout(8000, 'signal connect')])
    await signal.join('lst:' + listingId, { msg() {} })

    const preKx = []
    let frameChain = Promise.resolve()
    let keys = null
    let receipt = null
    let kxReadyResolve = null
    let kxReadyReject = null
    const kxReadyP = new Promise((res, rej) => { kxReadyResolve = res; kxReadyReject = rej })
    let receiptResolve = null
    const receiptP = new Promise((res) => { receiptResolve = res })
    let turnDoneResolve = null
    let turnOpen = false
    let reply = ''

    const handleFrame = (text) => {
      if (text.startsWith('kx:')) {
        let f
        try { f = JSON.parse(text.slice(3)) } catch { return }
        if (f.t === 'bye') return
        if (kx) kx.handleKx(f)
        else preKx.push(f)
        return
      }
      if (!keys) return
      frameChain = frameChain.then(() =>
        decodeEncrypted(keys.recvKey, text)
          .then((frame) => {
            if (frame.t === 'token') {
              reply += frame.chunk || ''
              if (frame.done) {
                turnOpen = false
                if (turnDoneResolve) turnDoneResolve(reply)
              }
            } else if (frame.t === 'receipt') {
              receipt = frame.receipt
              receiptResolve(receipt)
            } else if (frame.t === 'error') {
              if (kxReadyReject) kxReadyReject(new Error('provider-error: ' + (frame.msg || '')))
            }
          })
          .catch(() => {})
      )
    }
    const handleDead = () => {}
    let accept = null
    await signal.join('sess:' + sessionId, {
      msg: (m) => {
        if (m.t === 'accept') accept = m
        else if ((m.t === 'sdp' || m.t === 'ice') && rtcCh) rtcCh.handleSignalMsg(m)
        else if (m.t === 'fallback') {}
      },
    })

    // 发 offer(带 transport 声明)
    const offer = { t: 'call', listingId, sessionId, consumerPub: consumer.address, transport: ['rtc', 'relay'] }
    const offerTimer = setInterval(() => { try { signal.sendTo('lst:' + listingId, offer) } catch {} }, 1500)
    signal.sendTo('lst:' + listingId, offer)

    // 等 accept(rtc)
    let waited = 0
    while (!accept && waited < 12000) { await sleep(200); waited += 200 }
    clearInterval(offerTimer)
    if (!accept) throw new Error('timeout: 未收到 provider accept')
    assert.strictEqual(accept.transport, 'rtc', 'agent 应回 rtc(本机联调 host 候选即可直连)')

    // 建立 consumer 侧 RTC 通道
    const { RTCPeerConnection } = await import('werift')
    rtcCh = openRtcChannel({
      signal,
      room: 'sess:' + sessionId,
      isConsumer: true,
      log: (s) => console.log('[e2e-rtc] ' + s),
      onFrame: handleFrame,
      onDead: handleDead,
      timeoutMs: 15000,
      iceServers: [],
      rtcImpl: { RTCPeerConnection },
    })
    await Promise.race([rtcCh.ready, timeout(20000, 'rtc ready')])
    ch = rtcCh

    // kx 握手
    kx = new KxSession({
      sessionId,
      sign: consumer.signMessage,
      peerIdPub: bs58.decode(listing.provider),
      sendKx: (f) => ch.send('kx:' + JSON.stringify(f)),
      onReady: (k) => { keys = k; kxReadyResolve(k) },
      onFail: (e) => kxReadyReject(e),
      log: (s) => console.log('[e2e-kx] ' + s),
    })
    for (const f of preKx.splice(0)) kx.handleKx(f)
    await Promise.race([kxReadyP, timeout(25000, 'kx handshake')])

    // 托管
    await a('/escrow/fund', { method: 'POST', body: { consumer: consumer.address, listingId, amountRaw: 1000000 }, token: cToken })
    await a('/escrow/begin-call', { method: 'POST', body: { consumer: consumer.address, listingId, sessionId }, token: cToken })

    // 单轮 prompt
    const prompt = '你好,这是 RTC 直连 e2e 测试。'
    const turnP = new Promise((resolve, reject) => {
      turnDoneResolve = resolve
      turnOpen = true
      encodeEncrypted(keys.sendKey, { t: 'prompt', prompt, params })
        .then((p) => { ch.send(p); setTimeout(() => { if (turnOpen) { turnOpen = false; reject(new Error('turn-timeout')) } }, 30000) })
        .catch(reject)
    })
    const result = await Promise.race([turnP, timeout(30000, 'turn')])
    assert.ok(result.includes('You asked:'), 'echo reply unexpected: ' + result)

    // 收尾 → receipt
    encodeEncrypted(keys.sendKey, { t: 'end' }).then((p) => ch.send(p)).catch(() => {})
    const rc = await Promise.race([receiptP, timeout(30000, 'receipt')])

    // 复核
    const messages = [{ role: 'user', content: prompt }, { role: 'assistant', content: result }]
    const myHash = await transcriptHash(sessionId, params, messages)
    assert.strictEqual(rc.transcriptHash, myHash, 'transcript hash mismatch')
    const digest = await receiptDigest(rc)
    assert.ok(ed25519Verify(bs58.decode(listing.provider), b64decode(rc.signature), digest), 'receipt signature invalid')
    console.log('[e2e-rtc] ok: receipt verified, tokensIn=' + rc.tokensIn + ' tokensOut=' + rc.tokensOut)
  } finally {
    try { if (ch && ch.isOpen()) ch.send('kx:' + JSON.stringify({ t: 'bye' })) } catch {}
    try { ch && ch.close() } catch {}
    try { signal && signal.close() } catch {}
    if (agent) agent.stop()
    try { await a('/listings/' + listingId, { method: 'DELETE', token: pToken }) } catch {}
  }
})
