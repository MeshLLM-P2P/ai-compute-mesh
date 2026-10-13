// 全链路 Node e2e(新 /dc 数据面):全新 provider/consumer 钱包 → 发布 echo listing
// → Node agent 接单 → 多轮调用 → 签名回执 → 本地复核 → 双签结算。
// 对 :4011 的 dev server 运行;不可达时自跳过。
import test from 'node:test'
import assert from 'node:assert'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const nacl = require('tweetnacl')
const bs58 = require('bs58')

// 自签证书:运行时 NODE_EXTRA_CA_CERTS 对内置 fetch 无效,显式传 ca(PEM)
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
  calcAmountRaw,
  splitFees,
} = await import('@mesh/shared/protocol')
const { ed25519Verify } = await import('@mesh/shared/e2ee')
const { SignalClient, openDcChannel } = await import('@mesh/shared/signal')
const { KxSession, encodeEncrypted, decodeEncrypted, callParams } = await import('@mesh/shared/channel')
const { api: rawApi, login } = await import('../../agent/src/http.js')
const { startNodeAgent } = await import('../../agent/src/agent.js')

const BASE = 'https://127.0.0.1:4011'
const a = (p, o = {}) => rawApi(BASE, p, { ...o, ca: caPem })
const WS_BASE = 'wss://127.0.0.1:4011'
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

