import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { listingHashOf, hexToBytes, b64encode } from '@mesh/shared/protocol'
import { api, login } from '../../agent/src/http.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ca = fs.readFileSync(path.join(here, '..', 'tls', 'cert.pem'), 'utf8')
const BASE = 'https://127.0.0.1:4011'

const kp = nacl.sign.keyPair()
const addr = bs58.encode(kp.publicKey)
const sign = (b) => nacl.sign.detached(new Uint8Array(b), kp.secretKey)
const wallet = { address: addr, signMessage: sign }

const token = await login(BASE, wallet, ca)
console.log('登录 OK, session 前 12:', token.slice(0, 12))

const payload = {
  provider: addr,
  p2pPublicKey: addr,
  model: { name: 'probe-model-2', context: 8192, modalities: ['text'] },
  pricing: { currency: 'USDT', per1kInputRaw: 5000, per1kOutputRaw: 15000, per1kCacheRaw: 1000, minFeeRaw: 100 },
  limits: { maxTokens: 2000, maxConcurrent: 2 },
  metering: { charsPerToken: 4, tolerancePct: 5 },
  bondUsdtRaw: 100000000,
  version: 1,
  backend: { type: 'mock', url: '', relay: false },
}
const id = await listingHashOf(payload)
const sig = b64encode(sign(hexToBytes(id)))
const r = await api(BASE, '/listings', { method: 'POST', body: { listing: { ...payload, id }, signature: sig }, token, ca })
console.log('发布 OK, listing id:', r.listing.id.slice(0, 16))
