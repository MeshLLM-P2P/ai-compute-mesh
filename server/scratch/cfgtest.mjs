// 冒烟测试:GET /agent-config → POST /autostart(不改动真实 config.json 的 listings)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import nacl from 'tweetnacl'
import bs58 from 'bs58'

const here = path.dirname(fileURLToPath(import.meta.url))
const agentRoot = path.join(here, '..', '..', 'agent')
const wf = path.join(agentRoot, 'wallet.json')
const raw = JSON.parse(fs.readFileSync(wf, 'utf8'))
const secretKey = Buffer.from(raw.secretKeyB64, 'base64')
const wallet = bs58.encode(secretKey.subarray(32))
const base = 'https://127.0.0.1:4011'
const ca = fs.readFileSync(path.join(agentRoot, '..', 'server', 'tls', 'cert.pem'), 'utf8')

async function call(p, opts = {}, token) {
  const r = await fetch(base + p, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-mesh-session': token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    ...(ca ? { httpsAgent: undefined } : {}),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error('http-' + r.status + ' ' + JSON.stringify(j))
  return j
}

// 自签证书:用 node:https 显式带 ca
import https from 'node:https'
function call2(p, opts = {}, token) {
  return new Promise((resolve, reject) => {
    const body = opts.body ? JSON.stringify(opts.body) : null
    const req = https.request(
      {
        host: '127.0.0.1',
        port: 4011,
        path: p,
        method: opts.method || 'GET',
        ca,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'x-mesh-session': token } : {}),
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        let s = ''
        res.on('data', (d) => (s += d))
        res.on('end', () => {
          const j = JSON.parse(s || '{}')
          if (res.statusCode >= 400) reject(new Error('http-' + res.statusCode + ' ' + JSON.stringify(j)))
          else resolve(j)
        })
      }
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

const nonce = (await call2('/nonce?wallet=' + encodeURIComponent(wallet))).nonce
const sigB64 = Buffer.from(nacl.sign.detached(Buffer.from(nonce, 'utf8'), secretKey)).toString('base64')
const token = (await call2('/verify', { method: 'POST', body: { wallet, signature: sigB64 } })).session

const info = await call2('/agent-config', {}, token)
console.log('GET /agent-config OK')
console.log('  path:', info.path)
console.log('  wallet:', info.walletAddress)
console.log('  nodePath:', info.nodePath)
console.log('  autostart:', JSON.stringify(info.autostart, null, 1))

// 写入测试:只改一个无副作用字段(与当前值相同),避免污染真实配置
const cur = info.config || {}
const saved = await call2('/agent-config', { method: 'POST', body: { heartbeatSec: cur.heartbeatSec || 30 } }, token)
console.log('POST /agent-config OK, listings 保留:', saved.config.listings.length)

// 开机自启:先读状态;若未启用则生成脚本内容(不实际写文件时靠 supported 判断)
const r = await call2('/autostart', { method: 'POST', body: { enable: false, startServer: true, startAgent: true, hidden: true } }, token)
console.log('POST /autostart(取消) OK:', JSON.stringify(r, null, 1))
const r2 = await call2('/autostart', { method: 'POST', body: { enable: true, startServer: true, startAgent: true, hidden: true } }, token)
console.log('POST /autostart(启用) OK:', JSON.stringify(r2, null, 1))
const r3 = await call2('/autostart', { method: 'POST', body: { enable: false } }, token)
console.log('回滚取消 OK:', JSON.stringify(r3, null, 1))

// 负向校验
try {
  await call2('/agent-config', { method: 'POST', body: { server: '' } }, token)
  console.log('负向校验失败:空 server 竟然通过')
} catch (e) {
  console.log('负向校验 OK(空 server 被拒):', e.message)
}
try {
  await call2('/autostart', { method: 'POST', body: { enable: true, startServer: false, startAgent: false } }, token)
  console.log('负向校验失败:两项都不勾竟然通过')
} catch (e) {
  console.log('负向校验 OK(至少勾一项):', e.message)
}
