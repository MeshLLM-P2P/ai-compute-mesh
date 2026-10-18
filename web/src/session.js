// MeshLLM E2E call session: kx handshake, encrypted frames, prompt/token
// streaming, signed receipt. Consumer and provider orchestrators share
// KxSession (now in @mesh/shared/channel). Transport: platform WS data
// channel (/dc) — the server relays raw frames verbatim and never parses E2EE.
import bs58 from 'bs58'
import {
  b64encode,
  b64decode,
  estimateTokens,
  turnInputEstimate,
  calcAmountRaw,
  transcriptHash,
  receiptPayloadForHash,
  receiptDigest,
} from '@mesh/shared/protocol'
import { ed25519Verify } from '@mesh/shared/e2ee'
import { SignalClient, openDcChannel, openRtcChannel } from '@mesh/shared/signal'
import {
  KxSession,
  encodeEncrypted,
  decodeEncrypted,
  callParams,
  runBackend,
  cachedTokensOf,
} from '@mesh/shared/channel'
import { api, SERVER, SIGNAL_URL, getSession, makeApi, wsUrlOf, browserBase } from './api.js'

// ---------- consumer orchestrator ------------------------------------------

// [跨 bootstrap 调用] serverBase=null → 全走本地 bootstrap(默认);
// serverBase=<远程 origin>(如 https://192.168.2.174:4011)+ 远程
// sessionToken → 信令、/dc 中继、escrow 结算全部连远程 bootstrap。
// provider agent 零改动:offer 到达远程 lst 房间即正常接单,
// 它的数据通道/回执也全在自己的 bootstrap 上完成。
export async function startConsumerCall({
  listing,
  wallet,
  log,
  onState,
  onTokens,
  onReceipt,
  onError,
  onClosed,
  serverBase = null,
  sessionToken = null,
}) {
  const sessionId = crypto.randomUUID()
  const params = callParams(listing)
  // [跨 bootstrap] 远程 base 归一化:https 页面下的 http:// 升级为 https://
  // (混合内容策略会拦掉),信令/中继/结算与对面保持一致
  if (serverBase) serverBase = browserBase(serverBase)
  const signalUrl = serverBase ? wsUrlOf(serverBase) : SIGNAL_URL
  const apiFn = serverBase ? makeApi(serverBase, sessionToken).api : api
  const signal = new SignalClient(signalUrl)
  let ch, kx, keys
  let prompt = ''
  let reply = ''
  let receipt = null
  let failed = false
  let closing = false
  // 多轮对话:turns = 每轮 {prompt, reply}(含进行中最后一轮,reply 边流边长);
  // 回执到达前 consumer 可继续 sendPrompt,发 endConversation 收尾出回执
  let turns = []
  let ended = false
  let turnOpen = false
  let connectTimer = null
  let callTimer = null
  let pingTimer = null
  let pingsOut = 0
  // [阶段2 WebRTC] transport 协商状态:rtc 通道引用 + accept 等待定时器。
  // 声明在 fail() 可达的作用域(协商在 try 内异步进行,fail 可能先于声明执行)。
  let rtcCh = null
  let acceptTimer = null

  const set = (status, extra = {}) => onState({ status, ...extra })
  const fail = (e) => {
    if (failed) return
    failed = true
    clearTimeout(connectTimer)
    clearTimeout(callTimer)
    clearTimeout(acceptTimer)
    stopPing()
    try {
      ch && ch.close()
      rtcCh && rtcCh.close()
      signal.close()
    } catch {}
    // [P1 自愈] 错误附带会话快照:调用方(Market)据此决定重试策略——
    // 无已完成轮次 → 自动重连重发;有已完成轮次 → 保持托管,手动重放。
    // 会话自身状态是权威数据源,避免 React state 陈旧闭包误判轮数。
    const snap = {
      turns: turns.map((t) => ({ prompt: t.prompt, reply: t.reply })),
      turnOpen,
      receipt: !!receipt,
    }
    onError && onError(e.message || String(e), snap)
    onClosed && onClosed()
  }

  try {
    // 信令连接限时:连不上就快速失败,不无限挂起
    await Promise.race([
      signal.connect(),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('signal-connect-timeout: 无法连接信令服务器')), 8000)
      ),
    ])
    // 1) offer a call through the listing room
    await signal.join('lst:' + listing.id, { msg() {} })
    signal.sendTo('lst:' + listing.id, {
      t: 'call',
      listingId: listing.id,
      sessionId,
      consumerPub: wallet.address,
      // [阶段2 WebRTC] transport 能力声明:浏览器优先直连,provider 按自己
      // 能力(有无 RTCPeerConnection)在 accept 里回选;不回复/旧版本 = relay。
      transport: ['rtc', 'relay'],
    })
    log('offer sent (transport=rtc,relay),等待 provider accept…')
    // 2) session room on /signal:busy 通知仍走信令房间(控制帧)
    //    [阶段2] 同房间还中转 accept(transport 选择)、fallback(回退)、
    //    sdp/ice(WebRTC 协商) —— 都在 handler 里分发。
    await signal.join('sess:' + sessionId, {
      msg: (m) => {
        if (m.t === 'busy') fail(new Error('provider-busy: Provider 已满,请稍后再试'))
        else if (m.t === 'accept') handleAccept(m)
        else if (m.t === 'fallback') fallbackToRelay()
        else if ((m.t === 'sdp' || m.t === 'ice') && rtcCh) rtcCh.handleSignalMsg(m)
      },
    })
    // 3) 通道选择(transport 协商,阶段 2 WebRTC):
    //    等 provider 的 accept —— rtc = WebRTC 直连(数据面不经服务器),
    //    relay = /dc 中转(现有流程)。provider 不支持 rtc(Node 无头 agent)
    //    或旧版本不回复 accept → 6s 后默认 relay;RTC 建立失败自动回退 relay。
    const preKx = []
    let transportChosen = false
    let kxStarted = false
    // 帧链:逐帧串行「解密+处理」,保证处理序=到达序。
    // WebCrypto decrypt 的完成序不受提交序保证,并行 .then 曾在冷启动窗口
    // 把 token 块乱序拼接(transcript 哈希分歧的根因,见 PLAN.md)。
    let frameChain = Promise.resolve()

    // 数据帧处理(relay 与 rtc 两条通道共用):kx 握手帧 + 加密业务帧。
    // kx 握手对象在通道就绪后建立;之前到达的 kx 帧先缓存(preKx)。
    const handleFrame = (text) => {
      if (text.startsWith('kx:')) {
        let f
        try {
          f = JSON.parse(text.slice(3))
        } catch {
          return
        }
        if (f.t === 'bye') {
          // 回执已到手后的 bye 是 Provider 的正常收尾,不是对端崩溃
          if (receipt) {
            log('kx: peer bye after receipt (expected)')
            return
          }
          if (!closing) fail(new Error('peer-bye'))
          return
        }
        if (kx) kx.handleKx(f)
        else preKx.push(f)
        return
      }
      if (!keys) {
        log('frame dropped (kx not ready)')
        return
      }
      frameChain = frameChain.then(() =>
        decodeEncrypted(keys.recvKey, text)
          .then((frame) => handleBusiness(frame))
          .catch((e) => log('frame-decrypt-failed: ' + e.message))
      )
    }
    // 通道死亡处理(两条通道共用)
    const handleDead = () => {
      if (closing) return
      // Provider 发完最终回执后关连接是正常收尾:回执已到手就不是失败,
      // 若误判 fail 会触发 cancelEscrow 把 IN_CALL 释放回 FUNDED,
      // 导致随后点「接受并结算」时 submitReceipt 报 receipt-not-allowed-in-FUNDED
      if (receipt) {
        log('channel: peer closed after receipt (expected)')
        return
      }
      fail(new Error('connect-failed: 连接失败(Provider 可能离线)'))
    }

    // 在选定通道上启动 kx 握手(通道就绪后调用一次)
    function startKxOn(channel) {
      ch = channel
      kxStarted = true
      connectTimer = setTimeout(
        () => fail(new Error('connect-timeout: Provider 无响应(可能离线或已满)')),
        15000
      )
      kx = new KxSession({
        sessionId,
        sign: wallet.signMessage,
        peerIdPub: bs58.decode(listing.provider),
        sendKx: (f) => ch.send('kx:' + JSON.stringify(f)),
        onReady: (k) => {
          keys = k
          clearTimeout(connectTimer)
          log('kx ready, data channel ready')
          set('ready', { sessionId })
        },
        onFail: fail,
        log: (s) => log('kx: ' + s),
      })
      // 冲刷通道就绪前缓存的对端 kx 帧(保序:对端 kx-a 必先于其 kx-b;
      // kx-b 自带 epk,即使 kx-a 全丢也能完成握手)。必须在构造后立即冲刷,
      // 不能放在 onReady 里:onReady 本身依赖这些帧,放那里会死锁。
      for (const f of preKx.splice(0)) kx.handleKx(f)
    }

    // relay 路径:/dc 裸帧中继(join sess 房间,服务器原样转发)。
    // 跨 bootstrap 调用时 url 指向远程 bootstrap。
    function openRelayChannel() {
      const channel = openDcChannel({
        url: signalUrl,
        room: 'sess:' + sessionId,
        log: (s) => log('dc: ' + s),
        onFrame: handleFrame,
        onDead: handleDead,
      })
      Promise.race([
        channel.ready,
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('dc-join-timeout: 数据通道加入超时')), 10000)
        ),
      ])
        .then(() => {
          if (transportChosen && !kxStarted) startKxOn(channel)
        })
        .catch((e) => {
          if (transportChosen && !kxStarted) fail(e)
        })
    }

    // rtc 路径:WebRTC DataChannel 直连;ready 超时/失败 → fallback + relay
    function startRtcChannel() {
      try {
        rtcCh = openRtcChannel({
          signal,
          room: 'sess:' + sessionId,
          isConsumer: true,
          log: (s) => log('rtc: ' + s),
          onFrame: handleFrame,
          onDead: handleDead,
          timeoutMs: 6000,
        })
      } catch (e) {
        fallbackToRelay()
        return
      }
      rtcCh.ready
        .then(() => {
          if (transportChosen && !kxStarted) startKxOn(rtcCh)
        })
        .catch((e) => {
          if (!transportChosen || kxStarted) return
          log('WebRTC 直连失败(' + (e.message || e) + '),回退中转通道')
          signal.sendTo('sess:' + sessionId, { t: 'fallback' })
          rtcCh = null
          openRelayChannel()
        })
    }

    // 回退到 relay(provider 端放弃 RTC / 本端 RTC 失败 / 协商超时)
    function fallbackToRelay() {
      if (kxStarted) return // kx 已开始,不回退
      if (rtcCh) {
        rtcCh.close()
        rtcCh = null
      }
      if (transportChosen && !kxStarted && ch) return // 已在 relay 路径上
      transportChosen = true
      if (acceptTimer) clearTimeout(acceptTimer)
      log('回退到 /dc 中转通道')
      openRelayChannel()
    }

    // provider 的 transport 选择应答
    function handleAccept(m) {
      if (transportChosen || kxStarted) return
      transportChosen = true
      if (acceptTimer) clearTimeout(acceptTimer)
      if (m.transport === 'rtc' && typeof RTCPeerConnection !== 'undefined') {
        log('provider 支持直连,建立 WebRTC 数据通道…')
        startRtcChannel()
      } else {
        openRelayChannel()
      }
    }

    // 等 provider accept;6s 无应答(旧版本 provider)默认 relay
    acceptTimer = setTimeout(() => {
      if (!transportChosen && !kxStarted) {
        transportChosen = true
        log('provider 未响应 transport 协商(可能为旧版本),默认中转通道')
        openRelayChannel()
      }
    }, 6000)
  } catch (e) {
    fail(e)
    return null
  }

  async function handleBusiness(frame) {
    if (frame.t === 'pong') {
      stopPing()
      return
    }
    if (frame.t === 'token') {
      stopPing()
      reply += frame.chunk || ''
      const t = turns[turns.length - 1]
      if (t) t.reply += frame.chunk || ''
      onTokens(frame.chunk, reply)
      if (frame.done) {
        // 一轮结束 ≠ 调用结束:consumer 可继续追问,或 endConversation 收尾
        turnOpen = false
        set('turn-done', { reply, turns: turns.length })
      }
    } else if (frame.t === 'receipt') {
      clearTimeout(callTimer)
      receipt = frame.receipt
      onReceipt(receipt, reply)
      set('receipt', { receipt })
    } else if (frame.t === 'error') {
      fail(new Error(frame.msg || 'provider-error'))
    }
  }

  function sendPrompt(text) {
    // 多轮:可重复调用;同一时刻只允许一轮在进行
    if (failed || closing || ended || receipt || turnOpen) return
    turnOpen = true
    turns.push({ prompt: text, reply: '' })
    prompt = text
    set('streaming')
    // 300s 单轮超时:provider 该轮静默时 UI 不再永久挂起(与 callTimeoutSec 同阶)
    callTimer = setTimeout(() => {
      if (!failed && !receipt && !ended) fail(new Error('call-timeout: 本轮超时(300 秒内未收到响应)'))
    }, 300000)
    if (!keys) {
      fail(new Error('e2ee-not-ready: E2EE 通道未就绪,无法发送提示词'))
      return
    }
    // WS 通道 open 即稳定;仍保留短轮询等待以防 socket 尚未就绪,
    // 15s 内仍未 open 才判错。
    const deadline = Date.now() + 15000
    const waitAndSend = () => {
      if (failed) return
      if (ch.isOpen()) {
        encodeEncrypted(keys.sendKey, { t: 'prompt', prompt: text, params })
          .then((payload) => {
            if (failed) return
            if (ch.isOpen()) {
              try {
                ch.send(payload)
                startPing()
                log('提示词已送入数据通道,等待模型响应…')
              } catch (e) {
                if (Date.now() < deadline) setTimeout(waitAndSend, 200)
                else fail(new Error('dc-send-failed: ' + e.message))
              }
            } else if (Date.now() < deadline) {
              log('数据通道状态变化,重试发送提示词…')
              setTimeout(waitAndSend, 200)
            } else
              fail(new Error('dc-not-open: 数据通道未就绪(已等 15s),提示词未能发出'))
          })
          .catch((e) => fail(new Error('encode-prompt-failed: ' + e.message)))
        return
      }
      if (Date.now() < deadline) setTimeout(waitAndSend, 200)
      else fail(new Error('dc-not-open: 数据通道未就绪(已等 15s),提示词未能发出'))
    }
    waitAndSend()
  }

  // DC 存活探测:发提示词后每 5s 发一个加密 ping,provider 带外立即回 pong
  // (不被长生成阻塞);连续 6 次(30s)无 pong/token 才判通道已死。
  // 30s 余量覆盖模型"思考"阶段(首 token 前的长 prefill/推理)与后台标签页
  // 的偶发节流,避免长响应期间误杀正常通话。
  function startPing() {
    if (pingTimer || failed) return
    pingsOut = 0
    pingTimer = setInterval(() => {
      // 多轮:reply 在第二轮起永远非空,不能再用它判断"是否等响应中"
      if (failed || !turnOpen) {
        stopPing()
        return
      }
      pingsOut++
      if (pingsOut >= 6) {
        stopPing()
        fail(new Error('dc-dead: 数据通道已断开(连续 30 秒无任何响应)'))
        return
      }
      encodeEncrypted(keys.sendKey, { t: 'ping' })
        .then((p) => {
          if (ch.isOpen()) ch.send(p)
        })
        .catch(() => {})
    }, 5000)
  }
  function stopPing() {
    if (pingTimer) clearInterval(pingTimer)
    pingTimer = null
  }

  async function verifyReceipt(r) {
    // 重建完整历史(与 provider 的 call.history 完全同序列),并累计各轮
    // 输入/输出估算 —— 必须与 provider 的 turnInputEstimate 口径一致
    const messages = []
    let ti = 0
    let to = 0
    for (const t of turns) {
      messages.push({ role: 'user', content: t.prompt })
      ti += turnInputEstimate(messages)
      messages.push({ role: 'assistant', content: t.reply })
      to += estimateTokens(t.reply)
    }
    const myHash = await transcriptHash(sessionId, params, messages)
    if (r.transcriptHash !== myHash) throw new Error('transcript-hash-mismatch')
    const tol = ((listing.metering && listing.metering.tolerancePct) || 5) / 100
    if (Math.abs(r.tokensIn - ti) > ti * tol + 1) throw new Error('tokens-in-out-of-tolerance')
    if (Math.abs(r.tokensOut - to) > to * tol + 1) throw new Error('tokens-out-out-of-tolerance')
    // 缓存命中只能是输入的一部分(consumer 无法独立复算,只设上限防虚报)
    const tc = r.tokensCache || 0
    if (tc < 0 || tc > ti * (1 + tol) + 1) throw new Error('tokens-cache-out-of-tolerance')
    const providerPub = bs58.decode(listing.provider)
    const digest = await receiptDigest(r)
    if (!ed25519Verify(providerPub, b64decode(r.signature), digest)) throw new Error('receipt-signature-invalid')
    const amountRaw = calcAmountRaw(listing.pricing, r.tokensIn, r.tokensOut, tc)
    return {
      amountRaw,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      tokensCache: tc,
      myTokensIn: ti,
      myTokensOut: to,
      turns: turns.length,
    }
  }

  async function settle() {
    // 1) 先把回执提交到服务端:IN_CALL → SETTLE_WINDOW(服务端复核 provider 签名)。
    //    回执经 P2P 到达并不自动上链;漏了这一步 settle-fast 会因行内 receipt=null 崩溃
    //    (01:10 结算失败根因)。已处于 SETTLE_WINDOW 时视为已提交,幂等放过。
    try {
      await apiFn('/escrow/receipt', {
        method: 'POST',
        body: { consumer: wallet.address, listingId: listing.id, receipt },
      })
    } catch (e) {
      if (!/receipt-not-allowed-in-SETTLE_WINDOW/.test(e.message)) throw e
    }
    // 2) 双签立即结算
    const digest = await receiptDigest(receipt)
    const acceptSig = b64encode(await wallet.signMessage(digest))
    set('settling')
    const { escrow } = await apiFn('/escrow/settle-fast', {
      method: 'POST',
      body: {
        consumer: wallet.address,
        listingId: listing.id,
        acceptSigB64: acceptSig,
        attestSigB64: receipt.signature,
      },
    })
    set('settled', { escrow })
    close()
  }

  // 多轮对话收尾:通知 provider 结束并发最终回执(覆盖全部轮次累计量)。
  // 与 sendPrompt 对称:同样走加密帧 + 等待通道 open。
  function endConversation() {
    if (failed || closing || ended || receipt || turnOpen) return
    ended = true
    set('ending')
    // 等最终回执的超时兜底(与单轮超时同阶)
    callTimer = setTimeout(() => {
      if (!failed && !receipt) fail(new Error('call-timeout: 等待最终回执超时(300 秒)'))
    }, 300000)
    if (!keys) {
      fail(new Error('e2ee-not-ready: E2EE 通道未就绪,无法结束对话'))
      return
    }
    encodeEncrypted(keys.sendKey, { t: 'end' })
      .then((payload) => {
        if (failed) return
        if (ch.isOpen()) {
          try {
            ch.send(payload)
            log('对话已结束,等待 Provider 发最终回执…')
          } catch (e) {
            fail(new Error('end-send-failed: ' + e.message))
          }
        } else {
          fail(new Error('dc-not-open: 数据通道未就绪,无法结束对话'))
        }
      })
      .catch((e) => fail(new Error('encode-end-failed: ' + e.message)))
  }

  function close() {
    closing = true // 主动关闭:不让 onDead 把正常结束误报为错误
    // 清掉未触发的超时定时器:否则关闭后挂起的 300s 轮超时会触发 fail()
    // 走 onError 重试路径,把用户已关闭的会话重新拉起(与 22:08 同类 bug)
    clearTimeout(connectTimer)
    clearTimeout(callTimer)
    try {
      stopPing()
      if (ch && ch.isOpen()) ch.send('kx:' + JSON.stringify({ t: 'bye' }))
      ch && ch.close()
      signal.close()
      onClosed && onClosed()
    } catch {}
  }

  return {
    sessionId,
    sendPrompt,
    endConversation,
    verifyReceipt,
    settle,
    close,
    get receipt() {
      return receipt
    },
    get turns() {
      return turns
    },
  }
}