test('node e2e over /dc: multi-turn echo, signed receipt, dual-sign settle', async (t) => {
  // 可达性
  let up = true
  try {
    await a('/health')
  } catch {
    up = false
  }
  if (!up) return t.skip('server on :4011 unreachable')

  const provider = makeWallet()
  const consumer = makeWallet()
  const pToken = await login(BASE, provider, caPem)
  const cToken = await login(BASE, consumer, caPem)

  // ---- 发布 echo listing(全新 provider,自动 100 USDT 测试余额) ----
  const payload = {
    provider: provider.address,
    p2pPublicKey: provider.address,
    model: { name: 'echo-e2e-' + Date.now(), context: 8192, modalities: ['text'] },
    pricing: {
      currency: 'USDT',
      per1kInputRaw: 5000, // 0.005 USDT / 1k
      per1kOutputRaw: 15000, // 0.015 USDT / 1k
      per1kCacheRaw: 1000,
      minFeeRaw: 100,
    },
    limits: { maxTokens: 500, maxConcurrent: 1 },
    metering: { charsPerToken: 4, tolerancePct: 5 },
    bondUsdtRaw: 0,
    version: 1,
    backend: { type: 'echo', url: '', relay: false },
  }
  const listingId = await listingHashOf(payload)
  const signature = b64encode(provider.signMessage(hexToBytes(listingId)))
  const { listing } = await a('/listings', {
    method: 'POST',
    body: { listing: { ...payload, id: listingId }, signature },
    token: pToken,
  })

  let agent = null
  let signal = null
  let ch = null
  let kx = null
  try {
    // ---- consumer 侧:预充值托管 ----
    const fundAmount = 1000000 // 1 USDT
    await a('/escrow/fund', {
      method: 'POST',
      body: { consumer: consumer.address, listingId, amountRaw: fundAmount },
      token: cToken,
    })

    // ---- 启动 Node agent ----
    agent = startNodeAgent({
      wsBase: WS_BASE,
      listing,
      wallet: provider,
      apiKey: '',
      env: { serverBase: BASE, allowRelay: false },
      log: (s) => console.log('[e2e-agent] ' + s),
    })

    // ---- consumer 侧:信令房间 + /dc 数据通道 + kx 握手 ----
    const sessionId = crypto.randomUUID()
    const params = callParams(listing)
    signal = new SignalClient(WS_BASE, socketFactory)
    await Promise.race([signal.connect(), timeout(8000, 'signal connect')])
    await signal.join('lst:' + listingId, { msg() {} })
    await signal.join('sess:' + sessionId, { msg() {} })

    const preKx = []
    // 帧链:逐帧串行「解密+处理」,保证处理序=到达序
    let frameChain = Promise.resolve()
    let keys = null
    let receipt = null
    const turns = []
    let turnOpen = false
    let turnDoneResolve = null
    let receiptResolve = null
    let kxReadyResolve = null
    let kxReadyReject = null
    const kxReadyP = new Promise((res, rej) => {
      kxReadyResolve = res
      kxReadyReject = rej
    })
    const receiptP = new Promise((res) => {
      receiptResolve = res
    })

    ch = openDcChannel({
      url: WS_BASE,
      room: 'sess:' + sessionId,
      socketFactory,
      log: (s) => console.log('[e2e-dc] ' + s),
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
        frameChain = frameChain.then(() =>
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
              if (kxReadyReject) kxReadyReject(new Error('provider-error: ' + (frame.msg || '')))
            }
          })
          .catch(() => {})
        )
      },
      onDead: () => {},
    })
    await ch.ready

    kx = new KxSession({
      sessionId,
      sign: consumer.signMessage,
      peerIdPub: bs58.decode(listing.provider),
      sendKx: (f) => ch.send('kx:' + JSON.stringify(f)),
      onReady: (k) => {
        keys = k
        kxReadyResolve(k)
      },
      onFail: (e) => kxReadyReject(e),
      log: (s) => console.log('[e2e-kx] ' + s),
    })
    // 冲刷 join 后、握手对象建立前缓存的对端 kx 帧(放 onReady 里会死锁)
    for (const f of preKx.splice(0)) kx.handleKx(f)

    // offer 重试:agent 尚未进 lst 房间时 offer 会丢失,重试直到握手完成
    // (重复 offer 会被 agent 并发槽判 busy,无害)
    const offer = { t: 'call', listingId, sessionId, consumerPub: consumer.address }
    const offerTimer = setInterval(() => {
      try {
        signal.sendTo('lst:' + listingId, offer)
      } catch {}
    }, 1500)
    signal.sendTo('lst:' + listingId, offer)
    try {
      await Promise.race([kxReadyP, timeout(25000, 'kx handshake')])
    } finally {
      clearInterval(offerTimer)
    }

    // ---- 托管进入 IN_CALL ----
    await a('/escrow/begin-call', {
      method: 'POST',
      body: { consumer: consumer.address, listingId, sessionId },
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
              if (turnOpen) {
                turnOpen = false
                reject(new Error('turn-timeout: ' + text.slice(0, 20)))
              }
            }, 30000)
          })
          .catch(reject)
      })

    // 多轮:两轮 prompt
    const t1 = await sendTurn('你好,这是第 1 轮 e2e 测试。')
    assert.ok(t1.reply.length > 0, 'turn 1 got no reply')
    assert.ok(t1.reply.includes('You asked:'), 'echo reply unexpected')
    const t2 = await sendTurn('这是第 2 轮,请确认。')
    assert.ok(t2.reply.includes('第 2 轮'), 'turn 2 reply lost history')

    // ---- 收尾:final receipt ----
    encodeEncrypted(keys.sendKey, { t: 'end' })
      .then((p) => ch.send(p))
      .catch(() => {})
    const rc = await Promise.race([receiptP, timeout(30000, 'receipt')])

    // ---- 本地复核回执(与 provider 的 call.history 同序列重建) ----
    const messages = []
    let ti = 0
    let to = 0
    for (const tr of turns) {
      messages.push({ role: 'user', content: tr.prompt })
      ti += turnInputEstimate(messages)
      messages.push({ role: 'assistant', content: tr.reply })
      to += estimateTokens(tr.reply)
    }
    const myHash = await transcriptHash(sessionId, params, messages)
    if (myHash !== rc.transcriptHash) {
      // 安全网:帧链串行化(修复解密完成序竞态,见 PLAN.md 09/20 条目)后
      // 此分支理论上不应再触发;若复发,打印双方重建历史+token 数+哈希定位
      console.error('\n[DIAG] consumer messages:')
      for (const m of messages)
        console.error('  [' + m.role + '] ' + JSON.stringify(m.content).slice(0, 400))
      console.error('[DIAG] consumer ti=' + ti + ' to=' + to)
      console.error('[DIAG] receipt  tokensIn=' + rc.tokensIn + ' tokensOut=' + rc.tokensOut + ' tokensCache=' + rc.tokensCache)
      console.error('[DIAG] consumer myHash=' + myHash)
      console.error('[DIAG] receipt  hash  =' + rc.transcriptHash)
      console.error('[DIAG] sessionId=' + sessionId)
    }
    assert.strictEqual(rc.transcriptHash, myHash, 'transcript hash mismatch')
    const digest = await receiptDigest(rc)
    assert.ok(
      ed25519Verify(bs58.decode(listing.provider), b64decode(rc.signature), digest),
      'receipt signature invalid'
    )

    // ---- 提交回执 + 双签结算 ----
    const balBefore = await a('/me/balance', { token: pToken })
    await a('/escrow/receipt', {
      method: 'POST',
      body: { consumer: consumer.address, listingId, receipt: rc },
      token: cToken,
    })
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

    // provider 净额 = splitFees(fee).providerRaw(sim 账本立即入账)
    const fee = calcAmountRaw(listing.pricing, rc.tokensIn, rc.tokensOut, rc.tokensCache || 0)
    assert.ok(fee > 0, 'fee must be positive')
    const providerRaw = splitFees(fee).providerRaw
    const balAfter = await a('/me/balance', { token: pToken })
    const gained = (balAfter.balanceRaw || 0) - (balBefore.balanceRaw || 0)
    assert.strictEqual(gained, providerRaw, 'provider gain must equal 95% split: ' + gained + ' vs ' + providerRaw)
    console.log('[e2e] settled: fee=' + fee + ' providerRaw=' + providerRaw + ' turns=2')
  } finally {
    // 清理:关通道、停 agent、删 listing
    try {
      if (ch && ch.isOpen()) ch.send('kx:' + JSON.stringify({ t: 'bye' }))
      ch && ch.close()
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
