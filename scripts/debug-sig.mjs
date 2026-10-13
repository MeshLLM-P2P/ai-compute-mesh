import fs from 'node:fs'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { b64encode, b64decode, canonical, utf8, sha256, hexToBytes, bytesToHex, listingPayloadForHash } from '../shared/src/protocol.js'

const wallet = JSON.parse(fs.readFileSync('agent/wallet.json'))
const secret = b64decode(wallet.secretKeyB64)

const pub = new Uint8Array(secret.subarray(32))
const pubFromB58 = bs58.decode(wallet.address)

const listing = {
  provider: wallet.address,
  p2pPublicKey: wallet.address,
  model: { name: 'echo-bridge-meshllm', context: 8192, modalities: ['text'] },
  pricing: { currency: 'USDT', per1kInputRaw: 5000, per1kOutputRaw: 15000, minFeeRaw: 10000 },
  limits: { maxTokens: 2000, maxConcurrent: 1 },
  metering: { charsPerToken: 4, tolerancePct: 5 },
  bondUsdtRaw: 100000000,
  version: 1,
  backend: { type: 'echo', url: '' },
}
const payload = listingPayloadForHash(listing)
const rawDigest = await sha256(utf8(canonical(payload)))
const computedHex = bytesToHex(rawDigest)

const [sig, pubFromSign] = nacl.sign.detached(rawDigest, secret)
const sigB64 = b64encode(sig)
const sigDecoded = b64decode(sigB64)
const verifyBytes = hexToBytes(computedHex)

console.log('=== SIZES ===')
console.log('rawDigest.length =', rawDigest.length, '(expect 32)')
console.log('computedHex.length =', computedHex.length, '(expect 64)')
console.log('sig.length =', sig.length, '(expect 64)')
console.log('sigB64 =', sigB64)
console.log('sigB64.length =', sigB64.length)
console.log('sigDecoded.length =', sigDecoded.length, '(expect 64)')
console.log('verifyBytes.length =', verifyBytes.length, '(expect 32)')
console.log('pub.length =', pub.length)
console.log('pubFromB58.length =', pubFromB58.length)
console.log('pubFromSign.length =', pubFromSign.length)
console.log('pub === secret[32:]:', [...pub].every((b,i)=>b===pubFromB58[i]))
console.log('pub === pubFromSign (from nacl):', [...pub].every((b,i)=>b===pubFromSign[i]))

// Try verify with raw sig (no b64 roundtrip)
try {
  const v0 = nacl.sign.detached.verify(verifyBytes, sig, pub)
  console.log('verify with raw sig (pub=secret[32:]):', v0)
} catch (e) {
  console.log('verify raw sig err:', e.message)
}
try {
  const v1 = nacl.sign.detached.verify(verifyBytes, b64decode(sigB64), pub)
  console.log('verify with b64 sig (pub=secret[32:]):', v1)
} catch (e) {
  console.log('verify b64 sig err:', e.message)
}
try {
  const v2 = nacl.sign.detached.verify(verifyBytes, b64decode(sigB64), pubFromSign)
  console.log('verify with b64 sig (pub=fromNacl):', v2)
} catch (e) {
  console.log('verify b64 sig fromNacl err:', e.message)
}