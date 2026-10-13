// /dc data-plane smoke test: two Node ws clients join the same sess room,
// frames are forwarded verbatim to the other member. Self-skips when the
// dev server on :4011 is unreachable.
import test from 'node:test'
import assert from 'node:assert'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let WebSocket
try {
  WebSocket = require('ws')
} catch {
  WebSocket = null
}

const BASE = 'wss://127.0.0.1:4011'

// 连接 /dc;成功返回 ws,失败/超时 reject(并 terminate 以免挂住事件循环)
function openDc(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE + path, { rejectUnauthorized: false })
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('connect-timeout ' + path))
    }, 4000)
    ws.once('open', () => {
      clearTimeout(timer)
      resolve(ws)
    })
    ws.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

const skipIfNoWs = !WebSocket ? 'ws package unavailable' : false

test('dc endpoint relays frames between room members', { skip: skipIfNoWs }, async (t) => {
  let a, b, c
  try {
    a = await openDc('/dc')
    b = await openDc('/dc')
  } catch {
    t.skip('server on :4011 unreachable')
    return
  }
  const room = 'sess:test-' + Date.now()
  const frames = []
  b.on('message', (d) => {
    const s = d.toString()
    if (s.startsWith('{"t":"joined"')) return
    frames.push(s)
  })
  a.send(JSON.stringify({ t: 'join', room }))
  b.send(JSON.stringify({ t: 'join', room }))
  await new Promise((r) => setTimeout(r, 400))
  a.send('kx:{"t":"hello"}')
  a.send('RAW-BUSINESS-FRAME')
  await new Promise((r) => setTimeout(r, 700))
  let err = null
  try {
    assert.strictEqual(frames.length, 2, 'expected 2 frames, got: ' + frames.join(' | '))
    assert.strictEqual(frames[0], 'kx:{"t":"hello"}')
    assert.strictEqual(frames[1], 'RAW-BUSINESS-FRAME')
  } catch (e) {
    err = e
  }
  if (err) {
    a.terminate()
    b.terminate()
    throw err
  }

  // 其他房间的成员收不到
  c = await openDc('/dc')
  const cFrames = []
  c.on('message', (d) => cFrames.push(d.toString()))
  c.send(JSON.stringify({ t: 'join', room: 'sess:other-' + Date.now() }))
  await new Promise((r) => setTimeout(r, 400))
  a.send('kx:{"t":"only-room"}')
  await new Promise((r) => setTimeout(r, 500))
  let err2 = null
  try {
    assert.strictEqual(cFrames.filter((f) => f.includes('only-room')).length, 0)
  } catch (e) {
    err2 = e
  }
  a.terminate()
  b.terminate()
  c.terminate()
  if (err2) throw err2
})

test('dc rejects non-join first frame', { skip: skipIfNoWs }, async (t) => {
  let closed = false
  const ws = new WebSocket(BASE + '/dc', { rejectUnauthorized: false })
  ws.on('close', () => {
    closed = true
  })
  const opened = new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.terminate()
      resolve(false)
    }, 4000)
    ws.on('open', () => {
      clearTimeout(timer)
      resolve(true)
    })
    ws.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
  const ok = await opened
  if (!ok) return t.skip('server on :4011 unreachable')
  ws.send('garbage')
  await new Promise((r) => setTimeout(r, 800))
  let err = null
  try {
    assert.strictEqual(closed, true, 'server should close socket on bad first frame')
  } catch (e) {
    err = e
  }
  ws.terminate() // 无论成败都断开,避免事件循环挂住
  if (err) throw err
})
