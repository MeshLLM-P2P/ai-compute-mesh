// MeshLLM 传输层:WS 信令房间客户端 + /dc 数据通道客户端。
// 平台无关(browser / Node 通用):通过 socketFactory 注入各自的 WebSocket 实现
// (browser 用全局 WebSocket;Node 用 ws 包,可带自签证书选项)。
//
// 协议(与服务器 index.js 对应):
//   /signal  JSON 房间中继。房间:lst:<listingId>、sess:<sessionId>。
//            {t:'join', room} → 服务端回 {t:'joined', room};
//            其余消息原样转发给同房间其他成员(call/sdp/ice/busy/bye 等控制帧)。
//   /dc      裸帧中继。首个帧必须是 {t:'join', room:'sess:<id>'},服务端回
//            {t:'joined', room};之后双方字节原样互转(kx: 帧与 b64 业务密文帧)。
//            服务器不解析 E2EE,只做管道。

const toText = (d) => (d instanceof Uint8Array ? new TextDecoder().decode(d) : String(d))

// 浏览器 onmessage 收到 MessageEvent(取 .data);ws 包 onmessage 直接收到 data。
const eventData = (d) => (d && typeof d === 'object' && 'data' in d ? d.data : d)

export class SignalClient {
  constructor(url, socketFactory) {
    this.url = url
    this._socket = socketFactory || ((u) => new WebSocket(u))
    this.ws = null
    this.handlers = new Map() // room -> handlers { msg }
    this.pendingJoin = new Map() // room -> resolve
    this.onClose = null // 意外断开(重连前)
    this.onOpen = null // (重)连接成功
    this.connected = false
    this.closedByUs = false
    this._connectPromise = null
    this._pendingResolve = null
    this._pendingReject = null
  }

  connect() {
    if (this.connected && this.ws) return Promise.resolve()
    if (this._connectPromise) return this._connectPromise
    this._connectPromise = new Promise((resolve, reject) => {
      this._pendingResolve = resolve
      this._pendingReject = reject
      this._attempt()
    })
    return this._connectPromise
  }

  _attempt() {
    if (this.connected || this.closedByUs) return
    const ws = this._socket(this.url + '/signal')
    this.ws = ws
    ws.onopen = () => {
      this.connected = true
      this._connectPromise = null
      const resolve = this._pendingResolve
      this._pendingResolve = null
      this._pendingReject = null
      // 重新加入之前持有的房间(覆盖重连场景;join 在服务端是幂等的)
      for (const room of this.handlers.keys()) {
        if (!this.pendingJoin.has(room)) this.pendingJoin.set(room, () => {})
        try {
          ws.send(JSON.stringify({ t: 'join', room }))
        } catch {}
      }
      this.onOpen && this.onOpen()
      if (resolve) resolve()
    }
    ws.onclose = () => {
      this.connected = false
      if (this.ws === ws) this.ws = null
      this.onClose && this.onClose()
      if (this.closedByUs) {
        const reject = this._pendingReject
        this._connectPromise = null
        this._pendingResolve = null
        this._pendingReject = null
        if (reject) reject(new Error('signal-closed'))
        return
      }
      // 意外断开:1.5s 后重试,直到成功或 close()
      setTimeout(() => this._attempt(), 1500)
    }
    ws.onerror = () => {} // onclose 随后触发
    ws.onmessage = (d) => {
      let msg
      try {
        msg = JSON.parse(toText(eventData(d)))
      } catch {
        return
      }
      if (msg.t === 'joined') {
        const resolve = this.pendingJoin.get(msg.room)
        if (resolve) {
          this.pendingJoin.delete(msg.room)
          resolve(msg.room)
        }
        return
      }
      if (!msg.room) return
      const h = this.handlers.get(msg.room)
      if (h && h.msg) h.msg(msg)
    }
  }

  // Join a room; resolves when the server acks (also after a reconnect).
  async join(room, handlers) {
    this.handlers.set(room, handlers)
    return new Promise((resolve) => {
      this.pendingJoin.set(room, resolve)
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({ t: 'join', room }))
      }
      // 若处于断开/重连中,onopen 会统一重加入该房间
    })
  }

  sendTo(room, msg) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ ...msg, room }))
    }
  }

  leave(room) {
    this.handlers.delete(room)
  }

  close() {
    this.closedByUs = true
    try {
      this.ws && this.ws.close()
    } catch {}
    this.ws = null
  }
}

// 数据通道:加入 sess 房间后承载 kx 帧与 b64 业务帧。
// - ready:join 被服务端确认(对端可能已先行加入;kx-a 每 500ms 重发覆盖乱序)
// - onFrame(text):原始帧文本(kx:{...} 或 b64 密文)
// - onDead():WS 意外断开(调用方自行决定失败/恢复)
// 不做自动重连:通话中途重连需要完整 kx 重握手,由上层按超时处理更明确。
export function openDcChannel({ url, room, onFrame, onDead, log, socketFactory }) {
  const ws = (socketFactory || ((u) => new WebSocket(u)))(url + '/dc')
  let closedByUs = false
  let settle = null
  const ready = new Promise((resolve, reject) => {
    settle = (err) => (err ? reject(err) : resolve())
  })
  const dbg = (s) => {
    try {
      console.log('[dc] ' + s)
    } catch {}
    log && log(s)
  }

  ws.onopen = () => {
    try {
      ws.send(JSON.stringify({ t: 'join', room }))
    } catch {}
  }
  ws.onmessage = (d) => {
    const text = toText(eventData(d))
    let m = null
    try {
      m = JSON.parse(text)
    } catch {}
    if (m && m.t === 'joined') {
      if (settle) {
        settle()
        settle = null
      }
      return
    }
    onFrame && onFrame(text)
  }
  ws.onclose = () => {
    if (closedByUs) return
    if (settle) {
      settle(new Error('dc-closed-before-join'))
      settle = null
    }
    dbg('dc closed (unexpected)')
    onDead && onDead()
  }
  ws.onerror = () => {}

  return {
    ready,
    isOpen: () => ws.readyState === 1,
    send: (s) => {
      if (ws.readyState === 1) ws.send(s)
    },
    close() {
      closedByUs = true
      try {
        ws.close()
      } catch {}
    },
  }
}

