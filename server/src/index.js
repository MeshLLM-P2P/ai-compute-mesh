import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import crypto from 'node:crypto'
import express from 'express'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import { CONFIG } from './config.js'
import { createStore } from './store.js'
import { createAuth } from './auth.js'
import { createDirectory, HttpError } from './directory.js'
import { createEscrow, EscrowError } from './escrow.js'
import { mockLlmRouter } from './mockllm.js'
import {
  AGENT_CONFIG_PATH,
  AGENT_DEFAULTS,
  PROJECT_ROOT,
  readAgentConfig,
  writeAgentConfig,
  autostartStatus,
  applyAutostart,
} from './autostart.js'

const store = createStore(CONFIG.dataFile)
const auth = createAuth(store)
const directory = await createDirectory(store, CONFIG)
const escrow = createEscrow(store, CONFIG, directory.get, directory.recordCall)

const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))
// [P1 可观测] HTTP 请求日志:method/path/status/耗时。
// 跳过 /health(客户端轮询噪音);/relay 在处理器内另有上游状态+流式字节专用行。
app.use((req, _res, next) => {
  const t0 = Date.now()
  _res.on('finish', () => {
    const ms = Date.now() - t0
    if (req.path === '/health') return
    console.log('[http] ' + _res.statusCode + ' ' + req.method + ' ' + req.path.slice(0, 120) + ' ' + ms + 'ms')
  })
  // 关键: Express 中间件必须显式 next() 才会交给后续路由处理器。
  // 早期漏掉 next() 导致所有 HTTP 请求永远卡在日志中间件、无响应(登录一直"正在登录")。
  next()
})

const fail = (res, err) => {
  const status = err instanceof EscrowError ? err.status : err instanceof HttpError ? err.status : 500
  if (status >= 500) console.error('[server]', err)
  res.status(status).json({ error: err.message || 'internal' })
}

// ---- meta ---------------------------------------------------------------
app.get('/health', (req, res) =>
  res.json({ ok: true, settleMode: CONFIG.settleMode, ts: Date.now() })
)
app.get('/config', (req, res) =>
  res.json({
    settleMode: CONFIG.settleMode,
    rpcUrl: CONFIG.rpcUrl,
    usdtMint: CONFIG.usdtMint,
    usdcMint: CONFIG.usdcMint,
    programId: CONFIG.programId,
    settleWindowSec: CONFIG.settleWindowSec,
    callTimeoutSec: CONFIG.callTimeoutSec,
    defaultBondRaw: CONFIG.defaultBondRaw,
  })
)

// ---- agent config.json / 开机自启 (网页配置页) ----------------------------
// 只读写本机 agent 的配置文件;未知字段合并保留。开机自启写 Windows 启动文件夹,
// 该目录在沙箱外可能不可写:失败时仍返回生成的脚本内容,由页面提示用户手工放置。
app.get('/agent-config', auth.requireSession, (req, res) => {
  res.json({
    path: AGENT_CONFIG_PATH,
    defaults: AGENT_DEFAULTS,
    config: readAgentConfig(),
    walletAddress: req.wallet,
    projectRoot: PROJECT_ROOT,
    nodePath: process.execPath,
    autostart: autostartStatus(),
  })
})
app.post('/agent-config', auth.requireSession, (req, res, next) => {
  try {
    res.json({ config: writeAgentConfig(req.body || {}) })
  } catch (e) {
    next(e)
  }
})
app.post('/autostart', auth.requireSession, (req, res, next) => {
  try {
    const b = req.body || {}
    res.json(applyAutostart({ ...b, nodePath: b.nodePath || process.execPath }))
  } catch (e) {
    next(e)
  }
})

// ---- wallet login -------------------------------------------------------
app.get('/nonce', (req, res) => {
  const wallet = typeof req.query.wallet === 'string' ? req.query.wallet : ''
  if (!wallet) return res.status(400).json({ error: 'wallet-required' })
  res.json(auth.issueNonce(wallet))
})
app.post('/verify', (req, res) => {
  const { wallet, signature } = req.body || {}
  const r = auth.verify(wallet, signature)
  if (!r.ok) return res.status(401).json({ error: r.error })
  // 测试账户自动充值:从未有过余额的钱包(模拟账本)首次登录入账 100 USDT
  const bal = store.get('balances', {})
  if (bal[wallet] === undefined) {
    store.update('balances', (m) => {
      const o = m || {}
      if (o[wallet] === undefined) o[wallet] = CONFIG.testCreditRaw
      return o
    })
  }
  res.json({ session: r.session })
})

