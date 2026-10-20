// MeshLLM 无头 provider agent(方案 C)。
// 语义:进程在跑 ∧ 模型探测健康 = 在线。不依赖浏览器登录。
//  - 采用 config.listings 里本钱包名下的 listing(继承已发布的模型/价格/版本)
//  - presence 心跳保活(服务器 presenceTtlSec 内 lastSeen 即在线)
//  - 模型探测连续失败 → 主动下线(POST /presence/offline);恢复 → 重新在线
//  - 关机(SIGINT/SIGTERM)→ 立即下线 + 关闭在途调用
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadWallet, generateWalletFile } from './wallet.js'
import { api, login } from './http.js'
import { startNodeAgent } from './agent.js'
import { probeModel } from './probe.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const cfgFile = process.env.MESH_AGENT_CONFIG || path.join(here, '..', 'config.json')
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))

const base = (cfg.tls === false ? 'http://' : 'https://') + cfg.server
const wsBase = (cfg.tls === false ? 'ws://' : 'wss://') + cfg.server
const walletFile = path.resolve(here, '..', cfg.wallet || 'wallet.json')
const wallet = fs.existsSync(walletFile) ? loadWallet(walletFile) : generateWalletFile(walletFile)

const log = (s) => console.log('[agent] ' + new Date().toISOString() + ' ' + s)

// 自签证书:运行时设置 NODE_EXTRA_CA_CERTS 对内置 fetch 无效,
// 因此把 PEM 作为 `ca` 选项显式传给所有 https 请求
let caPem = null
if (cfg.caCert) {
  const ca = path.resolve(here, '..', cfg.caCert)
  if (fs.existsSync(ca)) caPem = fs.readFileSync(ca, 'utf8')
  else log('caCert not found: ' + ca)
}
// devnet: 目标服务器自签证书的 SAN 可能未含其公网 IP(如 68.64.183.89)，
// 此时需跳过 node:https 的主机名校验。WS 数据通道本就 rejectUnauthorized:false，
// 这里保持一致。未设时继承 Node 默认(严格)。
const rejectUnauthorized = cfg.rejectUnauthorized === false ? false : undefined
log('starting server=' + cfg.server + ' wallet=' + wallet.address + ' listings=' + (cfg.listings || []).length + (rejectUnauthorized ? ' (rejectUnauthorized=false)' : ''))

// ---- 登录 / 会话管理(20 分钟主动刷新;401 立即重登) ----
let session = { token: null, ts: 0 }
async function ensureSession() {
  if (session.token && Date.now() - session.ts < 20 * 60 * 1000) return session.token
  session = { token: await login(base, wallet, caPem, { rejectUnauthorized }), ts: Date.now() }
  log('logged in (session ~30min, refresh at 20min)')
  return session.token
}
async function callApi(p, opts = {}) {
  const token = await ensureSession()
  try {
    return await api(base, p, { ...opts, token, ca: caPem, rejectUnauthorized })
  } catch (e) {
    if (/session-required|session-expired|no-session/.test(e.message)) {
      session = { token: null, ts: 0 }
      const t2 = await ensureSession()
      return api(base, p, { ...opts, token: t2, ca: caPem, rejectUnauthorized })
    }
    throw e
  }
}

// ---- ICE 配置(含 TURN 凭据):直连协商要用;取不到就只用内置 STUN ----
// 缓存 5 分钟:跨网段调用时 provider 侧必须能拿到 TURN 才能分配中继候选,
// 但每通电话都请求一次 /ice 没必要(TURN 凭据是静态长期凭据)。
let iceCache = { at: 0, val: null }
async function getIce() {
  if (iceCache.val && Date.now() - iceCache.at < 5 * 60 * 1000) return iceCache.val
  try {
    const r = await callApi('/ice')
    iceCache = { at: Date.now(), val: r }
    if (r && r.hasTurn) log('ICE: TURN 已配置(' + (r.iceServers || []).length + ' 组),可跨网段中继')
    return r
  } catch (e) {
    log('ice config fetch failed: ' + e.message)
    return iceCache.val || { iceServers: [], hasTurn: false }
  }
}