// ---- WebRTC 直连通道(阶段 2) ----------------------------------------------
// 与 openDcChannel 同接口(ready/isOpen/send/close),但数据面走
// RTCPeerConnection DataChannel 直连,不经服务器中转。
// SDP/ICE 经 /signal 的 sess 房间交换(服务端已支持 sdp/ice 广播)。
//
// 协商时序(consumer 发起):
//   consumer:  join sess → 等 accept(rtc) → 建 PC + DataChannel →
//              sdp offer → ICE ↔ → DC open → ready
//   provider:  收 call → join sess → 发 accept(rtc) → 等 sdp offer →
//              answer → ICE ↔ → DC open → ready
// 任一侧 ready 超时(默认 6s):调用方回退 /dc(见 session.js)。
//
// Node 无 RTCPeerConnection 时不构造本通道(调用方检测后直接走 relay)。
const DEFAULT_STUN = 'stun:stun.l.google.com:19302'

export function openRtcChannel({
  signal,
  room,
  isConsumer,
  log,
  onFrame,
  onDead,
  timeoutMs = 6000,
  stunUrls,
}) {
  const dbg = (s) => {
    try {
      console.log('[rtc] ' + s)
    } catch {}
    log && log(s)
  }
  if (typeof RTCPeerConnection === 'undefined')
    throw new Error('rtc-unsupported: 当前环境无 RTCPeerConnection')

  let pc = null
  let dc = null
  let closedByUs = false
  let settled = false
  let settleFn = null
  const ready = new Promise((resolve, reject) => {
    settleFn = (err) => {
      if (settled) return
      settled = true
      err ? reject(err) : resolve()
    }
  })
  const timer = setTimeout(() => {
    if (!settled) settleFn(new Error('rtc-timeout: 直连未在 ' + timeoutMs / 1000 + 's 内建立'))
    cleanup()
  }, timeoutMs)

  function cleanup() {
    try {
      dc && dc.close()
    } catch {}
    try {
      pc && pc.close()
    } catch {}
  }

  pc = new RTCPeerConnection({
    iceServers: [{ urls: stunUrls || DEFAULT_STUN }],
  })
  pc.onicecandidate = (e) => {
    if (e.candidate) signal.sendTo(room, { t: 'ice', candidate: e.candidate.toJSON() })
  }
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      if (!settled) settleFn(new Error('rtc-failed: ' + pc.connectionState))
      if (!closedByUs) onDead && onDead()
    }
  }

  if (isConsumer) {
    // consumer:主动建 DataChannel + 发 SDP offer
    dc = pc.createDataChannel('mesh', { ordered: true })
    bindDataChannel()
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => signal.sendTo(room, { t: 'sdp', role: 'offer', sdp: pc.localDescription }))
      .catch((e) => settleFn(e))
  }
  // provider:等对端 sdp offer(经 handleSignalMsg 进入),ondatachannel 触发

  // 供 session.js 的 sess 房间 handler 转发控制帧:
  // consumer 收 provider 的 sdp answer + 双方 ice;
  // provider 收 consumer 的 sdp offer + 双方 ice。
  function handleSignalMsg(m) {
    if (!pc) return
    if (m.t === 'sdp') {
      if (isConsumer && m.role === 'answer') {
        pc.setRemoteDescription(new RTCSessionDescription(m.sdp)).catch((e) => dbg('setRemote failed: ' + e.message))
      } else if (!isConsumer && m.role === 'offer') {
        pc.setRemoteDescription(new RTCSessionDescription(m.sdp))
          .then(() => pc.createAnswer())
          .then((answer) => pc.setLocalDescription(answer))
          .then(() => signal.sendTo(room, { t: 'sdp', role: 'answer', sdp: pc.localDescription }))
          .catch((e) => settleFn(e))
      }
      return
    }
    if (m.t === 'ice' && m.candidate) {
      pc.addIceCandidate(new RTCIceCandidate(m.candidate)).catch(() => {})
    }
  }

  function bindDataChannel() {
    dc.onopen = () => {
      dbg('rtc connected (direct data channel)')
      settleFn()
    }
    dc.onclose = () => {
      if (!closedByUs && !settled) settleFn(new Error('rtc-closed'))
      if (!closedByUs) onDead && onDead()
    }
    dc.onerror = () => {}
    dc.onmessage = (e) => {
      const text = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)
      onFrame && onFrame(text)
    }
  }

  // provider 侧:远端 DataChannel 到达时绑定
  if (!isConsumer) {
    pc.ondatachannel = (e) => {
      dc = e.channel
      bindDataChannel()
    }
  }

  return {
    ready,
    isOpen: () => !!dc && dc.readyState === 'open',
    send: (s) => {
      if (dc && dc.readyState === 'open') dc.send(s)
    },
    close() {
      closedByUs = true
      cleanup()
    },
    handleSignalMsg,
  }
}