// ---- directory ------------------------------------------------------------
app.get('/listings', (req, res) => {
  const onlyOnline = req.query.online === '1'
  const provider = typeof req.query.provider === 'string' ? req.query.provider : null
  const model = typeof req.query.model === 'string' ? req.query.model : null
  const q = typeof req.query.q === 'string' ? req.query.q.toLowerCase() : null
  const sort = typeof req.query.sort === 'string' ? req.query.sort : null
  let out = directory.list({ onlyOnline, provider, model })
  // 目录搜索(P3):q 对模型名/后端/供应方做不区分大小写子串匹配
  if (q) {
    out = out.filter((l) => {
      const hay = [l.model?.name, l.backend?.url, l.provider, l.id].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }
  if (req.query.stats === '1') {
    // 在线用户数:该 listing 下"新鲜"的 IN_CALL / SETTLE_WINDOW 托管行。
    // 只统计未超协议时限的行:IN_CALL 未超 callTimeoutSec(30min 孤儿阈值),
    // SETTLE_WINDOW 未超结算窗口。陈旧孤儿行(如跨机崩溃残留)不计入,
    // 避免空闲时"在线用户"虚高(曾出现 .174 残留 IN_CALL 行卡 12h 显示 1/2)。
    const nowMs = Date.now()
    const activeByListing = {}
    const revenueByListing = {}
    const callsByListing = {}
    for (const e of Object.values(store.get('escrows', {}))) {
      let active = false
      if (e.state === 'IN_CALL' && e.call && nowMs - e.call.ts < CONFIG.callTimeoutSec * 1000)
        active = true
      else if (e.state === 'SETTLE_WINDOW' && nowMs - e.windowStartedAt < CONFIG.settleWindowSec * 1000)
        active = true
      if (active) activeByListing[e.listingId] = (activeByListing[e.listingId] || 0) + 1
      // 供应方仪表盘(P3):累计结算额 + 累计调用数(跨所有 consumer 行)
      revenueByListing[e.listingId] = (revenueByListing[e.listingId] || 0) + (e.totalSettledRaw || 0)
      callsByListing[e.listingId] = (callsByListing[e.listingId] || 0) + (e.totalCalls || 0)
    }
    const provRep = escrow.providerReputation()
    out = out.map((l) => {
      const done = directory
        .calls(l.id)
        .filter((c) => c.event === 'receipt' && c.latencyMs > 0)
        .slice(-20)
      const avgLatencyMs = done.length
        ? Math.round(done.reduce((s, c) => s + c.latencyMs, 0) / done.length)
        : null
      const tpsSamples = done.filter((c) => c.tokensOut > 0)
      const avgTps = tpsSamples.length
        ? Math.round(
            (tpsSamples.reduce((s, c) => s + (c.tokensOut * 1000) / c.latencyMs, 0) /
              tpsSamples.length) *
              10
          ) / 10
        : null
      const pr = provRep[l.provider]
      return {
        ...l,
        activeUsers: activeByListing[l.id] || 0,
        stats: { avgLatencyMs, avgTps, samples: done.length },
        revenueRaw: revenueByListing[l.id] || 0,
        totalCalls: callsByListing[l.id] || 0,
        providerRep: pr
          ? {
              calls: pr.calls,
              settled: pr.settled,
              disputes: pr.disputes,
              disputesLost: pr.disputesLost,
              settleRate: pr.calls > 0 ? pr.settled / pr.calls : null,
            }
          : null,
      }
    })
  }
  // 目录排序(P3):price(输入价升序)/rating(结算率降序)/latency(升序)/tps(降序)/calls(降序)
  if (sort) {
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null)
    const cmp = {
      price: (a, b) => (num(a.pricing?.per1kInputRaw) ?? Infinity) - (num(b.pricing?.per1kInputRaw) ?? Infinity),
      rating: (a, b) => (num(a.providerRep?.settleRate) ?? -1) - (num(b.providerRep?.settleRate) ?? -1),
      latency: (a, b) => (num(a.stats?.avgLatencyMs) ?? Infinity) - (num(b.stats?.avgLatencyMs) ?? Infinity),
      tps: (a, b) => (num(b.stats?.avgTps) ?? -1) - (num(a.stats?.avgTps) ?? -1),
      calls: (a, b) => (num(b.totalCalls) ?? 0) - (num(a.totalCalls) ?? 0),
    }[sort]
    if (cmp) out = [...out].sort(cmp)
  }
  res.json({ listings: out })
})
app.get('/listings/:id', (req, res) => {
  const l = directory.get(req.params.id)
  if (!l) return res.status(404).json({ error: 'not-found' })
  res.json({ listing: l })
})
app.post('/listings', auth.requireSession, async (req, res, next) => {
  try {
    const { listing, signature } = req.body || {}
    const saved = await directory.upsertSigned({ listing, signatureB64: signature, wallet: req.wallet })
    res.json({ listing: saved })
  } catch (e) {
    next(e)
  }
})
app.post('/presence', auth.requireSession, (req, res) => {
  const { listingId } = req.body || {}
  if (!listingId) return res.status(400).json({ error: 'listingId-required' })
  directory.presence(req.wallet, listingId)
  res.json({ ok: true, ts: Date.now() })
})
// 显式下线:agent 停止后立即清除 presence,不等 TTL 衰减
// (否则 UI 的 8s 轮询会看到"仍在线"的旧 presence,把徽章翻回已上线)。
// 常规调用用 x-mesh-session header;页面刷新/关闭时 navigator.sendBeacon
// 无法携带自定义 header,允许 session/listingId 走 query 参数。
app.post('/presence/offline', (req, res, next) => {
  try {
    const token =
      req.headers['x-mesh-session'] ||
      (typeof req.query.session === 'string' ? req.query.session : null)
    const wallet = token ? auth.resolveWallet(token) : null
    if (!wallet) return res.status(401).json({ error: 'session-required' })
    const listingId = (req.body && req.body.listingId) || req.query.listingId
    if (!listingId) return res.status(400).json({ error: 'listingId-required' })
    directory.offline(wallet, listingId)
    res.json({ ok: true, ts: Date.now() })
  } catch (e) {
    next(e)
  }
})
app.get('/listings/:id/calls', (req, res) => {
  res.json({ calls: directory.calls(req.params.id) })
})
app.delete('/listings/:id', auth.requireSession, (req, res, next) => {
  try {
    directory.del(req.wallet, req.params.id)
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})
// ---- reviews / 留言 -------------------------------------------------------
app.get('/listings/:id/reviews', (req, res) => {
  res.json({ reviews: directory.reviews(req.params.id) })
})
app.post('/listings/:id/reviews', auth.requireSession, (req, res, next) => {
  try {
    const review = directory.addReview(req.wallet, req.params.id, (req.body || {}).body)
    res.json({ review })
  } catch (e) {
    next(e)
  }
})

// ---- my balance (sim ledger) ----------------------------------------------
app.get('/me/balance', auth.requireSession, (req, res) => {
  const frozenRaw = Object.values(store.get('escrows', {}))
    .filter((e) => e.consumer === req.wallet)
    .filter((e) => ['FUNDED', 'IN_CALL', 'SETTLE_WINDOW', 'DISPUTED'].includes(e.state))
    .reduce((s, e) => s + (e.balanceRaw || 0), 0)
  const balanceRaw = store.get('balances', {})[req.wallet] || 0
  res.json({ balanceRaw, frozenRaw, availableRaw: balanceRaw - frozenRaw })
})
// Consumer dashboard (P3): per-listing call/receipt/settle history for the
// logged-in wallet. Aggregates the escrow row (totals + last tx + receipt)
// with the per-listing call event log (receipt/settle/refund/cancel/dispute).
app.get('/me/calls', auth.requireSession, (req, res) => {
  const wallet = req.wallet
  const escrows = Object.values(store.get('escrows', {})).filter((e) => e.consumer === wallet)
  const byListing = {}
  for (const e of escrows) {
    const listing = directory.get(e.listingId)
    const events = directory.calls(e.listingId).filter((c) => c.consumer === wallet)
    byListing[e.listingId] = {
      listingId: e.listingId,
      model: listing?.model?.name || e.listingId,
      state: e.state,
      totalCalls: e.totalCalls || 0,
      totalSettledRaw: e.totalSettledRaw || 0,
      totalRefundedRaw: e.totalRefundedRaw || 0,
      lastTx: e.tx || null,
      receipt: e.receipt
        ? { tokensIn: e.receipt.tokensIn, tokensOut: e.receipt.tokensOut, tokensCache: e.receipt.tokensCache || 0 }
        : null,
      events: events.slice(-50).reverse(),
    }
  }
  const rows = Object.values(byListing).sort((a, b) => (b.lastTx?.at || 0) - (a.lastTx?.at || 0))
  res.json({ rows })
})

// ---- relay (v1) -----------------------------------------------------------
// Provider agents run in the browser; third-party OpenAI-compatible backends
// (e.g. api.tlvip.uk) usually have no CORS headers, so the browser cannot
// fetch them directly. The agent POSTs {url, method, headers, body} and this
// endpoint forwards the request and streams the response back (SSE pass-
// through). The API key travels only in the provider's browser memory and in
// the in-flight relay request; it is NOT persisted in the listing.
app.post('/relay', auth.requireSession, async (req, res) => {
  const { url, method = 'POST', headers = {}, body } = req.body || {}
  // [P1 可观测] 日志只记录上游 host+path:API key 经 headers/body 在途,绝不能入日志
  const t0 = Date.now()
  let outBytes = 0
  let dest = url
  try {
    const u = new URL(url)
    dest = u.host + (u.pathname !== '/' ? u.pathname : '')
  } catch {}
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url))
    return res.status(400).json({ error: 'url-required' })
  const ctl = new AbortController()
  // 客户端断开(关闭页签/刷新)时中止上游请求。
  // 注意:Node 20+ 中 req 的 'close' 会在请求体读完时立即触发,不能用来判断断开,
  // 改在响应端判断:finish(正常完成)之后到来的 close 是正常关闭,不中止。
  let resFinished = false
  res.on('finish', () => { resFinished = true })
  res.on('close', () => { if (!resFinished) ctl.abort() })
  try {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: ctl.signal,
    })
    res.status(r.status)
    const ct = r.headers.get('content-type')
    if (ct) res.setHeader('Content-Type', ct)
    if (r.body) {
      if (res.flushHeaders) res.flushHeaders()
      const reader = r.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const b = Buffer.from(value)
        res.write(b)
        outBytes += b.length
      }
      res.end()
    } else {
      res.end()
    }
    console.log(
      '[relay] ' + (method || 'POST') + ' ' + dest.slice(0, 120) +
      ' -> ' + r.status + ' ' + (Date.now() - t0) + 'ms ' + outBytes + ' B'
    )
  } catch (e) {
    if (res.headersSent) res.end()
    else res.status(502).json({ error: 'relay-failed: ' + e.message })
    console.log(
      '[relay] ' + (method || 'POST') + ' ' + dest.slice(0, 120) +
      ' -> error ' + (e.name || 'unknown') + ' ' + (Date.now() - t0) + 'ms ' + outBytes + ' B'
    )
  }
})

