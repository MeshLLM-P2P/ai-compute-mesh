// 无头 Node provider agent:监听 listing 房间,经 /dc 数据通道接单,
// 从配置的模型后端流式取 token,用 provider 钱包对回执签名。
// 与浏览器版(web/src/session.js 的 startProviderAgent)同一套 shared 逻辑,
// 区别仅传输(ws 包)与后端调用(Node 无 CORS,永远直连)。
import WebSocket from 'ws'
import bs58 from 'bs58'
import {
  estimateTokens,
  turnInputEstimate,
  transcriptHash,
  receiptPayloadForHash,
  receiptDigest,
  b64encode,
} from '@mesh/shared/protocol'
import { SignalClient, openDcChannel, openRtcChannel, isRtcAvailable } from '@mesh/shared/signal'
import { KxSession, encodeEncrypted, decodeEncrypted, runBackend, cachedTokensOf, usageTokensOf } from '@mesh/shared/channel'

// [阶段 2b] 无头节点直连:Node 没有内置 RTCPeerConnection,这里注入 werift
// (纯 TypeScript 实现,无原生编译依赖)。动态导入 —— 没装/加载失败时 agent
// 照常以 relay 模式接单,不会因为缺依赖起不来。
let rtcImpl = null
let rtcTried = false
async function ensureRtc(log) {
  if (rtcTried) return rtcImpl
  rtcTried = true
  try {
    const m = await import('werift')
    const impl = { RTCPeerConnection: m.RTCPeerConnection }
    if (isRtcAvailable(impl)) {
      rtcImpl = impl
      log && log('WebRTC 直连已启用(werift ' + (m.version || '') + ')')
    }
  } catch (e) {
    log && log('WebRTC 直连不可用,仅中转: ' + (e.message || e))
  }
  return rtcImpl
}

