// NAT 行为探测 —— 回答"跨网段直连到底能不能成,要不要动路由器"。
//
// 关键方法:必须用**同一个本地 UDP socket**(同一个本地端口)向**不同 IP** 的
// STUN 服务器发包,再比较返回的公网端口。
//   - 端口全部相同 → Endpoint-Independent Mapping(锥形 NAT)
//                     → 打洞可行,不需要改路由器
//   - 端口各不相同 → Address/Port-Dependent Mapping(对称 NAT)
//                     → STUN 学到的地址对别人无效,打洞基本必败,只能走 TURN
//   - 公网 IP 在 100.64/10 → 运营商级 NAT(CGNAT),连路由器都不归你管
//
// 注意:每次探测都新建 socket 是**错的** —— 每个本地端口本来就会拿到不同的
// 公网端口,那样测出来的"端口不同"和 NAT 类型无关。
//
// 用法:node turn/nat-probe.mjs   或   npm run turn:nat
import dgram from 'node:dgram'
import crypto from 'node:crypto'
import dns from 'node:dns/promises'

const STUN_SERVERS = [
  ['stun.miwifi.com', 3478],
  ['stun.chat.bilibili.com', 3478],
  ['stun.douyucdn.cn', 18000],
  ['stun.hitv.com', 3478],
  ['stun.cdnbye.com', 3478],
  ['stun.qq.com', 3478],
  ['stun.syncthing.net', 3478],
  ['stun.ekiga.net', 3478],
]

const MAGIC = [0x21, 0x12, 0xa4, 0x42]

function bindingRequest() {
  const b = Buffer.alloc(20)
  b.writeUInt16BE(0x0001, 0) // Binding Request
  b.writeUInt16BE(0, 2) // length
  b.writeUInt32BE(0x2112a442, 4)
  crypto.randomBytes(12).copy(b, 8)
  return b
}

function parseMapped(msg) {
  if (msg.length < 20 || msg.readUInt32BE(4) !== 0x2112a442) return null
  const len = msg.readUInt16BE(2)
  const end = Math.min(20 + len, msg.length)
  let p = 20
  while (p + 4 <= end) {
    const type = msg.readUInt16BE(p)
    const alen = msg.readUInt16BE(p + 2)
    const v = p + 4
    if (v + alen > end) break
    if (type === 0x0020 && alen >= 8) {
      const port = msg.readUInt16BE(v + 2) ^ 0x2112
      const ip = [...msg.subarray(v + 4, v + 8)].map((x, i) => x ^ MAGIC[i]).join('.')
      return { ip, port }
    }
    if (type === 0x0001 && alen >= 8) {
      return { ip: [...msg.subarray(v + 4, v + 8)].join('.'), port: msg.readUInt16BE(v + 2) }
    }
    p = v + alen + ((4 - (alen % 4)) % 4)
  }
  return null
}

const sock = dgram.createSocket('udp4')
await new Promise((res, rej) => {
  sock.once('error', rej)
  sock.bind(0, '0.0.0.0', res)
})
const localPort = sock.address().port
console.log('本地 socket 端口: ' + localPort + '(全程复用这一个)\n')

const pending = new Map()
sock.on('message', (msg, rinfo) => {
  const key = rinfo.address + ':' + rinfo.port
  const cb = pending.get(key)
  if (cb) cb(msg)
})

function ask(host, port, timeout = 2500) {
  return new Promise(async (resolve) => {
    let ip
    try {
      const r = await dns.lookup(host, { family: 4 })
      ip = r.address
    } catch (e) {
      return resolve({ host, ok: false, err: 'DNS 解析失败' })
    }
    const key = ip + ':' + port
    const timer = setTimeout(() => {
      pending.delete(key)
      resolve({ host, ip, ok: false, err: '超时' })
    }, timeout)
    pending.set(key, (msg) => {
      clearTimeout(timer)
      pending.delete(key)
      const mapped = parseMapped(msg)
      if (!mapped) return resolve({ host, ip, ok: false, err: '响应里没有 MAPPED-ADDRESS' })
      resolve({ host, ip, ok: true, mapped })
    })
    sock.send(bindingRequest(), port, ip)
  })
}

const results = []
for (const [host, port] of STUN_SERVERS) {
  results.push(await ask(host, port))
}

console.log('STUN 探测结果(同一本地端口 ' + localPort + ')\n')
for (const r of results) {
  if (r.ok) {
    console.log('  ' + (r.host + ':' + (r.ip || '')).padEnd(38) + ' → ' + r.mapped.ip + ':' + r.mapped.port)
  } else {
    console.log('  ' + (r.host + ':' + (r.ip || '')).padEnd(38) + ' → 失败: ' + r.err)
  }
}
sock.close()

const good = results.filter((r) => r.ok)
console.log('')

if (good.length === 0) {
  console.log('结论:所有 STUN 都不可达,判断不了 NAT 类型。')
  console.log('  先确认出站 UDP 没被拦,或换几个 STUN 地址再测。')
  process.exit(0)
}

const ips = [...new Set(good.map((r) => r.mapped.ip))]
const ports = [...new Set(good.map((r) => r.mapped.port))]
const dests = [...new Set(good.map((r) => r.ip))]

console.log('公网 IP    : ' + ips.join(', '))
console.log('公网端口   : ' + ports.join(', ') + (ports.length === 1 ? '(唯一)' : '(' + ports.length + ' 种)'))
console.log('目标服务器 : ' + dests.length + ' 个不同 IP')
console.log('')

const cgnat = ips.some((ip) => {
  const [a, b] = String(ip).split('.').map(Number)
  return a === 100 && b >= 64 && b <= 127
})

if (cgnat) {
  console.log('结论:出口在 100.64/10 —— 运营商级 NAT(CGNAT)。')
  console.log('  你前面那台"路由器"其实是运营商的,做端口映射也没用。')
  console.log('  直连无解,只能靠公网 TURN 或反向隧道。')
} else if (dests.length < 2) {
  console.log('结论:只探到 1 个目标 IP,样本不足,换几个 STUN 再测。')
} else if (ports.length === 1) {
  console.log('结论:锥形 NAT —— 映射与目标无关 → **打洞可行,不需要改路由器**。')
  console.log('  同本地端口访问不同服务器,公网端口始终是 ' + ports[0] + ',')
  console.log('  说明对端只要拿到这个地址就能打进来(前提是已放行该对端)。')
  console.log('  这种情况下之前跨网段 5 秒掉线,更可能是 ICE consent 或映射老化,')
  console.log('  而不是打洞本身失败 —— 值得再抓一次 rtc 日志确认。')
} else {
  console.log('结论:对称 NAT —— 公网端口随目标变化 → **打洞基本必败**。')
  console.log('  同一本地端口访问 ' + dests.length + ' 个不同服务器,拿到了 ' + ports.length + ' 种公网端口。')
  console.log('  通过 STUN 学到的地址告诉对方是没意义的,对方打不进来。')
  console.log('  改路由器做静态端口映射也不解决 —— 对称 NAT 的映射随目标动态生成。')
  console.log('  可行路径:公网可达的 TURN 中继,或反向隧道(Cloudflare Tunnel / frp)。')
}

console.log('')
console.log('参考:' + good.length + '/' + results.length + ' 个 STUN 有响应。')