// ---- escrow (simulated ledger; devnet mode maps 1:1 to program ix) -------
app.get('/escrows', (req, res) => {
  const consumer = typeof req.query.consumer === 'string' ? req.query.consumer : ''
  if (!consumer) return res.status(400).json({ error: 'consumer-required' })
  res.json({ rows: Object.values(store.get('escrows', {})).filter((r) => r.consumer === consumer) })
})
app.get('/escrow', (req, res) => {
  const { consumer, listingId } = req.query
  if (!consumer || !listingId) return res.status(400).json({ error: 'consumer-and-listingId-required' })
  const e = escrow.get(consumer, listingId)
  if (!e) return res.status(404).json({ error: 'not-found' })
  res.json({ escrow: e })
})
// Platform fee ledger: cumulative micro-USDT from settled transactions
// (1% maintenance + 2% guarantee fund + 2% promotion per transaction).
app.get('/platform/fees', (req, res) => {
  res.json({ fees: store.get('platform', { maintenanceRaw: 0, guaranteeRaw: 0, promotionRaw: 0 }) })
})
// Consumer reputation (anti-freeloading): per-wallet call/settle/abandon
// counters derived from escrow state transitions. settleRate = settled /
// (settled + abandoned); providers use it to decide whether to accept a call.
app.get('/consumers/reputation', (req, res) => {
  const wallet = typeof req.query.wallet === 'string' ? req.query.wallet : ''
  const rep = escrow.reputation()
  if (wallet) {
    const r = rep[wallet] || { calls: 0, settled: 0, abandoned: 0, cancelled: 0, lastTs: 0 }
    const denom = r.settled + r.abandoned
    res.json({
      wallet,
      ...r,
      settleRate: denom > 0 ? r.settled / denom : null,
    })
    return
  }
  // 全量:按 (settled+abandoned) 降序,便于市场/面板展示
  const rows = Object.entries(rep)
    .map(([w, r]) => {
      const denom = r.settled + r.abandoned
      return { wallet: w, ...r, settleRate: denom > 0 ? r.settled / denom : null }
    })
    .sort((a, b) => (b.settled + b.abandoned) - (a.settled + a.abandoned))
  res.json({ rows })
})
// Provider reputation (anti-freeloading, P3): per-provider call/settle/dispute
// counters + cumulative refunded amount. settleRate = settled / calls;
// disputeLossRate = disputesLost / disputes. Consumers use it to rank listings.
app.get('/providers/reputation', (req, res) => {
  const wallet = typeof req.query.wallet === 'string' ? req.query.wallet : ''
  const rep = escrow.providerReputation()
  if (wallet) {
    const r =
      rep[wallet] ||
      { calls: 0, settled: 0, disputes: 0, disputesLost: 0, refundedRaw: 0, lastTs: 0 }
    res.json({
      wallet,
      ...r,
      settleRate: r.calls > 0 ? r.settled / r.calls : null,
      disputeLossRate: r.disputes > 0 ? r.disputesLost / r.disputes : null,
    })
    return
  }
  const rows = Object.entries(rep)
    .map(([w, r]) => ({
      wallet: w,
      ...r,
      settleRate: r.calls > 0 ? r.settled / r.calls : null,
      disputeLossRate: r.disputes > 0 ? r.disputesLost / r.disputes : null,
    }))
    .sort((a, b) => b.calls - a.calls)
  res.json({ rows })
})
const escrowPost = (fn) => async (req, res, next) => {
  try {
    res.json({ escrow: await fn({ wallet: req.wallet, ...(req.body || {}) }) })
  } catch (e) {
    next(e)
  }
}
app.post('/escrow/fund', auth.requireSession, escrowPost((b) => escrow.fund(b)))
app.post('/escrow/begin-call', auth.requireSession, escrowPost((b) => escrow.beginCall(b)))
app.post('/escrow/cancel', auth.requireSession, escrowPost((b) => escrow.cancel(b)))
app.post('/escrow/receipt', auth.requireSession, escrowPost((b) => escrow.submitReceipt(b)))
app.post('/escrow/settle-fast', auth.requireSession, escrowPost((b) => escrow.settleFast(b)))
app.post('/escrow/settle-window', auth.requireSession, escrowPost((b) => escrow.settleWindow(b)))
app.post('/escrow/refund', auth.requireSession, escrowPost((b) => escrow.refund(b)))
app.post('/escrow/dispute', auth.requireSession, escrowPost((b) => escrow.dispute(b)))
app.post('/escrow/resolve', auth.requireSession, escrowPost((b) => escrow.resolve(b)))
app.post('/escrow/withdraw', auth.requireSession, escrowPost((b) => escrow.withdraw(b)))