// wsBase:形如 wss://192.168.2.108:4011(不含路径);
// SignalClient 内部拼 /signal,openDcChannel 内部拼 /dc
export function startNodeAgent({
  wsBase,
  listing,
  wallet,
  apiKey,
  env,
  log,
  onCall,
  onCallEnd,
  // [阶段 2b] 取 ICE 配置(GET /ice,含 TURN 凭据);不传则只用内置 STUN
  getIce,
  // 显式关闭直连(排障用:强制走中转)
  rtcEnabled,
}) {
  const rtcOn = rtcEnabled !== false
  // 自签证书:ws 连接忽略证书校验(局域网 devnet)
  const socketFactory = (u) => new WebSocket(u, { rejectUnauthorized: false })
  const signal = new SignalClient(wsBase, socketFactory)
  let firstOpen = true
  signal.onClose = () => log('信令连接断开,自动重连中…')
  signal.onOpen = () => {
    if (firstOpen) {
      firstOpen = false
      return
    }
    log('信令已重连,房间已重新加入,可继续接单')
  }
  let activeCount = 0
  const maxConcurrent = Math.max(1, (listing.limits && listing.limits.maxConcurrent) || 1)
  let stopped = false
  const activeCalls = new Set()
  // 同 session 去重:consumer 握手期间会周期性重发 offer,重复 offer 绝不能
  // 开第二个 call(否则两边 kx 临时公钥交叉,双方验签必失败)
  const activeSessions = new Set()

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  signal
    .connect()
    .then(async () => {
      if (rtcOn) await ensureRtc(log)
      await signal.join('lst:' + listing.id, {
        msg: (m) => {
          if (m.t === 'call') handleCall(m).catch((e) => log('call error: ' + (e.stack || e.message)))
        },
      })
      log(
        'agent online (listening for calls, max ' +
          maxConcurrent +
          ' concurrent, transport=' +
          (rtcImpl ? 'rtc+relay' : 'relay-only') +
          ')'
      )
    })
    .catch((e) => log('signal connect failed: ' + e.message))

  function finish(call, ok, extra = {}) {
    if (!call || call.finished) return
    call.finished = true
    // 正常结束(bye/回执)也要清掉未触发的 connectTimer,否则它稍后触发
    // 会打出孤儿 "call ended: connect-timeout" 日志
    if (call.connectTimer) clearTimeout(call.connectTimer)
    activeCount = Math.max(0, activeCount - 1)
    activeCalls.delete(call)
    activeSessions.delete(call.sessionId)
    try {
      if (call.ch && call.ch.isOpen()) call.ch.send('kx:' + JSON.stringify({ t: 'bye' }))
      call.ch && call.ch.close()
    } catch {}
    // [阶段 2b] 直连通道也要显式关闭:PC 不关会留下 ICE/DTLS 资源与心跳
    try {
      call.rtcCh && call.rtcCh.close()
    } catch {}
    signal.leave('sess:' + call.sessionId)
    onCallEnd && onCallEnd({ ok, sessionId: call.sessionId, ...extra })
  }

  // 加密帧统一发送(必须在 agent 作用域,handleBusiness 是 agent 级函数)。
  // 每 call 一条串行链:echo 后端会同步连发所有 token chunk,各帧的 WebCrypto
  // 加密完成顺序不保证,若不串行,消费端收到的 chunk 顺序可能乱 → 重组文本
  // 与 provider 的 full 不一致 → transcript hash 校验失败。
  function sendEncryptedFor(call, obj) {
    call.sendChain = (call.sendChain || Promise.resolve()).then(() =>
      encodeEncrypted(call.keys.sendKey, obj).then((p) => {
        if (call.ch.isOpen()) call.ch.send(p)
      })
    )
    return call.sendChain
  }

  async function notifyBusy(sessionId) {
    for (let i = 0; i < 3; i++) {
      try {
        await signal.join('sess:' + sessionId, { msg: () => {} })
        signal.sendTo('sess:' + sessionId, { t: 'busy', msg: 'provider-busy' })
        await sleep(300)
        signal.leave('sess:' + sessionId)
        return
      } catch {}
    }
  }

  async function handleCall(m) {
    if (stopped) return
    const sessionId = m.sessionId
    if (activeSessions.has(sessionId)) {
      // 该 session 已有进行中的 call:握手重发的 offer 直接忽略
      log('call ignored: session ' + String(sessionId).slice(0, 8) + ' already in progress')
      return
    }
    if (activeCount >= maxConcurrent) {
      log('call rejected: at capacity (' + activeCount + '/' + maxConcurrent + ')')
      notifyBusy(sessionId)
      return
    }
    const consumerPub = bs58.decode(m.consumerPub)
    // [诊断] offer 是否带 transport 声明:一眼区分 consumer 是新代码还是旧缓存
    log('call offer received: transport=' + JSON.stringify(m.transport || null))
    activeCount++
    activeSessions.add(sessionId)
    const call = {
      sessionId,
      ch: null,
      kx: null,
      keys: null,
      finished: false,
      // [阶段 2b] 直连通道引用 / 中转通道已开标志
      rtcCh: null,
      relayOpened: false,
      history: [],
      params: null,
      tokensIn: 0,
      tokensOut: 0,
      tokensCache: 0,
      meteringSource: null,
      busy: false,
    }
    activeCalls.add(call)

    let connectTimer = null
    const fail = (e) => {
      if (connectTimer) clearTimeout(connectTimer)
      if (call.promptTimer) clearTimeout(call.promptTimer)
      log('call ended: ' + (e.stack || e.message || e))
      finish(call, false, { error: e.message })
    }
    connectTimer = setTimeout(() => fail(new Error('connect-timeout')), 15000)
    call.connectTimer = connectTimer // 供 finish() 在正常结束路径上清理

    const preKx = []
    // 帧链:逐帧串行「解密+处理」,保证处理序=到达序(WebCrypto decrypt
    // 完成序不受提交序保证,并行 .then 曾把帧乱序处理,见 PLAN.md)
    let frameChain = Promise.resolve()

    // 数据帧处理(relay 与 rtc 两条通道共用)
    const handleFrame = (text) => {
      if (text.startsWith('kx:')) {
        let f
        try {
          f = JSON.parse(text.slice(3))
        } catch {
          return
        }
        if (f.t === 'bye') {
          if (!call.finished) finish(call, true)
          return
        }
        if (call.kx) call.kx.handleKx(f)
        else preKx.push(f)
        return
      }
      if (!call.kx || !call.keys) {
        log('frame dropped (kx not ready)')
        return
      }
      frameChain = frameChain.then(() =>
        decodeEncrypted(call.keys.recvKey, text)
          .then((frame) => handleBusiness(call, frame))
          .catch((e) => log('frame-decrypt-failed: ' + e.message))
      )
    }
    const handleDead = () => {
      if (!call.finished) fail(new Error('peer-closed: 连接断开'))
    }

    // 在选定通道上建立 kx 握手(通道就绪后调用一次)
    function startKxOn(channel) {
      call.ch = channel
      call.kx = new KxSession({
        sessionId,
        sign: wallet.signMessage,
        peerIdPub: consumerPub,
        sendKx: (f) => channel.send('kx:' + JSON.stringify(f)),
        onReady: (k) => {
          call.keys = k
          clearTimeout(connectTimer)
          onCall && onCall({ sessionId, phase: 'ready' })
          // 重握手会再次触发 onReady:先清旧定时器,防止双 timer
          if (call.promptTimer) clearTimeout(call.promptTimer)
          call.promptTimer = setTimeout(() => {
            if (!call.finished) fail(new Error('no-prompt-timeout: 120 秒未收到提示词'))
          }, 120000)
        },
        onFail: fail,
        log: (s) => log('kx: ' + s),
      })
      // 冲刷 join 后、握手对象建立前缓存的对端 kx 帧(kx-b 自带 epk,
      // 即使 kx-a 全丢也能完成握手;放 onReady 里会死锁)
      for (const f of preKx.splice(0)) call.kx.handleKx(f)
      onCall && onCall({ sessionId, phase: 'connecting' })
    }

    // relay 路径:/dc 裸帧中继(join sess 房间,服务器原样转发)
    function openRelayChannel() {
      if (call.relayOpened) return
      call.relayOpened = true
      const channel = openDcChannel({
        url: wsBase,
        room: 'sess:' + sessionId,
        socketFactory,
        log: (s) => log('dc: ' + s),
        onFrame: handleFrame,
        onDead: handleDead,
      })
      channel.ready
        .then(() => {
          if (!call.finished && !call.kx) startKxOn(channel)
        })
        .catch((e) => {
          if (!call.finished && !call.kx) fail(e)
        })
    }

    // rtc 路径:WebRTC DataChannel 直连(数据面不经服务器);失败回退中转
    function startRtcChannel(iceServers) {
      call.rtcCh = openRtcChannel({
        signal,
        room: 'sess:' + sessionId,
        isConsumer: false,
        log: (s) => log('rtc: ' + s),
        onFrame: handleFrame,
        onDead: handleDead,
        // 直连建连预算:host候选的 werift 握手实测 ~10s,给 15s
        // 足够余量(跨网段 TURN 直连可能更慢);6s 短于实测握手导致误回退。
        timeoutMs: 15000,
        iceServers,
        rtcImpl,
      })
      call.rtcCh.ready
        .then(() => {
          if (!call.finished && !call.kx) startKxOn(call.rtcCh)
        })
        .catch((e) => {
          if (call.finished || call.kx) return
          log('WebRTC 直连失败(' + (e.message || e) + '),回退中转通道')
          signal.sendTo('sess:' + sessionId, { t: 'fallback' })
          fallbackToRelay()
        })
    }

    // 回退到 relay(consumer 放弃直连 / 本端等 SDP 超时 / RTC 建立失败)
    function fallbackToRelay() {
      if (call.finished || call.kx || call.relayOpened) return
      if (call.rtcCh) {
        call.rtcCh.close()
        call.rtcCh = null
      }
      openRelayChannel()
    }

    // [阶段 2b] transport 协商:/signal 的 sess 房间(与 /dc 房间表相互独立)
    // 承载 accept / sdp / ice / fallback。必须先 join 再回 accept —— consumer
    // 收到 accept 才开始发 sdp,否则 offer 会打到空房间丢掉。
    const wantsRtc = rtcOn && !!rtcImpl && Array.isArray(m.transport) && m.transport.includes('rtc')
    await signal.join('sess:' + sessionId, {
      msg: (sm) => {
        if ((sm.t === 'sdp' || sm.t === 'ice') && call.rtcCh) call.rtcCh.handleSignalMsg(sm)
        else if (sm.t === 'fallback') fallbackToRelay()
      },
    })

    let rtcStarted = false
    if (wantsRtc) {
      try {
        // ICE 配置含 TURN 凭据(跨网段时中继候选靠它)
        const ice = getIce ? await getIce() : null
        if (!call.finished) {
          startRtcChannel((ice && ice.iceServers) || null)
          rtcStarted = true
        }
      } catch (e) {
        log('rtc 通道创建失败(' + (e.message || e) + '),改用中转')
      }
    }
    if (!call.finished) {
      signal.sendTo('sess:' + sessionId, { t: 'accept', transport: rtcStarted ? 'rtc' : 'relay' })
      log('transport=' + (rtcStarted ? 'rtc(直连)' : 'relay(中转)'))
      if (!rtcStarted) openRelayChannel()
    }
  }

  async function sendFinalReceipt(call) {
    const params = call.params
    // 局部变量不能叫 transcriptHash——会遮蔽模块导入的同名函数(TDZ)
    const txHash = await transcriptHash(call.sessionId, params, call.history)
    const payload = receiptPayloadForHash({
      listingId: listing.id,
      sessionId: call.sessionId,
      transcriptHash: txHash,
      tokensIn: call.tokensIn,
      tokensOut: call.tokensOut,
      tokensCache: call.tokensCache,
      ts: Date.now(),
    })
    const digest = await receiptDigest(payload)
    const signature = b64encode(await wallet.signMessage(digest))
    // meteringSource 不进 receiptPayloadForHash(不影响签名),仅供审计
    await sendEncryptedFor(call, {
      t: 'receipt',
      receipt: { ...payload, meteringSource: call.meteringSource || 'estimate', signature },
    })
    onCall && onCall({ sessionId: call.sessionId, phase: 'receipt-sent' })
  }

  async function handleBusiness(call, frame) {
    if (frame.t === 'ping') {
      sendEncryptedFor(call, { t: 'pong' }).catch(() => {})
      return
    }
    if (frame.t === 'prompt') {
      if (!call.keys) {
        log('prompt-dropped: kx keys not ready')
        return
      }
      if (call.busy) {
        log('prompt-ignored: previous turn still in flight')
        return
      }
      if (call.promptTimer) clearTimeout(call.promptTimer)
      const prompt = frame.prompt
      call.params = frame.params
      call.busy = true
      try {
        call.history.push({ role: 'user', content: prompt })
        // 兜底估算;后端报了真实 usage 就用真值替换(见下)
        const estIn = turnInputEstimate(call.history)
        log(
          'prompt received (turn ' +
            Math.ceil(call.history.length / 2) +
            ', ' +
            prompt.length +
            ' chars), calling backend ' +
            ((listing.backend && listing.backend.url) || 'echo')
        )
        const { text: full, usage } = await runBackend({
          listing,
          messages: call.history,
          params: frame.params,
          apiKey,
          // Node 端永远直连后端(无 CORS 限制),relay 标记被忽略
          env: env || { serverBase: '', allowRelay: false },
          onToken: (chunk) => {
            sendEncryptedFor(call, { t: 'token', chunk }).catch(() => {})
          },
        })
        // 计费口径:优先后端上报的真实 usage。估算对中文严重偏低
        // (1 字≈1 token,估算按 4 字符/token),一律用估算会系统性少收。
        const u = usageTokensOf(usage)
        const realIn = u && u.tokensIn != null
        const realOut = u && u.tokensOut != null
        call.tokensIn += realIn ? u.tokensIn : estIn
        call.history.push({ role: 'assistant', content: full })
        call.tokensOut += realOut ? u.tokensOut : estimateTokens(full)
        call.tokensCache += cachedTokensOf(usage)
        const turnSrc = realIn && realOut ? 'usage' : realIn || realOut ? 'mixed' : 'estimate'
        call.meteringSource =
          call.meteringSource == null || call.meteringSource === turnSrc ? turnSrc : 'mixed'
        sendEncryptedFor(call, { t: 'token', chunk: '', done: true }).catch(() => {})
        call.busy = false
        onCall && onCall({ sessionId: call.sessionId, phase: 'turn-done' })
      } catch (e) {
        call.busy = false
        try {
          await sendEncryptedFor(call, { t: 'error', msg: e.message })
        } catch {}
        log('call ended: ' + (e.stack || e.message || e))
        setTimeout(() => finish(call, false, { error: e.message }), 300)
      }
      return
    }
    if (frame.t === 'end') {
      if (!call.keys) return
      if (call.busy) {
        log('end-ignored: a turn is still in flight')
        return
      }
      if (!call.history || call.history.length === 0) {
        finish(call, true)
        return
      }
      try {
        await sendFinalReceipt(call)
        setTimeout(() => finish(call, true), 300)
      } catch (e) {
        try {
          await sendEncryptedFor(call, { t: 'error', msg: e.message })
        } catch {}
        log('call ended: ' + (e.stack || e.message || e))
        setTimeout(() => finish(call, false, { error: e.message }), 300)
      }
    }
  }

  return {
    stop() {
      stopped = true
      for (const call of activeCalls) {
        if (call.finished) continue
        try {
          if (call.ch && call.ch.isOpen()) call.ch.send('kx:' + JSON.stringify({ t: 'bye' }))
        } catch {}
        log('agent stopped, closing in-flight call ' + call.sessionId.slice(0, 8))
        finish(call, false, { error: 'agent-stopped' })
      }
      try {
        signal.close()
      } catch {}
    },
  }
}
