// P1.1 可观测性:调用时间线三端点(/escrows/conversation、/me/conversations、
// /me/calls/export)+ 数据面 dc 帧统计的端到端验证。对 :4011 dev server 运行;
// 不可达时自跳过(与 e2e-echo 一致)。
import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const { b64encode, listingHashOf, receiptDigest, hexToBytes } = await import('@mesh/shared/protocol')
const { SignalClient, openDcChannel } = await import('@mesh/shared/signal')
const { KxSession, encodeEncrypted, decodeEncrypted, callParams } = await import('@mesh/shared/channel')
const { api: rawApi, login } = await import('../../agent/src/http.js')
const { startNodeAgent } = await import('../../agent/src/agent.js')

const BASE = 'https://127.0.0.1:4011'
const WS_BASE = 'wss://127.0.0.1:4011'
const certPath = path.resolve(import.meta.dirname, '..', 'tls', 'cert.pem')
const ca = fs.existsSync(certPath) ? fs.readFileSync(certPath, 'utf8') : null
const a = (p, o = {}) => rawApi(BASE, p, { ...o, ca })
// 必须透传 URL:SignalClient 会拼 /signal 路径,服务端 upgrade 分发器
// 只认 /signal 与 /dc,裸路径连接会被 destroy(工厂忽略参数时 join 永远
// 等不到 ack —— 2026-10-16 修复的挂起根因)
const socketFactory = (u) => new WebSocket(u, { rejectUnauthorized: false })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const timeout = (ms, label) => sleep(ms).then(() => new Error('timeout: ' + label))

function makeWallet() {
  const kp = require('tweetnacl').sign.keyPair()
  const bs58 = require('bs58')
  return {
    address: bs58.encode(kp.publicKey),
    secretKey: kp.secretKey,
    signMessage: (bytes) => require('tweetnacl').sign.detached(new Uint8Array(bytes), kp.secretKey),
  }
}