// bonds
app.post('/bonds', auth.requireSession, escrowPost((b) => ({ bond: escrow.postBond(b) })))
app.get('/bonds', (req, res) => {
  const { provider, listingId } = req.query
  if (!provider || !listingId) return res.status(400).json({ error: 'provider-and-listingId-required' })
  res.json({ bondRaw: escrow.bondOf(provider, listingId) })
})

// ---- 调用时间线 / 会话可观测 (P1.1) ----------------------------------------
// 数据源:目录调用日志(calls:<listingId>,按 consumer/sessionId 分组)
//        + 数据面帧统计(dcEvents:<sessionId>,持久于 store)。

function eventsMaxTs(evs) {
  let m = 0
  for (const e of evs) if (e && typeof e.ts === 'number' && e.ts > m) m = e.ts
  return m
}

// consumer+listing 下该 consumer 的会话分组:按 sessionId 聚合(历史无 sessionId 事件归 null 组)
function sessionsByConsumerListing(wallet, listingId) {
  const bySession = new Map()
  for (const e of directory.calls(listingId).filter((c) => c && c.consumer === wallet)) {
    const k = e.sessionId || null
    if (!bySession.has(k)) bySession.set(k, [])
    bySession.get(k).push(e)
  }
  return Array.from(bySession.entries()).sort((a, b) => eventsMaxTs(b[1]) - eventsMaxTs(a[1]))
}

