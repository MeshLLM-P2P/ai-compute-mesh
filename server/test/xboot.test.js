// 跨 bootstrap 调用端到端(路 2:全网跨网段互联)。
//
// A = https://127.0.0.1:4011(consumer 的家 bootstrap,dev server)
// B = http://127.0.0.1:4022 (provider 的家 bootstrap,测试子进程,无 TLS)
//
// 验证链路(与 web 前端的新流程完全一致):
//   1. provider 在 B 发布 echo listing 并起 Node agent 接单
//   2. A 经 bootstrap 联邦拉取 → 市场(/listings?online=1)出现远程 listing,
//      带 federated=true + origin=B
//   3. consumer 在 A 发现模型,但登录/托管充值/锁定/信令/数据通道/结算
//      全部连 B —— provider agent 零改动(offer 到达 B 的 lst 房间即接单)
//   4. 回执经 /dc(B)到达,consumer 验签 + 双签,escrow 在 B 的账本上 SETTLED;
//      A 的账本没有这笔托管行(数据与账本都留在 provider 的家 bootstrap)
//
// 对 A 不可达时自跳过(与 e2e-echo 一致)。
import test from 'node:test'
import assert from 'node:assert'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const nacl = require('tweetnacl')
const bs58 = require('bs58')

const A_BASE = 'https://127.0.0.1:4011'
const B_PORT = Number(process.env.XBOOT_B_PORT || 4022)
const B_BASE = 'http://127.0.0.1:' + B_PORT
const B_WS = 'ws://127.0.0.1:' + B_PORT

// A 自签证书:运行时 NODE_EXTRA_CA_CERTS 对内置 fetch 无效,显式传 ca(PEM)
const CERT = path.resolve(import.meta.dirname, '..', 'tls', 'cert.pem')
const caPem = fs.existsSync(CERT) ? fs.readFileSync(CERT, 'utf8') : null

const {
  b64encode,
  b64decode,
  hexToBytes,
  listingHashOf,
  transcriptHash,
  receiptDigest,
  estimateTokens,
  turnInputEstimate,
  calcAmountRaw,
  splitFees,
} = await import('@mesh/shared/protocol')
const { ed25519Verify } = await import('@mesh/shared/e2ee')
const { SignalClient, openDcChannel } = await import('@mesh/shared/signal')
const { KxSession, encodeEncrypted, decodeEncrypted, callParams } = await import('@mesh/shared/channel')
const { api: rawApi, login } = await import('../../agent/src/http.js')
const { startNodeAgent } = await import('../../agent/src/agent.js')

const aA = (p, o = {}) => rawApi(A_BASE, p, { ...o, ca: caPem })
const aB = (p, o = {}) => rawApi(B_BASE, p, o) // B 无 TLS
const socketFactory = (u) => new WebSocket(u, { rejectUnauthorized: false })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const timeout = (ms, label) => sleep(ms).then(() => new Error('timeout: ' + label))

function makeWallet() {
  const kp = nacl.sign.keyPair()
  return {
    address: bs58.encode(kp.publicKey),
    secretKey: kp.secretKey,
    signMessage: (bytes) => nacl.sign.detached(new Uint8Array(bytes), kp.secretKey),
  }
}

// 拉起第二个 bootstrap(独立 data.json,禁用 TLS → 纯 http 端口)
function startBootstrapB() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xboot-'))
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      MESH_PORT: String(B_PORT),
      MESH_HOST: '127.0.0.1',
      MESH_DATA_FILE: path.join(dir, 'data.json'),
      // 指向不存在的文件 → useTls=false(纯 http)
      MESH_TLS_KEY: path.join(dir, 'none.key'),
      MESH_TLS_CERT: path.join(dir, 'none.crt'),
      MESH_SELF_URL: B_BASE,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let bootErr = ''
  child.stderr.on('data', (c) => {
    bootErr += c
  })
  return {
    child,
    dir,
    kill() {
      try {
        child.kill()
      } catch {}
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    },
    bootLog: () => bootErr,
  }
}

