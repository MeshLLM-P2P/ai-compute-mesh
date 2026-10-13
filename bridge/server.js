// MeshLLM 桥接适配器 (bridge)
// ===============================================================
// 让 WorkBuddy AI(任何 OpenAI 客户端)像调用内置模型一样调用算力市场某模型,
// 但实际走 MeshLLM 真实 consumer 流程:
//   登录钱包 -> /escrow/fund -> /signal call offer -> /dc kx E2EE 握手
//   -> 加密 prompt(可多轮) -> 收 token 流 -> {t:'end'} -> 回执验签
//   -> /escrow/receipt + /escrow/settle-fast(双签) -> 还原 OpenAI 响应。
// 复用 live-consumer.js 已验证的路径, 改为可重复调用(每次请求一个独立 session)。
// 对外: 标准 OpenAI /v1/chat/completions(支持 stream), /v1/models。
// 用法: node bridge/server.js   端口见 config.json
// ===============================================================
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { WebSocket as Ws } from 'ws'

const here = path.dirname(fileURLToPath(import.meta.url))
const { api: meshApi, login: meshLogin } = await import(
  pathToFileURL(path.join(here, '..', 'agent', 'src', 'http.js'))
)
const {
  b64encode,
  b64decode,
  utf8,
  transcriptHash,
  receiptDigest,
  estimateTokens,
} = await import('@mesh/shared/protocol')
const { ed25519Verify } = await import('@mesh/shared/e2ee')
const { KxSession, encodeEncrypted, decodeEncrypted, callParams } = await import('@mesh/shared/channel')
const { openDcChannel, SignalClient } = await import('@mesh/shared/signal')

// ---------------- 配置 ----------------
const rawCfg = JSON.parse(fs.readFileSync(path.join(here, 'config.json'), 'utf8'))

// cfg.server 允许写 "host:port"(无协议); 补成完整 URL。ws 同理。
// 若值已带任何 scheme(http(s)/ws(s)/file),原样返回;否则按默认补 https://。
function withScheme(v, httpsDefault = 'https://') {
  const t = String(v || '').trim()
  if (/^[a-z][a-z0-9+.-]*:[\/\s]/i.test(t)) return t
  return httpsDefault + t
}

const CFG = {
  server: withScheme(rawCfg.server || '127.0.0.1:4011'),
  ws: withScheme(rawCfg.ws || 'wss://127.0.0.1:4011'),
  port: Number(rawCfg.port || 4021),
  listing: rawCfg.listing || '',
  fundRaw: Number(rawCfg.fundRaw || 1000000),
  turnTimeoutSec: Number(rawCfg.turnTimeoutSec || rawCfg.timeoutSec || 120),
  budgetSec: Number(rawCfg.budgetSec || 240),
  walletFile: rawCfg.walletFile ? path.resolve(here, rawCfg.walletFile) : path.join(here, 'wallet.json'),
  caCertFile: rawCfg.caCertFile
    ? path.resolve(here, rawCfg.caCertFile)
    : path.resolve(here, '../server/tls/cert.pem'),
}

const caPem = fs.existsSync(CFG.caCertFile) ? fs.readFileSync(CFG.caCertFile, 'utf8') : null

class MeshHttpError extends Error {
  constructor(status, msg) {
    super(msg)
    this.status = status
  }
}

// ---------------- 桥的 consumer 钱包(独立于市场 consumer) ----------------
function loadOrMakeWallet() {
  if (fs.existsSync(CFG.walletFile)) {
    const raw = JSON.parse(fs.readFileSync(CFG.walletFile, 'utf8'))
    const key = b64decode(raw.secretKeyB64)
    if (key.length !== 64) throw new MeshHttpError(500, 'bridge wallet 无效')
    return {
      address: bs58.encode(key.subarray(32)),
      secretKey: key,
      signMessage: (bytes) => nacl.sign.detached(new Uint8Array(bytes), key),
    }
  }
  const kp = nacl.sign.keyPair()
  const addr = bs58.encode(kp.publicKey)
  fs.writeFileSync(CFG.walletFile, JSON.stringify({ address: addr, secretKeyB64: b64encode(kp.secretKey) }, null, 2))
  try { fs.chmodSync(CFG.walletFile, 0o600) } catch {}
  console.log('[bridge] 已生成钱包: ' + addr)
  return {
    address: addr,
    secretKey: kp.secretKey,
    signMessage: (bytes) => nacl.sign.detached(new Uint8Array(bytes), kp.secretKey),
  }
}
const wallet = loadOrMakeWallet()

