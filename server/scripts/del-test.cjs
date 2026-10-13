// 一次性验证:服务端 DELETE /listings/:id 链路是否完好
const fs = require('fs')
const https = require('https')
const path = require('node:path')
const { createRequire } = require('node:module')
const require2 = createRequire(path.join(__dirname, '../package.json'))
const nacl = require2('tweetnacl')
const bs58 = require2('bs58')

const root = path.join(__dirname, '..')
const ca = fs.readFileSync(path.join(root, 'tls/cert.pem'))

function req(p, { method = 'GET', body, token } = {}) {
  return new Promise((res, rej) => {
    const payload = body ? JSON.stringify(body) : null
    const r = https.request(
      {
        host: '127.0.0.1', port: 4011, path: p, method, ca, rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'x-mesh-session': token } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (resp) => { let b = ''; resp.on('data', (d) => (b += d)); resp.on('end', () => res({ code: resp.statusCode, body: b })) }
    )
    r.on('error', rej)
    if (payload) r.write(payload)
    r.end()
  })
}

;(async () => {
  const { b64encode, utf8, hexToBytes, listingHashOf } = await import('../../shared/src/protocol.js')

  const kp = nacl.sign.keyPair()
  const wallet = bs58.encode(kp.publicKey)
  console.log('test wallet =', wallet.slice(0, 8) + '…')

  const nj = JSON.parse((await req('/nonce?wallet=' + encodeURIComponent(wallet))).body)
  const sig = b64encode(nacl.sign.detached(utf8(nj.nonce), kp.secretKey))
  const v = await req('/verify', { method: 'POST', body: { wallet, signature: sig } })
  const token = JSON.parse(v.body).session
  console.log('login   ->', v.code, token ? 'ok' : 'FAIL ' + v.body)

  const listing = {
    provider: wallet, p2pPublicKey: wallet,
    model: { name: 'del-test-model', context: 8192, modalities: ['text'] },
    pricing: { currency: 'USDT', per1kInputRaw: 5000, per1kOutputRaw: 15000, minFeeRaw: 10000 },
    limits: { maxTokens: 2000, maxConcurrent: 1 },
    metering: { charsPerToken: 4, tolerancePct: 5 },
    bondUsdtRaw: 0, version: 1, backend: { type: 'echo' },
  }
  const id = await listingHashOf(listing)
  const sigB64 = b64encode(nacl.sign.detached(hexToBytes(id), kp.secretKey))
  const pub = await req('/listings', { method: 'POST', token, body: { listing: { ...listing, id }, signature: sigB64 } })
  console.log('publish ->', pub.code, pub.body.slice(0, 60))

  const del = await req('/listings/' + id, { method: 'DELETE', token })
  console.log('delete  ->', del.code, del.body)

  const after = await req('/listings?provider=' + encodeURIComponent(wallet))
  const still = (JSON.parse(after.body).listings || []).some((l) => l.id === id)
  console.log('still listed after delete?', still ? 'YES (BUG)' : 'no (correct)')

  const del2 = await req('/listings/' + id, { method: 'DELETE' })
  console.log('delete without session ->', del2.code, del2.body)

  // 注:测试 listing 已在上面软删除(status=deleted,市场不展示),
  // 无需直改 data.json(server 运行中直改会被内存态覆盖回去)
})().catch((e) => console.error('ERR', e))