test('跨 bootstrap 调用:federated 发现 → 远程 escrow/信令/数据通道 → 双签结算', async (t) => {
  // ---- 前置:A 可达性 ----
  try {
    await aA('/health')
  } catch {
    return t.skip('server on :4011 unreachable')
  }

  const B = startBootstrapB()
  t.after(() => B.kill())

  // 等 B 就绪(health 轮询)
  const deadline = Date.now() + 15000
  let bUp = false
  while (Date.now() < deadline) {
    try {
      await aB('/health')
      bUp = true
      break
    } catch {
      await sleep(300)
    }
  }
  assert.ok(bUp, 'B bootstrap 启动超时:' + B.bootLog().slice(-300))

  const provider = makeWallet()
  const consumer = makeWallet()

  // ---- 1. provider 在 B 发布 echo listing(独立账本,自动 100 USDT 测试余额) ----
  const pToken = await login(B_BASE, provider)
  const payload = {
    provider: provider.address,
    p2pPublicKey: provider.address,
    model: { name: 'echo-xboot-' + Date.now(), context: 8192, modalities: ['text'] },
    pricing: {
      currency: 'USDT',
      per1kInputRaw: 5000,
      per1kOutputRaw: 15000,
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
  const { listing } = await aB('/listings', {
    method: 'POST',
    body: { listing: { ...payload, id: listingId }, signature },
    token: pToken,
  })
  assert.ok(listing, 'B 上 listing 发布失败')

  // ---- 2. consumer 在 A 登录(发现侧),A 联邦拉取 B ----
  const cTokenA = await login(A_BASE, consumer, caPem)
  const fed = await aA('/federation', {
    method: 'POST',
    body: { bootstraps: [B_BASE] },
    token: cTokenA,
  })
  const pulled = (fed.pulled || []).find((r) => r.bootstrap === B_BASE)
  assert.ok(pulled && pulled.ok, 'A 拉取 B 失败:' + JSON.stringify(fed.pulled))
  assert.ok((pulled.listings || 0) >= 1, 'A 未拉到 B 的 listing')

  const market = await aA('/listings?online=1')
  const remote = (market.listings || []).find((l) => l.id === listingId)
  assert.ok(remote, 'A 的市场应出现 B 的远程 listing')
  assert.strictEqual(remote.federated, true, '远程 listing 应带 federated 标记')
  assert.strictEqual(remote.origin, B_BASE, 'origin 应为 provider 的家 bootstrap(B)')
  assert.strictEqual(remote.online, true, '远程 listing 应为在线')
  // B 自己的视图不受联邦污染(回环防护:B 没有上游,listings 只有本地 1 个)
  const bMarket = await aB('/listings?online=1')
  assert.strictEqual((bMarket.listings || []).length, 1, 'B 的市场只应有本地 listing')

  // ---- 3. consumer 在 B 登录(跨 bootstrap 会话:签名不变,token 由 B 签发) ----
  const cTokenB = await login(B_BASE, consumer)

  // 托管充值 + Node agent(全部在 B 上)
  const fundAmount = 1000000 // 1 USDT
  await aB('/escrow/fund', {
    method: 'POST',
    body: { consumer: consumer.address, listingId, amountRaw: fundAmount },
    token: cTokenB,
  })

  let agent = null
  let signal = null
  let ch = null
  let kx = null
  let receipt = null
  const turns = []

  try {
    agent = startNodeAgent({
      wsBase: B_WS,
      listing,
      wallet: provider,
      apiKey: '',
      env: { serverBase: B_BASE, allowRelay: false },
      log: (s) => console.log('[xboot-agent] ' + s),
    })

    // ---- consumer 侧:信令 + /dc + kx,全部连 B ----
    const sessionId = crypto.randomUUID()
    const params = callParams(listing)
    signal = new SignalClient(B_WS, socketFactory)
    await Promise.race([signal.connect(), timeout(8000, 'signal connect')])
    await signal.join('lst:' + listingId, { msg() {} })
    await signal.join('sess:' + sessionId, { msg() {} })

    const preKx = []
    let frameChain = Promise.resolve()
    let keys = null
    let turnOpen = false
    let turnDoneResolve = null
    let kxResolve = null
    let kxReject = null
    let receiptResolve = null
    const kxReadyP = new Promise((res, rej) => {
      kxResolve = res
      kxReject = rej
    })
    const receiptP = new Promise((res) => {
      receiptResolve = res
    })

    ch = openDcChannel({
      url: B_WS,
      room: 'sess:' + sessionId,
      socketFactory,
      log: (s) => console.log('[xboot-dc] ' + s),
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
                if (receiptResolve) receiptResolve(receipt)
              }
            })
            .catch(() => {})
        )
      },
      onDead: () => {},
    })
    await Promise.race([ch.ready, timeout(10000, 'dc join')])

    kx = new KxSession({
      sessionId,
      sign: consumer.signMessage,
      peerIdPub: bs58.decode(listing.provider),
      sendKx: (f) => ch.send('kx:' + JSON.stringify(f)),
      onReady: (k) => {
        keys = k
        kxResolve(k)
      },
      onFail: (e) => kxReject(e),
      log: () => {},
    })
    for (const f of preKx.splice(0)) kx.handleKx(f)

    const offer = { t: 'call', listingId, sessionId, consumerPub: consumer.address }
    const offerTimer = setInterval(() => {
      try {
        signal.sendTo('lst:' + listingId, offer)
      } catch {}
    }, 1500)
    signal.sendTo('lst:' + listingId, offer)
    try {
      await Promise.race([kxReadyP, timeout(25000, 'kx')])
    } finally {
      clearInterval(offerTimer)
    }
    assert.ok(keys, 'kx 握手未完成(跨 bootstrap 数据通道)')

    // 锁资金 + 多轮对话(与 e2e-echo 同口径)
    await aB('/escrow/begin-call', {
      method: 'POST',
      body: { consumer: consumer.address, listingId, sessionId },
      token: cTokenB,
    })

    const sendTurn = (text) => {
      const turn = { prompt: text, reply: '' }
      turns.push(turn)
      const done = new Promise((res) => {
        turnDoneResolve = res
      })
      encodeEncrypted(keys.sendKey, { t: 'prompt', prompt: text, params })
        .then((p) => ch.send(p))
        .catch(() => {})
      setTimeout(() => {
        if (turnDoneResolve) turnDoneResolve(undefined)
      }, 20000)
      return done
    }

    const t1 = await sendTurn('跨 bootstrap 调用验证:第一轮。')
    assert.ok(t1 && t1.reply.length > 0, '第一轮无回复')
    const t2 = await sendTurn('跨 bootstrap 调用验证:第二轮追问。')
    assert.ok(t2 && t2.reply.length > 0, '第二轮无回复')

    encodeEncrypted(keys.sendKey, { t: 'end' }).then((p) => ch.send(p)).catch(() => {})
    receipt = await Promise.race([receiptP, timeout(30000, 'receipt')])
    assert.ok(receipt, '未收到最终回执')

    // ---- consumer 本地复核回执(与 provider 口径一致) ----
    const messages = []
    let ti = 0
    let to = 0
    for (const turn of turns) {
      messages.push({ role: 'user', content: turn.prompt })
      ti += turnInputEstimate(messages)
      messages.push({ role: 'assistant', content: turn.reply })
      to += estimateTokens(turn.reply)
    }
    const myHash = await transcriptHash(sessionId, params, messages)
    assert.strictEqual(receipt.transcriptHash, myHash, 'transcriptHash 不一致')
    const tol = ((listing.metering && listing.metering.tolerancePct) || 5) / 100
    assert.ok(Math.abs(receipt.tokensIn - ti) <= ti * tol + 1, 'tokensIn 超出容差')
    assert.ok(Math.abs(receipt.tokensOut - to) <= to * tol + 1, 'tokensOut 超出容差')
    assert.ok(
      ed25519Verify(bs58.decode(listing.provider), b64decode(receipt.signature), await receiptDigest(receipt)),
      'provider 回执签名无效'
    )

    // ---- 4. 双签结算(全部在 B 的账本上) ----
    await aB('/escrow/receipt', {
      method: 'POST',
      body: { consumer: consumer.address, listingId, receipt },
      token: cTokenB,
    })
    const digest = await receiptDigest(receipt)
    const acceptSig = b64encode(consumer.signMessage(digest))
    const { escrow } = await aB('/escrow/settle-fast', {
      method: 'POST',
      body: {
        consumer: consumer.address,
        listingId,
        acceptSigB64: acceptSig,
        attestSigB64: receipt.signature,
      },
      token: cTokenB,
    })
    assert.strictEqual(escrow.state, 'SETTLED', 'B 上托管应为 SETTLED')
    assert.ok(escrow.tx && escrow.tx.providerRaw > 0, '结算应有分账明细')

    // A 的账本没有这笔托管行:数据与账本都留在 provider 的家 bootstrap。
    // GET /escrow 对不存在的行返回 404(not-found)—— 正好证明 A 上无此行。
    let aEsc = null
    let aEscErr = null
    try {
      aEsc = await aA('/escrow?consumer=' + consumer.address + '&listingId=' + listingId)
    } catch (e) {
      aEscErr = e.message
    }
    assert.ok(
      (aEsc && !aEsc.escrow) || /not-found/.test(aEscErr || ''),
      'A 不应有该 listing 的托管行(escrow 全在 B):' + (aEscErr || JSON.stringify(aEsc))
    )

    // provider 在 B 的余额增加(测试入账 100 USDT + 本次结算分成)
    const pBal = await aB('/me/balance', { token: pToken })
    const amountRaw = calcAmountRaw(listing.pricing, receipt.tokensIn, receipt.tokensOut, receipt.tokensCache || 0)
    const providerRaw = splitFees(amountRaw).providerRaw
    assert.ok(
      pBal.balanceRaw >= 100_000_000 + providerRaw - 1,
      'provider 余额应含结算分成:' + pBal.balanceRaw + ' vs ' + (100_000_000 + providerRaw)
    )

    console.log(
      '[xboot] SETTLED on B: amount=' + amountRaw + ' provider=' + providerRaw + ' (A 无账本行,联邦发现正常)'
    )
  } finally {
    // 清理测试联邦配置:A 不再定时拉取已消亡的 B
    try {
      await aA('/federation', { method: 'POST', body: { bootstraps: [] }, token: cTokenA })
    } catch {}
    try {
      agent && agent.stop()
    } catch {}
    try {
      ch && ch.close()
    } catch {}
    try {
      signal && signal.close()
    } catch {}
  }
})