// ---------------- 登录(30min TTL) ----------------
let session = { token: null, ts: 0 }
async function ensureSession() {
  if (session.token && Date.now() - session.ts < 20 * 60 * 1000) return session.token
  session = { token: await meshLogin(CFG.server, wallet, caPem), ts: Date.now() }
  return session.token
}
async function api(p, opts = {}) {
  return await meshApi(CFG.server, p, { token: await ensureSession(), ca: caPem, ...opts })
}

// ---------------- listing ----------------
// 注意: GET /listings/:id 返回的"裸对象"没有运行时计算的 online 字段,
//   online 只出现在 /listings 摘要(?online=1) 的 listings 项里。
//   所以判断"是否在线"必须走摘要, 不能用裸对象的 online(恒为 undefined)。
// 这样修复后:
//   - 固定 listing (bridge/config.json 的 listing): 必须出现在在线摘要里才可用,
//     否则给出明确的 listing-not-online / listing-not-found, 不会误抛。
//   - 未固定: 取第一个在线 listing。
const listingCache = new Map()

async function fetchOnlineListings() {
  const r = await api('/listings?online=1')
  const online = (r.listings || []).filter((x) => x.online && x.status === 'active')
  return online
}

async function getListing() {
  const pinned = CFG.listing
  const online = await fetchOnlineListings()
  if (online.length === 0) throw new MeshHttpError(503, 'no-online-listing')

  let listing
  if (pinned) {
    const hit = online.find((x) => x.id === pinned)
    if (hit) {
      listing = hit
    } else {
      // 明确报错:该 listing 存在但当前不在线(裸对象无 online 字段, 走摘要判断)
      const r = await api('/listings/' + pinned)
      if (r?.listing) {
        throw new MeshHttpError(503, 'listing-not-online: ' + pinned)
      }
      throw new MeshHttpError(404, 'listing-not-found: ' + pinned)
    }
  } else {
    listing = online[0]
  }
  listingCache.set(listing.id, { listing, at: Date.now() })
  listingCache.set('_last', listing.id)
  return listing
}

