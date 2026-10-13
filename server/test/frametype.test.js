// 验证 /dc 中继保真转发帧类型:文本帧必须仍以文本帧到达对端。
// 背景:ws 包把文本帧也交给 Buffer,旧代码 peer.send(Buffer) 会把文本帧
// 转成二进制帧 —— 浏览器端收到 Blob,toText 解不出 'kx:' 前缀,kx 全丢。
// 本测试用 ws 包的 isBinary 标志判定:文本帧到达对端时 isBinary 必须为 false。
import WebSocket from 'ws'

const BASE = 'wss://127.0.0.1:4011'

// 自跳过:server 未运行时保持 `node --test` 离线全绿(与其他测试一致)
let up = false
try {
  const r = await fetch('https://127.0.0.1:4011/health', {
    rejectUnauthorized: false,
    signal: AbortSignal.timeout(2000),
  })
  up = r.ok
} catch {}
if (!up) {
  console.log('  skip frametype (server not running on :4011)')
  process.exit(0)
}

function openDc(room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE + '/dc', { rejectUnauthorized: false })
    const frames = []
    ws.on('message', (data, isBinary) => {
      const text = data.toString()
      if (text.includes('"joined"')) {
        resolve({ ws, frames })
        return
      }
      frames.push({ text, isBinary })
    })
    ws.on('error', reject)
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room })))
  })
}

const room = 'sess:frametype-' + Date.now()
const a = await openDc(room)
const b = await openDc(room)

// A 发一个文本帧(kx-a 形态)
a.ws.send('kx:{"t":"kx-a","epk":"dGVzdA=="}')
// A 发一个二进制帧(对照)
a.ws.send(Buffer.from([0x01, 0x02, 0x03]))

await new Promise((r) => setTimeout(r, 600))

const textFrame = b.frames.find((f) => f.text.startsWith('kx:'))
const binFrame = b.frames.find((f) => !f.text.startsWith('kx:') && f.isBinary)

let ok = true
if (!textFrame) {
  console.error('FAIL: 对端未收到文本帧')
  ok = false
} else if (textFrame.isBinary) {
  console.error('FAIL: 文本帧被转成二进制帧 (isBinary=true) —— 浏览器端会丢帧')
  ok = false
} else {
  console.log('PASS: 文本帧保真转发 (isBinary=false)')
}
if (!binFrame) {
  console.error('FAIL: 对端未收到二进制帧')
  ok = false
} else {
  console.log('PASS: 二进制帧保真转发 (isBinary=true)')
}

a.ws.close()
b.ws.close()
process.exit(ok ? 0 : 1)