function conversationsForWallet(wallet) {
  const all = store.get('escrows', {})
  const liveMap = {}
  for (const e of Object.values(all)) {
    if (e && e.consumer === wallet && !e.archived) liveMap[e.listingId] = e
  }
  const out = []
  for (const listingId of Object.keys(liveMap)) {
    const live = liveMap[listingId]
    const listing = directory.get(listingId)
    const sessions = sessionsByConsumerListing(wallet, listingId)
    out.push({
      listingId,
      model: listing ? listing.model.name : null,
      liveState: live.state,
      balanceRaw: live.balanceRaw || 0,
      totalCalls: live.totalCalls || 0,
      totalSettledRaw: live.totalSettledRaw || 0,
      lastEventTs: Math.max(live.lastEvent ? live.lastEvent : 0, ...sessions.map(([, evs]) => eventsMaxTs(evs))),
      sessions: sessions.map(([sessionId, evs]) => {
        const dc = dcSessionSummary(sessionId)
        return {
          sessionId: sessionId || null,
          beganTs: evs.length ? evs[0].ts : null,
          endedTs: eventsMaxTs(evs),
          eventCount: evs.length,
          lastEvent: evs.length ? evs[evs.length - 1].event : null,
          dc,
        }
      }),
    })
  }
  out.sort((a, b) => (b.lastEventTs || 0) - (a.lastEventTs || 0))
  return out
}

// 单会话详细时间线(单点查询:Market 会话卡片 / EscrowPanel 行)
// 注意:与 /listings/:id/calls 一致,目录事件对客户端公开,dc 统计仅计数,无敏感信息
app.get('/escrows/conversation', (req, res) => {
  const consumer = typeof req.query.consumer === 'string' ? req.query.consumer : ''
  const listingId = typeof req.query.listingId === 'string' ? req.query.listingId : ''
  const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId ? req.query.sessionId : null
  if (!consumer || !listingId)
    return res.status(400).json({ error: 'consumer-and-listingId-required' })
  const row = store.get('escrows', {})[consumer + '|' + listingId] || null
  const listing = directory.get(listingId)
  const events = directory
    .calls(listingId)
    .filter((e) => e && e.consumer === consumer)
    .filter((e) => (sessionId === null ? true : e.sessionId === sessionId))
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
  res.json({
    listingId,
    sessionId: sessionId || null,
    model: listing ? listing.model.name : null,
    row: row || null,
    events,
    dc: dcSessionSummary(sessionId),
  })
})

// 当前钱包全部会话(汇总,按 listing 分组)
app.get('/me/conversations', auth.requireSession, (req, res) => {
  res.json({ conversations: conversationsForWallet(req.wallet) })
})

// 全量导出:汇总视图(含全部会话 + 各自 dc 统计),JSON 下载
app.get('/me/calls/export', auth.requireSession, (req, res) => {
  const convs = conversationsForWallet(req.wallet)
  res.json({
    exportFormat: 'meshllm-conversations-v1',
    wallet: req.wallet,
    generatedAt: Date.now(),
    conversations: convs,
  })
})

// ---- mock LLM (provider backend for the demo) ---------------------------
app.use('/mock-llm', mockLlmRouter())

app.use((err, req, res, next) => fail(res, err))

// ---- signaling (stateless room relay over WS /signal) --------------------
// Rooms:
//   lst:<listingId>   provider agent joins to receive {t:'call'} offers
//   sess:<sessionId>  both peers join for {t:'sdp'|'ice'|'bye'}
// 有自签证书走 HTTPS/WSS(浏览器安全上下文 → crypto.subtle 可用),否则退回纯 HTTP
const useTls =
  fs.existsSync(CONFIG.tlsKeyPath) && fs.existsSync(CONFIG.tlsCertPath)