// ---------- provider agent --------------------------------------------------
// 浏览器版 provider agent:监听 listing 房间,经会话数据通道接单,
// 从配置的后端流式取 token,用 provider 钱包对回执签名。
// (无头 Node 版 agent 在 agent/ 包,同一套 shared 逻辑。)

export function startProviderAgent({ listing, wallet, log, onCall, onCallEnd, apiKey }) {
  const signal = new SignalClient(SIGNAL_URL)
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
  // 同 session 去重:consumer 握手期间周期性重发 offer,重复 offer 绝不能开
  // 第二个 call(否则两边 kx 临时公钥交叉,双方验签必失败)
  const activeSessions = new Set()

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  signal
    .connect()
    .then(async () => {
      await signal.join('lst:' + listing.id, {
        msg: (m) => {
          if (m.t === 'call') handleCall(m).catch((e) => log('call error: ' + e.message))
        },
      })
      log('agent online (listening for calls, max ' + maxConcurrent + ' concurrent, transport=' + (typeof RTCPeerConnection !== 'undefined' ? 'rtc+relay' : 'relay-only') + ')')
    })
    .catch((e) => log('signal connect failed: ' + e.message))

  function finish(call, ok, extra = {}) {
    if (!call || call.finished) return
    call.finished = true
    // 正常结束路径也要清未触发的 connectTimer,避免孤儿 "call ended" 日志
    if (call.connectTimer) clearTimeout(call.connectTimer)
    if (call.sdpTimer) clearTimeout(call.sdpTimer)
    activeCount = Math.max(0, activeCount - 1)
    activeCalls.delete(call)
    activeSessions.delete(call.sessionId)
    // [阶段2] 退出 /signal 的 sess 房间(transport 协商期间加入的)
    signal.leave('sess:' + call.sessionId)
    try {
      if (call.ch && call.ch.isOpen()) call.ch.send('kx:' + JSON.stringify({ t: 'bye' }))
      call.ch && call.ch.close()
      call.rtcCh && call.rtcCh.close()
    } catch {}
    onCallEnd && onCallEnd({ ok, sessionId: call.sessionId, ...extra })
  }

  // 加密帧统一发送:接收 call(含 keys/ch),通道未就绪时静默丢弃。
  // 必须在 agent 作用域定义——handleBusiness 是 agent 级函数,
  // 之前把 sendEncrypted 塞在 handleCall 里,handleBusiness 够不着,
  // 每次发 token/pong 都抛 "sendEncrypted is not defined"(20:11 故障根因)。
  function sendEncryptedFor(call, obj) {
    // 每 call 一条串行链,保证 token chunk 按序发出(加密是异步的,
    // 乱发会导致消费端重组文本与 provider 的 full 不一致 → 回执 hash 校验失败)
    call.sendChain = (call.sendChain || Promise.resolve()).then(() =>
      encodeEncrypted(call.keys.sendKey, obj).then((p) => {
        if (call.ch.isOpen()) call.ch.send(p)
      })
    )
    return call.sendChain
  }

  async function notifyBusy(sessionId) {
    // The consumer joins the session room right after sending the call offer,
    // so retry a few times to bridge that race.
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
      // [阶段2 WebRTC] rtc 通道引用 / relay 已开标志 / 等 SDP 超时器
      rtcCh: null,
      relayOpened: false,
      sdpTimer: null,
      // 多轮对话状态:一次 call 内累计全部历史与 token 量
      history: [],
      params: null,
      tokensIn: 0,
      tokensOut: 0,
      tokensCache: 0,
      busy: false,
    }
    activeCalls.add(call)

    // consumer 可能中途消失:15s 内未建立数据通道则释放并发槽
    let connectTimer = null
    const fail = (e) => {
      if (connectTimer) clearTimeout(connectTimer)
      if (call.promptTimer) clearTimeout(call.promptTimer)
      log('call ended: ' + (e.message || e))
      finish(call, false, { error: e.message })
    }
    connectTimer = setTimeout(() => fail(new Error('connect-timeout')), 15000)
    call.connectTimer = connectTimer // 供 finish() 在正常结束路径上清理

    // join 前到达的对端 kx 帧先缓存;kx 握手对象在通道就绪后建立
    const preKx = []
    // 帧链:同 consumer 侧,保证 prompt/end 处理序=到达序
    let frameChain = Promise.resolve()

    // [阶段2 WebRTC] transport 协商:provider 按自身能力(有无
    // RTCPeerConnection)与 offer 声明选择直连(rtc)或中转(relay)。
    // /signal 的 sess 房间(与 /dc 房间表相互独立)承载 accept/sdp/ice/fallback。
    const canRtc =
      typeof RTCPeerConnection !== 'undefined' &&
      Array.isArray(m.transport) &&
      m.transport.includes('rtc')
    await signal.join('sess:' + sessionId, {
      msg: (sm) => {
        if ((sm.t === 'sdp' || sm.t === 'ice') && call.rtcCh) call.rtcCh.handleSignalMsg(sm)
        else if (sm.t === 'fallback') fallbackToRelay()
      },
    })
    signal.sendTo('sess:' + sessionId, { t: 'accept', transport: canRtc ? 'rtc' : 'relay' })

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
      // ping 帧带外处理:立即解密并回 pong,不进串行帧链。
      // 否则长模型生成(实测可达 136s)会占住帧链,期间到达的 ping 被排队,
      // provider 无法及时回 pong → consumer 看门狗误判 dc-dead 杀掉正常通话。
      // 业务帧(prompt/end/token/receipt/error)仍走帧链保序,顺序不受影响。
      decodeEncrypted(call.keys.recvKey, text)
        .then((frame) => {
          if (frame.t === 'ping') {
            sendEncryptedFor(call, { t: 'pong' }).catch(() => {})
            return
          }
          frameChain = frameChain.then(() => handleBusiness(call, frame))
        })
        .catch((e) => log('frame-decrypt-failed: ' + e.message))
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
          // 120s 内没等到提示词(消费者崩溃/静默断链)→ 释放并发槽
          // (重握手会再次触发 onReady:先清旧定时器,防止双 timer)
          if (call.promptTimer) clearTimeout(call.promptTimer)
          call.promptTimer = setTimeout(() => {
            if (!call.finished)
              fail(new Error('no-prompt-timeout: 120 秒未收到提示词'))
          }, 120000)
        },
        onFail: fail,
        log: (s) => log('kx: ' + s),
      })
      // 冲刷通道就绪前缓存的对端 kx 帧(kx-b 自带 epk,
      // 即使 kx-a 全丢也能完成握手;放 onReady 里会死锁)
      for (const f of preKx.splice(0)) call.kx.handleKx(f)
      onCall && onCall({ sessionId, phase: 'connecting' })
    }

    // relay 路径:/dc 裸帧中继(join sess 房间,服务器原样转发)
    function openRelayChannel() {
      if (call.relayOpened) return
      call.relayOpened = true
      const channel = openDcChannel({
        url: SIGNAL_URL,
        room: 'sess:' + sessionId,
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

    // rtc 路径:WebRTC DataChannel 直连;ready 超时/失败 → fallback + relay
    function startRtcChannel() {
      try {
        call.rtcCh = openRtcChannel({
          signal,
          room: 'sess:' + sessionId,
          isConsumer: false,
          log: (s) => log('rtc: ' + s),
          onFrame: handleFrame,
          onDead: handleDead,
          timeoutMs: 6000,
        })
      } catch (e) {
        fallbackToRelay()
        return
      }
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

    // 回退到 relay(consumer 放弃直连 / 本端等 SDP 超时 / RTC 失败)
    function fallbackToRelay() {
      if (call.finished || call.kx || call.relayOpened) return
      if (call.rtcCh) {
        call.rtcCh.close()
        call.rtcCh = null
      }
      if (call.sdpTimer) clearTimeout(call.sdpTimer)
      openRelayChannel()
    }

    if (canRtc) {
      // 等 consumer 的 sdp offer;6s 未到 → fallback relay
      call.sdpTimer = setTimeout(() => {
        if (!call.kx && !call.relayOpened) {
          log('等待 SDP offer 超时,回退中转通道')
          signal.sendTo('sess:' + sessionId, { t: 'fallback' })
          fallbackToRelay()
        }
      }, 6000)
      startRtcChannel()
    } else {
      openRelayChannel()
    }
  }

  // 多轮对话:一次 call(一条数据通道连接 + 一份托管)内可发多条 prompt。
  // 每轮把全部历史发给后端;consumer 发 {t:'end'} 收尾 → provider 发
  // 覆盖全轮累计量的最终回执,然后关闭。回执 schema 不变(tokensIn/Out
  // = 各轮累计;transcriptHash 覆盖整段历史),结算/分账逻辑零改动。
  async function sendFinalReceipt(call) {
    const params = call.params
    // 注意:局部变量不能叫 transcriptHash——会遮蔽模块导入的同名函数,
    // 右端调用命中 TDZ("Cannot access 'transcriptHash' before initialization")
    const txHash = await transcriptHash(call.sessionId, params, call.history)
    const payload = receiptPayloadForHash({
      listingId: listing.id,
      sessionId: call.sessionId,
      transcriptHash: txHash,
      tokensIn: call.tokensIn,
      tokensOut: call.tokensOut,
      // 缓存命中单独计费:各轮后端 usage 的累计,不报 → 0
      tokensCache: call.tokensCache,
      ts: Date.now(),
    })
    const digest = await receiptDigest(payload)
    const signature = b64encode(await wallet.signMessage(digest))
    await sendEncryptedFor(call, { t: 'receipt', receipt: { ...payload, signature } })
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
        // 本轮输入估算 = 发给后端的整段历史(后端每轮重放全部上下文)
        call.tokensIn += turnInputEstimate(call.history)
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
          // 浏览器版:relay 需要会话头;sessionToken 每次调用时取,避免 30 分钟过期
          env: { serverBase: SERVER, sessionToken: getSession(), allowRelay: true },
          onToken: (chunk) => {
            sendEncryptedFor(call, { t: 'token', chunk }).catch(() => {})
          },
        })
        call.history.push({ role: 'assistant', content: full })
        call.tokensOut += estimateTokens(full)
        call.tokensCache += cachedTokensOf(usage)
        // 轮结束(done)≠ 调用结束:consumer 可继续发下一条 prompt,
        // 或发 {t:'end'} 收尾出回执
        sendEncryptedFor(call, { t: 'token', chunk: '', done: true }).catch(() => {})
        call.busy = false
        onCall && onCall({ sessionId: call.sessionId, phase: 'turn-done' })
      } catch (e) {
        call.busy = false
        // 先确保错误帧发出,再延迟关连接:立即 close 会让 consumer 只看到
        // dc closed → 误报 "connect-failed",看不到真正的 backend 错误。
        try {
          await sendEncryptedFor(call, { t: 'error', msg: e.message })
        } catch {}
        log('call ended: ' + (e.message || e))
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
        // 没产生任何对话,直接关
        finish(call, true)
        return
      }
      try {
        await sendFinalReceipt(call)
        // 延迟关:等回执帧实际离开通道,consumer 才能收到
        setTimeout(() => finish(call, true), 300)
      } catch (e) {
        try {
          await sendEncryptedFor(call, { t: 'error', msg: e.message })
        } catch {}
        log('call ended: ' + (e.message || e))
        setTimeout(() => finish(call, false, { error: e.message }), 300)
      }
    }
  }

  return {
    stop() {
      stopped = true
      // 停 agent 时清理进行中的调用:通知 consumer 并释放并发槽,
      // 避免 zombie call 永久占位
      for (const call of activeCalls) {
        if (call.finished) continue
        try {
          if (call.ch && call.ch.isOpen())
            call.ch.send('kx:' + JSON.stringify({ t: 'bye' }))
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
