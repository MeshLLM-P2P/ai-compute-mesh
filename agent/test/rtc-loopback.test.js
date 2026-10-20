// 无头节点直连(阶段 2b)核心验证:在纯 Node 环境(无全局 RTCPeerConnection)
// 用 werift 注入 openRtcChannel,两个对端经"假信令"交换 SDP/ICE,建起
// DataChannel 并双向收发帧。
//
// 这里不连服务器:只验证「注入实现 + 协商时序 + 数据面」这一层。
// 与真实服务器 + agent 的端到端见 server/test/e2e-rtc.test.js。
import test from 'node:test'
import assert from 'node:assert'
import { RTCPeerConnection } from 'werift'
import { openRtcChannel, isRtcAvailable, resolveRtcImpl } from '@mesh/shared/signal'

const rtcImpl = { RTCPeerConnection }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const timeout = (ms, label) =>
  sleep(ms).then(() => {
    throw new Error('timeout: ' + label)
  })

test('Node 环境没有全局 RTCPeerConnection,注入后才可用', () => {
  assert.strictEqual(typeof globalThis.RTCPeerConnection, 'undefined', 'Node 不应自带 RTC')
  assert.strictEqual(isRtcAvailable(), false, '无注入时应判定不可直连')
  assert.strictEqual(isRtcAvailable(rtcImpl), true, '注入 werift 后应判定可直连')
  assert.strictEqual(resolveRtcImpl(null), null)
  assert.strictEqual(resolveRtcImpl(rtcImpl).RTCPeerConnection, RTCPeerConnection)
  // 残缺注入(没有 RTCPeerConnection)不能被当成可用
  assert.strictEqual(isRtcAvailable({ RTCPeerConnection: 'nope' }), false)
})

test('openRtcChannel: 注入 werift 后 consumer↔provider 直连并双向收发', async () => {
  let consumer = null
  let provider = null
  const logs = []
  const gotByProvider = []
  const gotByConsumer = []
  const sigFrames = { sdp: 0, ice: 0 }

  // 假信令:只转发 sdp/ice,异步派发(模拟网络,避免同 tick 重入)
  const wire = (from) => ({
    sendTo: (room, msg) => {
      if (msg.t !== 'sdp' && msg.t !== 'ice') return
      sigFrames[msg.t] = (sigFrames[msg.t] || 0) + 1
      setImmediate(() => {
        const to = from === 'consumer' ? provider : consumer
        if (to) to.handleSignalMsg(msg)
      })
    },
  })

  const mk = (side, isConsumer, onFrame) =>
    openRtcChannel({
      signal: wire(side),
      room: 'sess:loopback',
      isConsumer,
      log: (s) => logs.push(side + ': ' + s),
      onFrame,
      // [] = 只用 host 候选(回环联调不需要 STUN/TURN,也不该去连外网)
      iceServers: [],
      timeoutMs: 20000,
      rtcImpl,
    })

  try {
    consumer = mk('consumer', true, (t) => gotByConsumer.push(t))
    // provider 侧:只等 offer(构造顺序无所谓,信令是异步派发的)
    provider = mk('provider', false, (t) => gotByProvider.push(t))

    await Promise.race([
      Promise.all([consumer.ready, provider.ready]),
      timeout(25000, 'rtc 直连建立'),
    ])
    assert.ok(consumer.isOpen(), 'consumer 侧 DataChannel 应为 open')
    assert.ok(provider.isOpen(), 'provider 侧 DataChannel 应为 open')
    assert.ok(sigFrames.sdp >= 2, '应交换过 offer + answer,实际 ' + sigFrames.sdp)
    assert.ok(logs.some((l) => l.includes('rtc connected')), '缺少连接成功日志')

    // consumer → provider
    consumer.send('hello-from-consumer')
    for (let i = 0; i < 100 && !gotByProvider.length; i++) await sleep(30)
    assert.deepStrictEqual(gotByProvider, ['hello-from-consumer'])

    // provider → consumer(双向:证明不是单向管道)
    provider.send('hello-from-provider')
    for (let i = 0; i < 100 && !gotByConsumer.length; i++) await sleep(30)
    assert.deepStrictEqual(gotByConsumer, ['hello-from-provider'])
  } finally {
    try {
      consumer && consumer.close()
    } catch {}
    try {
      provider && provider.close()
    } catch {}
  }
})

test('openRtcChannel: 不注入且无全局实现时抛 rtc-unsupported', () => {
  assert.throws(
    () => openRtcChannel({ signal: { sendTo() {} }, room: 'r', isConsumer: true, onFrame() {} }),
    /rtc-unsupported/
  )
})

test('openRtcChannel: 直连建不起来时 ready 会拒绝(供上层回退中转)', async () => {
  // provider 侧永远不回应 offer → consumer 必须超时失败,而不是永久挂住
  const consumer = openRtcChannel({
    signal: { sendTo() {} },
    room: 'sess:void',
    isConsumer: true,
    log: () => {},
    onFrame: () => {},
    iceServers: [],
    timeoutMs: 1200,
    rtcImpl,
  })
  await assert.rejects(
    () => Promise.race([consumer.ready, timeout(8000, 'ready 未在超时后拒绝')]),
    /rtc-timeout/
  )
  consumer.close()
})