const server = useTls
  ? https.createServer(
      { key: fs.readFileSync(CONFIG.tlsKeyPath), cert: fs.readFileSync(CONFIG.tlsCertPath) },
      app
    )
  : http.createServer(app)
// noServer 模式 + 手动 upgrade 路由:两个 path 模式的 WebSocketServer 共用
// 同一个 http server 时,先注册者会对另一路径的 upgrade 回 400 并销毁 socket,
// 后注册者永远收不到连接。这里由唯一 upgrade 监听器按路径分发。
const wss = new WebSocketServer({ noServer: true })
const rooms = new Map()

function joinRoom(ws, room) {
  if (!ws.__rooms) ws.__rooms = new Set()
  ws.__rooms.add(room)
  if (!rooms.has(room)) rooms.set(room, new Set())
  rooms.get(room).add(ws)
}
function leaveRoom(ws) {
  if (!ws.__rooms) return
  for (const r of ws.__rooms) {
    const set = rooms.get(r)
    if (set) {
      set.delete(ws)
      if (set.size === 0) rooms.delete(r)
    }
  }
  ws.__rooms = new Set()
}
function broadcast(room, msg, except) {
  const set = rooms.get(room)
  if (!set) return
  const payload = JSON.stringify(msg)
  for (const peer of set) {
    if (peer === except) continue
    if (peer.readyState === 1) peer.send(payload)
  }
}

wss.on('connection', (ws) => {
  console.log('[signal] ws connected (total ' + wss.clients.size + ')')
  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (!msg || typeof msg.t !== 'string') return
    if (msg.t === 'join') {
      if (typeof msg.room !== 'string' || msg.room.length > 128) return
      if (msg.room.startsWith('sess:') && (rooms.get(msg.room) || new Set()).size >= 2) {
        // sess:<id> 严格两方:陈旧第三方连接不真正加入(回一个 joined 让对端
        // join() 不挂死;它后续发往该房间的控制帧会被成员校验丢弃)
        console.log('[signal] reject 3rd member ' + msg.room.slice(0, 18) + ' (stale connection, not joined)')
        ws.send(JSON.stringify({ t: 'joined', room: msg.room }))
        return
      }
      joinRoom(ws, msg.room)
      // [临时诊断] 重连后可据此确认 agent 是否重新进了 lst:<id> 房间
      console.log('[signal] join ' + msg.room.slice(0, 18) + ' members=' + rooms.get(msg.room).size)
      ws.send(JSON.stringify({ t: 'joined', room: msg.room }))
      return
    }
    if (msg.t === 'call') {
      // consumer -> provider agent: forward to the listing room
      if (typeof msg.sessionId !== 'string' || !/^[a-f0-9-]{16,64}$/.test(msg.sessionId)) return
      const listingId = msg.listingId
      if (!listingId) return
      const recipients = Math.max(0, (rooms.get('lst:' + listingId) || new Set()).size - 1)
      broadcast('lst:' + listingId, msg, ws)
      // [临时诊断] recipients=0 说明没有任何 agent 在该 listing 房间
      console.log('[signal] call -> lst:' + String(listingId).slice(0, 12) + ' recipients=' + recipients)
      return
    }
    if (msg.t === 'sdp' || msg.t === 'ice' || msg.t === 'bye') {
      // session-room traffic: sender must be a member of the named room
      if (!msg.room || !msg.room.startsWith('sess:')) return
      if (!ws.__rooms || !ws.__rooms.has(msg.room)) return
      broadcast(msg.room, msg, ws)
      // sdp/ice 每 500ms 重广播,逐条打会刷屏;只在 bye(会话结束)时记录
      if (msg.t === 'bye') console.log('[signal] bye -> ' + msg.room.slice(0, 18))
      return
    }
  })
  ws.on('close', () => {
    console.log('[signal] ws closed')
    leaveRoom(ws)
  })
  ws.on('error', () => leaveRoom(ws))
})

