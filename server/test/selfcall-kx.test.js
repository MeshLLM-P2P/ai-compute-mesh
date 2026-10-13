// 同钱包自调用 kx 握手复现:同一进程内 provider+consumer 用【同一钱包】,
// 经真实 /dc 中继,验证 kx 握手能否完成。
// 背景:e2e-echo 用两个不同钱包(已全绿);22:08 浏览器故障是同一页面既当
// provider 又当 consumer、同一 G5h6 钱包,该场景未被覆盖。若此测试通过,
// 说明同钱包 kx 在 node 侧无问题,浏览器故障另有原因(陈旧代码/浏览器差异)。
import test from 'node:test'
import assert from 'node:assert'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const nacl = require('tweetnacl')
const bs58 = require('bs58')

const CERT = path.resolve(import.meta.dirname, '..', 'tls', 'cert.pem')
const caPem = fs.existsSync(CERT) ? fs.readFileSync(CERT, 'utf8') : null

const { KxSession } = await import('@mesh/shared/channel')
const { openDcChannel } = await import('@mesh/shared/signal')
const { api: rawApi } = await import('../../agent/src/http.js')

const BASE = 'https://127.0.0.1:4011'
const WS_BASE = 'wss://127.0.0.1:4011'
const socketFactory = (u) => new WebSocket(u, { rejectUnauthorized: false })
const a = (p, o = {}) => rawApi(BASE, p, { ...o, ca: caPem })

function makeWallet() {
  const kp = nacl.sign.keyPair()
  const address = bs58.encode(kp.publicKey)
  return {
    address,
    secretKey: kp.secretKey,
    signMessage: (bytes) => nacl.sign.detached(new Uint8Array(bytes), kp.secretKey),
  }
}

const timeout = (ms, label) =>
  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + label)), ms))

test('self-call kx handshake (same wallet, provider+consumer in one process)', async (t) => {
  let up = true
  try {
    await a('/health')
  } catch {
    up = false
  }
  if (!up) return t.skip('server on :4011 unreachable')

  const wallet = makeWallet() // 同一钱包
  const walletPub = bs58.decode(wallet.address)
  const sessionId = crypto.randomUUID()
  const room = 'sess:' + sessionId

  // 一侧:开 dc → join 确认后建 KxSession → 冲刷 preKx → onReady 解析
  const makeSide = (label) =>
    new Promise((resolve, reject) => {
      const preKx = []
      let kx = null
      const ch = openDcChannel({
        url: WS_BASE,
        room,
        socketFactory,
        log: (s) => console.log('[' + label + '-dc] ' + s),
        onFrame: (text) => {
          if (text.startsWith('kx:')) {
            let f
            try {
              f = JSON.parse(text.slice(3))
            } catch {
              return
            }
            if (f.t === 'bye') return
            if (kx) kx.handleKx(f)
            else preKx.push(f)
            return
          }
          // 业务帧:本测试只验证 kx 握手,忽略
        },
        onDead: () => {},
      })
      ch.ready
        .then(() => {
          kx = new KxSession({
            sessionId,
            sign: wallet.signMessage,
            peerIdPub: walletPub, // 同一钱包:对端 idPub = 自己的 pub
            sendKx: (f) => ch.send('kx:' + JSON.stringify(f)),
            onReady: (k) => {
              try {
                ch.close()
              } catch {}
              resolve({ keys: k, label })
            },
            onFail: (e) => {
              try {
                ch.close()
              } catch {}
              reject(e)
            },
            log: (s) => console.log('[' + label + '-kx] ' + s),
          })
          for (const f of preKx.splice(0)) kx.handleKx(f)
        })
        .catch(reject)
    })

  const [prov, cons] = await Promise.all([
    Promise.race([makeSide('provider'), timeout(25000, 'provider kx')]),
    Promise.race([makeSide('consumer'), timeout(25000, 'consumer kx')]),
  ])

  assert.ok(prov.keys, 'provider keys derived')
  assert.ok(cons.keys, 'consumer keys derived')
  console.log('[selfcall] kx handshake completed (same wallet, one process)')
})