// ---------------- 核心: 一次 OpenAI 请求 -> 一个 MeshLLM E2EE 会话 ----------------
// 请求里的多条 user 消息 = 同一会话里的多轮 prompt(与 provider history 同步)。
// 返回最后一条 reply 作为内容 + 全量 receipt 用量。
async function runConsumer(listing, messages, { stream = false, onToken } = {}) {
  const sessionId = crypto.randomUUID()
  const params = callParams(listing)

  const userPrompts = []
  let system = ''
  for (const m of messages || []) {
    if (m?.role === 'system') system = system ? system + '\n\n' + m.content : String(m.content || '')
    if (m?.role === 'user') userPrompts.push(String(m.content ?? ''))
  }
  if (userPrompts.length === 0) userPrompts.push('你好')
  if (system) userPrompts[0] = userPrompts[0].trim() ? system + '\n\n' + userPrompts[0] : system

  const signal = new SignalClient(CFG.ws, (u) => new Ws(u, { rejectUnauthorized: false }))
  await Promise.race([
    signal.connect(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('signal-connect-timeout')), 8000)),
  ])
  await signal.join('lst:' + listing.id, { msg() {} })
  await signal.join('sess:' + sessionId, { msg() {} })

  const preKx = []
  let keys = null
  let receipt = null
  let turns = []
  let turnOpen = false
  let turnDoneResolve = null
  let kxReadyResolve = null
  let kxReadyReject = null
  const kxReadyP = new Promise((r, j) => { kxReadyResolve = r; kxReadyReject = j })
  const deadline = Date.now() + CFG.budgetSec * 1000

  // 帧链:逐帧串行「解密+处理」,保证处理序=到达序。
  // provider(agent.js)用 frameChain 串行,因为 decodeEncrypted 走 WebCrypto 是 async,
  // 若各帧并行 .then,完成顺序不保证 → 乱序 chunk 重组与 transcriptHash 失配。
  // 桥同样必须串行,否则 transcript-hash-mismatch(偶发)。
  let frameChain = Promise.resolve()

  const ch = openDcChannel({
    url: CFG.ws,
    room: 'sess:' + sessionId,
    socketFactory: (u) => new Ws(u, { rejectUnauthorized: false }),
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
      frameChain = frameChain.then(
        () => decodeEncrypted(keys.recvKey, text)
      )
        .then((frame) => {
          if (frame.t === 'token') {
            const tr = turns[turns.length - 1]
            if (tr) tr.reply += frame.chunk || ''
            if (tr === turns[turns.length - 1] && userPrompts.length - 1 === turns.length - 1 && onToken) {
              onToken({ chunk: frame.chunk || '', done: !!frame.done, lastTurn: true })
            }
            if (frame.done && turnDoneResolve) { turnDoneResolve(tr) }
          } else if (frame.t === 'receipt') {
            receipt = frame.receipt
          } else if (frame.t === 'error') {
            const err = new Error(frame.msg || 'provider-error')
            turnDoneResolve && turnDoneResolve(null)
            err.provider = true
          }
        })
        .catch((e) => {
          console.error('[bridge] frame-decrypt-failed:', e && e.message || e)
        })
    },
    onDead: () => {
      if (!receipt && !turns.some((t) => t.reply)) {
        turnDoneResolve && turnDoneResolve(null)
      }
    },
  })
  await Promise.race([ch.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('dc-join-timeout')), 10000))])

  let kx = null
  kx = new KxSession({
    sessionId,
    sign: wallet.signMessage,
    peerIdPub: bs58.decode(listing.provider),
    sendKx: (f) => ch.send('kx:' + JSON.stringify(f)),
    onReady: (k) => { keys = k; kxReadyResolve(k) },
    onFail: (e) => kxReadyReject(e),
    log: () => {},
  })
  for (const f of preKx.splice(0)) kx.handleKx(f)

  const offer = { t: 'call', listingId: listing.id, sessionId, consumerPub: wallet.address }
  const offerTimer = setInterval(() => { try { signal.sendTo('lst:' + listing.id, offer) } catch {} }, 1500)
  try {
    await Promise.race([kxReadyP, new Promise((_, rej) => setTimeout(() => rej(new Error('kx handshake timeout')), 25000))])
  } finally { clearInterval(offerTimer) }
  if (turnDoneResolve) turnDoneResolve(undefined)

  await api('/escrow/begin-call', { method: 'POST', body: { consumer: wallet.address, listingId: listing.id, sessionId } })

  const sendTurn = (text) =>
    new Promise((resolve, reject) => {
      turnDoneResolve = resolve
      turnOpen = true
      turns.push({ prompt: text, reply: '' })
      const timer = setTimeout(() => {
        if (turnOpen) { turnOpen = false; reject(new MeshHttpError(504, 'turn-timeout: 一轮 ' + CFG.turnTimeoutSec + 's 无响应')) }
      }, CFG.turnTimeoutSec * 1000)
      encodeEncrypted(keys.sendKey, { t: 'prompt', prompt: text, params })
        .then((p) => { if (ch.isOpen()) ch.send(p) })
        .catch(() => { clearTimeout(timer); reject(new MeshHttpError(502, 'encode-prompt-failed')) })
    })

  for (let i = 0; i < userPrompts.length; i++) {
    if (Date.now() >= deadline) throw new MeshHttpError(504, 'budget-timeout')
    try {
      await sendTurn(userPrompts[i])
    } catch (e) {
      cleanup(signal, ch)
      throw e
    }
  }

  // 收尾: {t:'end'} -> 最终回执
  if (turns.length > 0) {
    encodeEncrypted(keys.sendKey, { t: 'end' }).then((p) => { if (ch.isOpen()) ch.send(p) }).catch(() => {})
  }

  const rc = await new Promise((res) => {
    const timer = setInterval(() => { if (receipt) { clearInterval(timer); res(receipt) } }, 20)
    const stop = () => { clearInterval(timer); res(null) }
    // 修正: 之前写成 (budgetSec*1000 - Date.now())，因 Date.now()≈1.79e12 得出负数,
    // setTimeout 立即触发 -> 回执还没到就返回 null。改用 deadline 剩余的毫秒数。
    const delay = Math.max(0, deadline - Date.now())
    setTimeout(stop, delay)
  })
  cleanup(signal, ch)
  if (!receipt) throw new MeshHttpError(502, 'no-receipt: provider 未返回回执')

  // 本地验签(镜像 live-consumer)
  const messages2 = []
  for (const t of turns) {
    messages2.push({ role: 'user', content: t.prompt })
    messages2.push({ role: 'assistant', content: t.reply })
  }
  const myHash = await transcriptHash(sessionId, params, messages2)
  if (receipt.transcriptHash !== myHash) throw new MeshHttpError(502, 'transcript-hash-mismatch')
  const digest = await receiptDigest(receipt)
  if (!ed25519Verify(bs58.decode(listing.provider), b64decode(receipt.signature), digest)) {
    throw new MeshHttpError(502, 'receipt-signature-invalid')
  }

  // 提交回执 + 双签结算
  await api('/escrow/receipt', { method: 'POST', body: { consumer: wallet.address, listingId: listing.id, receipt } })
  const acceptSig = b64encode(await wallet.signMessage(digest))
  const { escrow } = await api('/escrow/settle-fast', {
    method: 'POST',
    body: {
      consumer: wallet.address,
      listingId: listing.id,
      acceptSigB64: acceptSig,
      attestSigB64: receipt.signature,
    },
  })
  if (escrow.state !== 'SETTLED') throw new MeshHttpError(500, 'escrow-not-settled: ' + escrow.state)

  return {
    content: turns[turns.length - 1].reply,
    receipt,
    listing,
  }
}