// ---- 采用 listings(必须是本钱包名下) ----
// 启动重试:server 未就绪(网络层错误/超时)时等 5s 重试,最多 120 次(10 分钟),
// 进程不退出——开机竞态下 agent 自己就能等 server;server 的确定性响应
// (http-<status>)不重试,按原逻辑处理。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const entries = []
for (const e of cfg.listings || []) {
  const id = e.listingId
  let listing = null
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await api(base, '/listings/' + id, { ca: caPem, rejectUnauthorized })
      listing = r && r.listing
      break
    } catch (err) {
      if (/^http-\d/.test(err.message)) break // server 已确定性应答:404 等
      if (attempt >= 120) throw err
      log('server not ready (' + err.message + '), retry ' + attempt + '/120 in 5s…')
      await sleep(5000)
    }
  }
  if (!listing) {
    log('listing 不存在: ' + id.slice(0, 10))
    process.exit(1)
  }
  if (listing.provider !== wallet.address) {
    log('listing ' + id.slice(0, 10) + ' 属主 ' + listing.provider + ' ≠ 本钱包 ' + wallet.address)
    process.exit(1)
  }
  entries.push({ listing, apiKey: e.apiKey || '' })
  log(
    'adopted ' + id.slice(0, 10) + ' model=' + listing.model.name + ' backend=' + ((listing.backend && listing.backend.url) || 'echo')
  )
}
if (entries.length === 0) {
  log('config.listings 为空,无事可做')
  process.exit(1)
}

// ---- 每个 listing 一个无头 agent ----
// 预热 ICE 缓存(直连协商要立刻用,不能等第一通电话才去取)
await getIce().catch(() => {})
const agents = []
for (const { listing, apiKey } of entries) {
  agents.push(
    startNodeAgent({
      wsBase,
      listing,
      wallet,
      apiKey,
      env: { serverBase: base, allowRelay: false },
      getIce,
      // config.rtc === false → 强制中转(排障用)
      rtcEnabled: cfg.rtc !== false,
      log: (s) => log('[' + listing.model.name + '] ' + s),
      onCall: (info) => log('[' + listing.model.name + '] call ' + info.sessionId.slice(0, 8) + ' ' + info.phase),
      onCallEnd: (info) =>
        log('[' + listing.model.name + '] call ' + info.sessionId.slice(0, 8) + ' ended ok=' + info.ok + (info.error ? ' (' + info.error + ')' : '')),
    })
  )
}

// ---- presence 心跳 + 模型健康探测 ----
const state = new Map() // listingId -> { healthy, fails, online }
for (const { listing } of entries) state.set(listing.id, { healthy: true, fails: 0, online: false })
const heartbeatSec = Math.max(10, cfg.heartbeatSec || 30)
const probeSec = Math.max(5, cfg.probeSec || 30)
const failThreshold = Math.max(1, cfg.probeFailThreshold || 2)

const heartbeat = setInterval(async () => {
  for (const { listing } of entries) {
    const st = state.get(listing.id)
    if (!st.healthy || !st.online) continue
    try {
      await callApi('/presence', { method: 'POST', body: { listingId: listing.id } })
    } catch (e) {
      log('presence failed: ' + e.message)
    }
  }
}, heartbeatSec * 1000)

async function probeAll() {
  for (const { listing, apiKey } of entries) {
    const st = state.get(listing.id)
    let ok
    try {
      ok = await probeModel(listing, { apiKey, base, ca: caPem, rejectUnauthorized })
    } catch {
      ok = false
    }
    if (ok) {
      st.fails = 0
      if (!st.healthy) {
        st.healthy = true
        log('model recovered: ' + listing.model.name)
      }
      if (!st.online) {
        try {
          await callApi('/presence', { method: 'POST', body: { listingId: listing.id } })
          st.online = true
          log('ONLINE: ' + listing.model.name)
        } catch (e) {
          log('online failed: ' + e.message)
        }
      }
    } else {
      st.fails++
      if (st.healthy && st.fails >= failThreshold) {
        st.healthy = false
        try {
          await callApi('/presence/offline', { method: 'POST', body: { listingId: listing.id } })
        } catch {}
        if (st.online) {
          st.online = false
          log('OFFLINE (probe failed ' + st.fails + 'x): ' + listing.model.name)
        }
      } else if (!st.online) {
        log('probe failing (' + st.fails + '/' + failThreshold + '), still offline: ' + listing.model.name)
      }
    }
  }
}
await probeAll() // 启动即探测:健康才上线
const prober = setInterval(probeAll, probeSec * 1000)

// ---- 关机:立即下线 + 关在途调用 ----
let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  log('shutting down: clearing presence…')
  for (const { listing } of entries) {
    try {
      await callApi('/presence/offline', { method: 'POST', body: { listingId: listing.id } })
    } catch {}
  }
  for (const a of agents) {
    try {
      a.stop()
    } catch {}
  }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
