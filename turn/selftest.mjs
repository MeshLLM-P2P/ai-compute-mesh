// TURN 服务自检 —— 证明它真的在干活,而不只是占着 3478 端口。
//
// 覆盖四项:
//   1. 正确凭据能拿到中继地址(XOR-RELAYED-ADDRESS)
//   2. 中继端口落在配置的范围内(便于路由器端口映射)
//   3. 数据真的经中继往返(私有地址 peer 回显)
//   4. 错误凭据被拒(否则中转带宽就是白送的)
//
// 用法:先起 server.mjs,再 `node selftest.mjs`(读同样的 MESH_TURN_* 环境变量)。
import dgram from 'node:dgram'
import os from 'node:os'
import { connect } from 'turn-server'

const HOST = process.env.MESH_TURN_HOST || '127.0.0.1'
const PORT = Number(process.env.MESH_TURN_PORT || 3478)
const USER = process.env.MESH_TURN_USERNAME || 'meshllm'
const PASS = process.env.MESH_TURN_CREDENTIAL || 'meshllm-devnet'
const RELAY_MIN = Number(process.env.MESH_TURN_RELAY_MIN || 49160)
const RELAY_MAX = Number(process.env.MESH_TURN_RELAY_MAX || 49200)
const URI = 'turn:' + HOST + ':' + PORT + '?transport=udp'

let failed = 0
function check(name, ok, detail) {
  if (!ok) failed++
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

function lanIp() {
  const ifs = os.networkInterfaces()
  for (const k of Object.keys(ifs)) {
    for (const i of ifs[k] || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address
    }
  }
  return '127.0.0.1'
}

function timeout(ms, tag) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error(tag + ' 超时(' + ms + 'ms)')), ms))
}

// 起一个 UDP 回显 peer。用内网地址是为了走 allowPrivatePeers 这条路 ——
// 联调场景里 provider/consumer 就是内网地址。
function startEcho() {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4')
    s.on('error', reject)
    s.on('message', (msg, rinfo) => {
      s.send(Buffer.concat([Buffer.from('echo:'), msg]), rinfo.port, rinfo.address)
    })
    s.bind(0, '0.0.0.0', () => resolve(s))
  })
}

function allocate({ user, pass, lifetime = 120 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false
    const fail = (e) => {
      if (done) return
      done = true
      reject(e instanceof Error ? e : new Error(String(e)))
    }
    let sock
    try {
      sock = connect(URI, user ? { username: user, password: pass } : {}, (err) => {
        if (err) return fail(err)
      })
    } catch (e) {
      return fail(e)
    }
    if (!sock) return fail(new Error('connect 未返回 socket'))
    sock.on('error', fail)
    sock.on('allocate:error', (msg, err) => fail(err || new Error('allocate:error')))
    sock.on('allocate:success', (msg) => {
      if (done) return
      done = true
      resolve({ sock, msg, relayed: msg.getAttribute(0x0016) })
    })
    try {
      sock.allocate({ lifetime })
    } catch (e) {
      fail(e)
    }
  })
}

async function main() {
  console.log('TURN 自检 → ' + URI + ' (user=' + USER + ', 中继端口 ' + RELAY_MIN + '-' + RELAY_MAX + ')\n')

  // 1 + 2: 分配与端口范围
  const a = await allocate({ user: USER, pass: PASS })
  const relayed = a.relayed
  const gotRelay = !!(relayed && relayed.ip && relayed.port)
  check('正确凭据能分配中继', gotRelay, gotRelay ? relayed.ip + ':' + relayed.port : '无 XOR-RELAYED-ADDRESS')
  if (gotRelay) {
    const inRange = relayed.port >= RELAY_MIN && relayed.port <= RELAY_MAX
    check('中继端口在配置范围内', inRange, '实际 ' + relayed.port + ',期望 ' + RELAY_MIN + '-' + RELAY_MAX)
  }

  // 3: 真实数据往返
  const echo = await startEcho()
  const peer = { ip: lanIp(), port: echo.address().port }
  const got = new Promise((resolve) => {
    a.sock.on('data', (from, data) => resolve({ from, data }))
  })
  await new Promise((resolve) => a.sock.createPermission(peer, resolve))
  a.sock.send(peer, Buffer.from('meshllm-turn-selftest'))
  try {
    const r = await Promise.race([got, timeout(6000, '中继数据往返')])
    const text = Buffer.from(r.data).toString()
    check('数据经中继往返', text === 'echo:meshllm-turn-selftest', '收到 "' + text + '"')
  } catch (e) {
    check('数据经中继往返', false, e.message)
  }
  echo.close()
  try {
    a.sock.close()
  } catch {}

  // 4: 错误凭据必须拿不到中继。注意客户端在这种情况下不一定回调错误
  // (有的实现只是不重试,静默停住),所以"拒绝"或"超时未分配"都算通过 ——
  // 关键是绝不能分配成功。
  try {
    const bad = await Promise.race([allocate({ user: USER, pass: PASS + '-wrong' }), timeout(5000, '错误凭据')])
    try {
      bad.sock.close()
    } catch {}
    check('错误凭据被拒绝', false, '居然分配成功了')
  } catch (e) {
    const why = /超时/.test(e.message) ? '未获分配(客户端静默停住)' : e.message
    check('错误凭据被拒绝', true, why)
  }

  console.log('\n' + (failed === 0 ? '全部通过' : failed + ' 项失败'))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\n自检异常: ' + (e && e.stack ? e.stack : e))
  process.exit(1)
})