// ---- data channel (raw frame relay over WS /dc) ---------------------------
// kx 帧与加密业务帧走的专用通道:服务器只把字节在两名成员之间原样互转,
// 从不解析 E2EE(kx 帧本身公开,业务帧是 AES-256-GCM 密文)。
// 房间表与 /signal 分离,避免 JSON 广播串进 /dc 套接字。
// 首个帧必须是 {t:'join', room:'sess:<id>'} → 回 {t:'joined', room};
// 之后帧原样转发给同房间的其他成员。
const dcWss = new WebSocketServer({ noServer: true })
const dcRooms = new Map()
// [P1 可观测] 数据面会话帧统计:dcEvents:<sessionId> 持久化(每会话环限 400 条),
// 记录 kx 握手帧(明文可归因)与业务帧(密文,仅计数/计字节)+ 成员级帧数/字节数。
const DC_EVENT_CAP = 400
const dcSessions = new Map() // sessionId -> { joinedAt, members: [{n,id,frames,bytes,firstTs,lastTs}], kxA, kxB }
function recordDcEvent(sessionId, entry) {
  if (!sessionId) return
  const k = 'dcEvents:' + sessionId
  store.update(k, (arr) => [...(Array.isArray(arr) ? arr : []), entry].slice(-DC_EVENT_CAP))
}
function dcSessionSummary(sessionId) {
  if (!sessionId) return null
  const evs = store.get('dcEvents:' + sessionId)
  if (!Array.isArray(evs)) return null
  let frames = [0, 0], bytes = 0, kxA = 0, kxB = 0, durMs = null
  let firstTs = null, lastTs = null
  for (const e of evs) {
    const ts = e && e.ts
    if (typeof ts === 'number') {
      if (firstTs == null || ts < firstTs) firstTs = ts
      if (lastTs == null || ts > lastTs) lastTs = ts
    }
    if (e && e.t === 'leave' && e.summary) {
      frames = Array.isArray(e.summary.frames) ? e.summary.frames.slice(0, 2) : frames
      bytes = typeof e.summary.bytes === 'number' ? e.summary.bytes : bytes
      kxA = typeof e.summary.kxA === 'number' ? e.summary.kxA : kxA
      kxB = typeof e.summary.kxB === 'number' ? e.summary.kxB : kxB
      durMs = typeof e.summary.durMs === 'number' ? e.summary.durMs : durMs
    } else if (e && e.t === 'kx-a') {
      kxA++
    } else if (e && e.t === 'kx-b') {
      kxB++
    } else if (e && typeof e.s === 'number' && e.s >= 0) {
      const i = Math.min(Math.max(1, e.n || 1) - 1, 1)
      frames[i]++
      bytes += e.s
    }
  }
  return {
    count: evs.length,
    truncated: evs.length >= DC_EVENT_CAP,
    frames,
    bytes,
    kxA,
    kxB,
    durMs,
    firstTs,
    lastTs,
  }
}

// 唯一的 upgrade 分发器:/signal 走 wss(信令 JSON),/dc 走 dcWss(原始帧)
server.on('upgrade', (req, socket, head) => {
  let pathname = req.url
  const q = req.url.indexOf('?')
  if (q !== -1) pathname = req.url.slice(0, q)
  if (pathname === '/signal') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    return
  }
  if (pathname === '/dc') {
    dcWss.handleUpgrade(req, socket, head, (ws) => dcWss.emit('connection', ws, req))
    return
  }
  socket.destroy()
})