test('P1.1 时间线端点 + dc 帧统计', async (t) => {
  let up = true
  try {
    await a('/health')
  } catch {
    up = false
  }
  if (!up) return t.skip('server on :4011 unreachable')

  const provider = makeWallet()
  const consumer = makeWallet()
  const bs58 = require('bs58')
  const pToken = await login(BASE, provider, ca)
  const cToken = await login(BASE, consumer, ca)

  const listing = {
    provider: provider.address,
    p2pPublicKey: provider.address,
    model: { name: 'obs-e2e-' + Date.now(), context: 8192, modalities: ['text'] },
    pricing: { currency: 'USDT', per1kInputRaw: 5000, per1kOutputRaw: 15000, per1kCacheRaw: 1000, minFeeRaw: 100 },
    limits: { maxTokens: 500, maxConcurrent: 1 },
    metering: { charsPerToken: 4, tolerancePct: 5 },
    bondUsdtRaw: 0,
    version: 1,
    backend: { type: 'echo', url: '', relay: false },
  }
  const listingId = await listingHashOf(listing)
  const pub = (await a('/listings', {
    method: 'POST',
    body: {
      listing: { ...listing, id: listingId },
      signature: b64encode(provider.signMessage(hexToBytes(listingId))),
    },
    token: pToken,
  })).listing

  let agent = null
  let signal = null
  let ch = null
  let kx = null
  let rc = null

  try {
    await a('/escrow/fund', {
      method: 'POST',
      body: { consumer: consumer.address, listingId, amountRaw: 2000000 },
      token: cToken,
    })

    agent = startNodeAgent({
      wsBase: WS_BASE,
      listing: pub,
      wallet: provider,
      apiKey: '',
      env: { serverBase: BASE, allowRelay: false },
      log: () => {},
    })

    const sessionId = crypto.randomUUID()
    const params = callParams(pub)
    signal = new SignalClient(WS_BASE, socketFactory)
    await Promise.race([signal.connect(), timeout(8000, 'signal')])
    await signal.join('lst:' + listingId, { msg() {} })
    await signal.join('sess:' + sessionId, { msg() {} })

    const preKx = []
    let keys = null
    let kxResolve = null
    let rcResolve = null
    const kxReadyP = new Promise((res) => (kxResolve = res))
    const rcPromise = new Promise((res) => (rcResolve = res))

    ch = openDcChannel({
      url: WS_BASE,
      room: 'sess:' + sessionId,
      socketFactory,
      log: () => {},
      onFrame: (text) => {
        if (text.startsWith('kx:')) {
          let f
          try {
            f = JSON.parse(text.slice(3))
          } catch {
            return
          }
          if (f.t === 'bye') return
          if (kx) kx.handleKx(f)
          else preKx.push(f)
          return
        }
        if (!keys) return
        decodeEncrypted(keys.recvKey, text)
          .then((frame) => {
            if (frame.t === 'token') {
              const tr = ch._turns && ch._turns.length ? ch._turns[ch._turns.length - 1] : null
              if (tr) tr.reply += frame.chunk || ''
              if (frame.done && ch._turnDone) ch._turnDone(tr)
            } else if (frame.t === 'receipt') {
              rc = frame.receipt
              if (rcResolve) rcResolve(rc)
            }
          }).catch(() => {})
      },
      onDead: () => {},
    })
    ch._turns = []
    ch._turnDone = null
    await ch.ready

    kx = new KxSession({
      sessionId,
      sign: consumer.signMessage,
      peerIdPub: bs58.decode(pub.provider),
      sendKx: (f) => ch.send('kx:' + JSON.stringify(f)),
      onReady: (k) => {
        keys = k
        kxResolve(k)
      },
      onFail: () => {},
      log: () => {},
    })
    for (const f of preKx.splice(0)) kx.handleKx(f)

    const offer = { t: 'call', listingId, sessionId, consumerPub: consumer.address }
    const tt = setInterval(() => {
      try {
        signal.sendTo('lst:' + listingId, offer)
      } catch {}
    }, 1500)
    signal.sendTo('lst:' + listingId, offer)
    try {
      await Promise.race([kxReadyP, timeout(25000, 'kx')])
    } finally {
      clearInterval(tt)
    }

    await a('/escrow/begin-call', {
      method: 'POST',
      body: { consumer: consumer.address, listingId, sessionId },
      token: cToken,
    })

    const sendTurn = (text) => {
      const turn = { prompt: text, reply: '' }
      ch._turns.push(turn)
      const done = new Promise((res) => (ch._turnDone = res))
      encodeEncrypted(keys.sendKey, { t: 'prompt', prompt: text, params }).then((p) => ch.send(p)).catch(() => {})
      setTimeout(() => { if (ch._turnDone) ch._turnDone(undefined) }, 20000)
      return done
    }
    const t1 = await sendTurn('可观测性 e2e 测试回合。')
    assert.ok(t1 && t1.reply.length > 0, 'turn 1 no reply')

    encodeEncrypted(keys.sendKey, { t: 'end' }).then((p) => ch.send(p)).catch(() => {})
    rc = await Promise.race([rcPromise, timeout(30000, 'receipt')])
    assert.ok(rc, 'no receipt')

    await a('/escrow/receipt', {
      method: 'POST',
      body: { consumer: consumer.address, listingId, receipt: rc },
      token: cToken,
    })
    const digest = await receiptDigest(rc)
    const acceptSig = b64encode(consumer.signMessage(digest))
    const { escrow } = await a('/escrow/settle-fast', {
      method: 'POST',
      body: {
        consumer: consumer.address,
        listingId,
        acceptSigB64: acceptSig,
        attestSigB64: rc.signature,
      },
      token: cToken,
    })
    assert.strictEqual(escrow.state, 'SETTLED')

    // ========= 断言:三个新端点 + dc 统计 =========
    const conv = await a(
      '/escrows/conversation?consumer=' + consumer.address + '&listingId=' + listingId + '&sessionId=' + sessionId
    )
    assert.ok(conv.listingId === listingId, 'conv listingId')
    assert.ok(conv.sessionId === sessionId, 'conv sessionId')
    const kinds = (conv.events || []).map((e) => e.event)
    assert.ok(kinds.includes('begin-call'), 'missing begin-call: ' + kinds.join(','))
    assert.ok(kinds.includes('receipt'), 'missing receipt: ' + kinds.join(','))
    assert.ok(kinds.includes('settle'), 'missing settle: ' + kinds.join(','))
    assert.ok(conv.dc && conv.dc.kxA >= 1, 'dc kxA missing')
    assert.ok(conv.dc && conv.dc.kxB >= 1, 'dc kxB missing')
    assert.ok(conv.dc && conv.dc.frames[0] > 0, 'dc frames[0] zero')
    assert.ok(conv.dc && conv.dc.bytes > 0, 'dc bytes zero')
    assert.strictEqual(conv.dc.truncated, false, 'dc truncated')
    const tsArr = (conv.events || []).map((e) => e.ts || 0)
    assert.ok(tsArr.every((v, i) => i === 0 || tsArr[i - 1] <= v), 'events not sorted')

    const meConvs = await a('/me/conversations', { token: cToken })
    assert.ok(Array.isArray(meConvs.conversations) && meConvs.conversations.length >= 1, 'no conversations')
    const c = meConvs.conversations[0]
    assert.ok(c.listingId === listingId, 'me listing')
    assert.ok(c.sessions && c.sessions.length >= 1, 'me sessions')
    const s = c.sessions[0]
    assert.strictEqual(s.sessionId, sessionId, 'me session')
    assert.ok(s.eventCount >= 3, 'me eventCount')
    assert.ok(s.dc && s.dc.kxB >= 1, 'me dc kxB')

    const exp = await a('/me/calls/export', { token: cToken })
    assert.strictEqual(exp.exportFormat, 'meshllm-conversations-v1', 'export format')
    assert.strictEqual(exp.wallet, consumer.address, 'export wallet')
    assert.strictEqual(exp.conversations[0].sessions[0].sessionId, sessionId, 'export session')
    assert.ok(exp.conversations[0].sessions[0].dc && exp.conversations[0].sessions[0].dc.bytes > 0, 'export dc')

    console.log('[conversations-e2e] OK events=' + (conv.events || []).length + ' dc kx=' + conv.dc.kxA + '/' + conv.dc.kxB)
  } finally {
    try {
      if (ch && ch.isOpen()) ch.send('kx:' + JSON.stringify({ t: 'bye' }))
      if (ch) ch.close()
    } catch {}
    try {
      signal && signal.close()
    } catch {}
    if (agent) agent.stop()
    try {
      await a('/listings/' + listingId, { method: 'DELETE', token: pToken })
    } catch {}
  }
})