function cleanup(signal, ch) {
  try { if (ch?.isOpen()) ch.send('kx:' + JSON.stringify({ t: 'bye' })) } catch {}
  try { ch?.close() } catch {}
  try { signal.close() } catch {}
}

// ---------------- 初始化: 充托管 ----------------
let funded = false
async function ensureFunding(listing) {
  if (funded) return
  await api('/escrow/fund', {
    method: 'POST',
    body: { consumer: wallet.address, listingId: listing.id, amountRaw: CFG.fundRaw },
  })
  funded = true
}

// ---------------- HTTP 服务 ----------------
function sseWrite(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n')
}

async function handleCompletions(res, url, body) {
  const listing = await getListing()
  await ensureFunding(listing)

  const messages = body.messages || []
  const stream = !!body.stream
  const model = body.model || listing.model.name
  const maxTokens = listing.limits?.maxTokens

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Connection': 'keep-alive',
    })
    const chunks = { content: '', reasoning: '' }
    try {
      const r = await runConsumer(listing, messages, {
        stream: true,
        onToken: (t) => {
          chunks.content += t.chunk
          sseWrite(res, {
            id: 'chatcmpl-bridge',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', content: t.chunk }, finish_reason: null }],
          })
        },
      })
      const tokensIn = r.receipt.tokensIn
      const tokensOut = r.receipt.tokensOut
      sseWrite(res, {
        id: 'chatcmpl-bridge',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      })
      sseWrite(res, {
        id: 'chatcmpl-bridge',
        object: 'chat.completion.chunk',
        usage: { prompt_tokens: tokensIn, completion_tokens: tokensOut, total_tokens: tokensIn + tokensOut },
        choices: [],
      })
      sseWrite(res, '[DONE]')
      res.end()
    } catch (e) {
      if (res.headersSent) {
        sseWrite(res, {
          id: 'chatcmpl-bridge',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        })
        sseWrite(res, '[DONE]')
        res.end()
      } else {
        sendJson(res, e.status, { error: { message: e.message, type: 'request_error' } })
      }
    }
  } else {
    try {
      const r = await runConsumer(listing, messages, { stream: false })
      const tokensIn = r.receipt.tokensIn
      const tokensOut = r.receipt.tokensOut
      sendJson(res, 200, {
        id: 'chatcmpl-bridge-' + crypto.randomBytes(8).toString('hex'),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: r.content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: tokensIn, completion_tokens: tokensOut, total_tokens: tokensIn + tokensOut },
      })
    } catch (e) {
      sendJson(res, e.status || 500, { error: { message: e.message, type: 'request_error' } })
    }
  }
}

function sendJson(res, status, obj) {
  if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const { pathname } = url
  if (req.method === 'GET' && pathname === '/v1/models') {
    getListing()
      .then((l) =>
        sendJson(
          res,
          200,
          { object: 'list', data: [{ id: l.model.name, object: 'model', context_length: l.model?.context || 8192, created: Math.floor(Date.now()), owned_by: 'meshllm-bridge' }] }
        )
      )
      .catch((e) => sendJson(res, e.status || 500, { error: { message: e.message } }))
    return
  }
  if (req.method === 'POST' && pathname === '/v1/chat/completions') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch {}
      // 早期阶段(getListing/ensureFunding)未包 try 的 Promise rejection 不能拖崩进程
      handleCompletions(res, url, body).catch((e) => {
        console.error('[bridge] completions error: ' + (e && e.message || e))
        if (e.status !== undefined && e.status === 404) return sendJson(res, 404, { error: { message: e.message || 'not found' } })
        if (!res.headersSent) {
          sendJson(res, e.status || 500, { error: { message: (e && e.message) || 'internal error', type: 'request_error' } })
        } else {
          try { res.end() } catch {}
        }
      })
    })
    return
  }
  if (req.method === 'GET' && pathname === '/health') {
    sendJson(res, 200, { ok: true, mode: 'bridge', listing: CFG.listing || 'auto', port: CFG.port })
    return
  }
  sendJson(res, 404, { error: { message: 'not found' } })
})

server.listen(CFG.port, '0.0.0.0', () => {
  console.log('[bridge] listening on http://0.0.0.0:' + CFG.port + ' (OpenAI 兼容) -> MeshLLM ' + (CFG.listing || 'auto-listing'))
  console.log('[bridge] consumer wallet=' + wallet.address.slice(0, 8) + '...')
})