dcWss.on('connection', (ws) => {
  ws.__dcRoom = null
  ws.on('message', (raw, isBinary) => {
    if (!ws.__dcRoom) {
      let m
      try {
        m = JSON.parse(raw.toString())
      } catch {
        // 首帧必须是 join JSON;非 JSON 直接断开,不留僵尸连接
        ws.close()
        return
      }
      if (
        !m ||
        m.t !== 'join' ||
        typeof m.room !== 'string' ||
        !m.room.startsWith('sess:') ||
        m.room.length > 128
      ) {
        ws.close()
        return
      }
      ws.__dcRoom = m.room
      if (!dcRooms.has(m.room)) dcRooms.set(m.room, new Set())
      const set = dcRooms.get(m.room)
      if (set.size >= 2) {
        // sess 房间严格两方(consumer+provider):第三方连接是陈旧连接
        // (旧页面未刷新,其 provider/consumer 流程看到 offer 后会自动加入新
        //  session 房间),第三方的 kx-a 会反复重置对端 epk 导致握手永远完不成
        console.log('[dc] reject 3rd member ' + m.room.slice(0, 18) + ' (stale connection, closed)')
        ws.close()
        return
      }
      set.add(ws)
      // [P1 可观测] 会话成员入帧统计
      const sessionId = m.room.slice(5)
      let st = dcSessions.get(sessionId)
      if (!st) {
        st = { joinedAt: Date.now(), members: [], kxA: 0, kxB: 0 }
        dcSessions.set(sessionId, st)
      }
      const n = st.members.length + 1
      const id = crypto.randomBytes(4).toString('hex')
      st.members.push({ n, id, frames: 0, bytes: 0, firstTs: 0, lastTs: 0 })
      ws.__dcMember = st.members[n - 1]
      console.log('[dc] join ' + sessionId + ' member=' + n + '/2')
      recordDcEvent(sessionId, { t: 'join', ts: Date.now(), n, id })
      ws.send(JSON.stringify({ t: 'joined', room: m.room }))
      return
    }
    // join 之后:原样转发原始帧给同房间其他成员。
    // 关键:ws 包把文本帧也交给 Buffer,直接 peer.send(Buffer) 会把它当成
    // 二进制帧转发 —— 浏览器端收到的是 Blob,toText 解不出 'kx:' 前缀,所有
    // kx 帧被丢弃,握手永远完不成(node 端 Buffer 能解,故 node 自调用测试绿、
    // 浏览器 consumer 必挂)。按 isBinary 保真转发:文本帧转回字符串再 send,
    // 二进制帧原样 send Buffer。
    // [P1 可观测] 帧分类统计:kx 帧明文归因握手阶段,业务帧 b64 密文仅计数/计字节
    const sessionId = ws.__dcRoom ? ws.__dcRoom.slice(5) : null
    const st = sessionId ? dcSessions.get(sessionId) : null
    const me = ws.__dcMember
    if (st && me) {
      me.frames++
      me.bytes += raw.length
      if (!me.firstTs) me.firstTs = Date.now()
      me.lastTs = Date.now()
    }
    const text = isBinary ? null : raw.toString('utf8')
    let kind = 'biz'
    if (text) {
      let f = null
      if (text.startsWith('kx:')) {
        try { f = JSON.parse(text.slice(3)) } catch {}
        if (f && f.t === 'kx-a') kind = 'kx-a'
        else if (f && f.t === 'kx-b') kind = 'kx-b'
      } else {
        let m2 = null
        try { m2 = JSON.parse(text) } catch {}
        if (m2 && typeof m2.t === 'string' && m2.t !== 'joined') kind = m2.t
      }
    }
    if (st && kind === 'kx-a') {
      st.kxA++
      console.log('[dc] ' + sessionId + ' kx-a #' + (me ? me.n : '?'))
    } else if (st && kind === 'kx-b') {
      st.kxB++
      console.log('[dc] ' + sessionId + ' kx-b #' + (me ? me.n : '?'))
    }
    if (sessionId) recordDcEvent(sessionId, { t: kind, ts: Date.now(), n: me ? me.n : 1, s: raw.length })
    const set = dcRooms.get(ws.__dcRoom)
    if (!set) return
    for (const peer of set) {
      if (peer === ws) continue
      if (peer.readyState === 1) {
        if (isBinary) peer.send(raw)
        else peer.send(raw.toString('utf8'))
      }
    }
  })
  const leaveDc = () => {
    if (!ws.__dcRoom) return
    const sessionId = ws.__dcRoom.slice(5)
    const me = ws.__dcMember
    if (me) me.lastTs = Date.now()
    // [P1 可观测] 会话收尾:最后一名成员离开时落盘帧统计摘要
    const set = dcRooms.get(sessionId)
    if (set) {
      set.delete(ws)
      const st = dcSessions.get(sessionId)
      if (st && set.size === 0) {
        const durMs = Date.now() - st.joinedAt
        const summary = {
          frames: st.members.map((m) => (m ? m.frames : 0)).slice(0, 2),
          bytes: st.members.reduce((s, m) => (s + (m ? m.bytes : 0)), 0),
          kxA: st.kxA || 0,
          kxB: st.kxB || 0,
          durMs,
        }
        recordDcEvent(sessionId, { t: 'leave', ts: Date.now(), summary })
        console.log(
          '[dc] ' + sessionId + ' done frames=[' + summary.frames.join('/') +
          '] ' + Math.round(summary.bytes / 1024) + 'KB kx=' + summary.kxA + '/' + summary.kxB +
          ' dur=' + Math.round(durMs / 1000) + 's'
        )
        dcSessions.delete(sessionId)
      }
      if (set.size === 0) dcRooms.delete(sessionId)
    }
    console.log('[dc] left ' + ws.__dcRoom.slice(0, 18))
    ws.__dcRoom = null
    ws.__dcMember = null
  }
  ws.on('close', leaveDc)
  ws.on('error', leaveDc)
})

// ---- 孤儿 IN_CALL 行周期清理 ---------------------------------------------
// consumer 崩溃/断网/跨机重启会留下卡死的 IN_CALL 行(曾出现 .174 残留行卡
// 12h,使"在线用户"虚高、并发槽被占)。每 60s 扫描:IN_CALL 且超过
// callTimeoutSec(30min)的行必然已死(consumer 单轮 300s 超时早已失效),
// 释放回 FUNDED(保留余额,可继续充值/调用)。SETTLE_WINDOW 不自动释放:
// provider 仍可在窗口过后单签结算(settleWindow),强放会丢结算。
setInterval(() => {
  try {
    const nowMs = Date.now()
    const limit = CONFIG.callTimeoutSec * 1000
    const stale = []
    store.update('escrows', (m) => {
      for (const e of Object.values(m || {})) {
        if (e.state === 'IN_CALL' && e.call && nowMs - e.call.ts > limit) {
          const ageMin = Math.round((nowMs - e.call.ts) / 60000)
          e.call = null
          e.state = 'FUNDED'
          e.lastEvent = nowMs
          stale.push(e.consumer)
          console.log(
            '[escrow] released stale IN_CALL ' +
              e.listingId.slice(0, 10) + ' consumer=' + e.consumer.slice(0, 8) +
              ' (age ' + ageMin + 'min > ' + Math.round(CONFIG.callTimeoutSec / 60) + 'min)'
          )
        }
      }
      return m
    })
    // 消费者失联导致调用烂尾:计入白嫖信号(信誉系统)
    for (const c of stale) escrow.noteEvent(c, 'abandoned')
  } catch (e) {
    console.error('[escrow] cleanup failed:', e.message)
  }
}, 60000)

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(
    `[meshllm] server on ${useTls ? 'https' : 'http'}://${CONFIG.host}:${CONFIG.port} (settleMode=${CONFIG.settleMode}${useTls ? ', tls=self-signed' : ''})`
  )
})
