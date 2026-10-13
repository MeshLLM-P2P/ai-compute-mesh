// MeshLLM E2E crypto: ECDH P-256 (WebCrypto) + HKDF + AES-256-GCM (WebCrypto)
// + Ed25519 identity/receipt keys (tweetnacl, byte-compatible with Solana).
// Works identically in browser and Node >= 20.

import nacl from 'tweetnacl'
import {
  b64encode,
  b64decode,
  utf8,
  fromUtf8,
  sha256,
  mixDigest,
} from './protocol.js'

// Direction assignment is deterministic: the side holding the lexicographically
// smaller ephemeral public key sends with key1 and receives with key2.
const HKDF_INFO_KEY1 = utf8('meshllm-v1-key1')
const HKDF_INFO_KEY2 = utf8('meshllm-v1-key2')

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

// ---------- Ed25519 (identity + receipts) ----------

export function ed25519KeyPair() {
  // secretKey: 64 bytes (seed + pubkey), raw: 32-byte pubkey
  const kp = nacl.sign.keyPair()
  return { secret: kp.secretKey, public: kp.publicKey }
}

export function ed25519Sign(secretKey, bytes) {
  return nacl.sign.detached(bytes, secretKey)
}

export function ed25519Verify(pubKey, sig, bytes) {
  try {
    return nacl.sign.detached.verify(bytes, sig, pubKey)
  } catch {
    return false
  }
}

// ---------- P-256 ECDH ephemeral + session keys ----------
// P-256 via @noble/curves (pure JS, byte-identical in browser and Node).
// WebCrypto's ECDH deriveKey is not usable across both platforms (Node cannot
// export the raw IKM; X25519 is unavailable), so the raw shared secret comes
// from noble and HKDF (WebCrypto) expands it into per-direction AES-256-GCM keys.

import { p256 } from '@noble/curves/p256'

export function genEcdh() {
  const priv = p256.utils.randomPrivateKey()
  const pub = p256.getPublicKey(priv, false) // 65-byte uncompressed
  return { priv, pub }
}

export function ecdhPubRaw(keyPair) {
  return keyPair.pub
}

// Derive independent send/receive AES-256-GCM keys for one side of the session.
// myPair: {priv, pub}; peerPubRaw / myPubRaw: raw 65-byte public keys.
export async function deriveSessionKeys(myPair, peerPubRaw, myPubRaw, session) {
  const ikm = p256.getSharedSecret(myPair.priv, peerPubRaw)
  const salt = new Uint8Array(myPubRaw.length + peerPubRaw.length)
  // salt = min||max of the two public keys (symmetric, matches mixDigest ordering)
  const lo = lexicographicMin(myPubRaw, peerPubRaw)
  const hi = lexicographicMax(myPubRaw, peerPubRaw)
  salt.set(lo, 0)
  salt.set(hi, lo.length)
  const hkdf = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey'])
  const deriveAes = (info) =>
    crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: concatBytes(info, session) },
      hkdf,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
  const key1 = await deriveAes(HKDF_INFO_KEY1)
  const key2 = await deriveAes(HKDF_INFO_KEY2)
  const sendsWithKey1 = lessBytes(myPubRaw, peerPubRaw)
  return sendsWithKey1 ? { sendKey: key1, recvKey: key2 } : { sendKey: key2, recvKey: key1 }
}

function lexicographicMin(a, b) {
  return lessBytes(a, b) ? a : b
}
function lexicographicMax(a, b) {
  return lessBytes(a, b) ? b : a
}
function lessBytes(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return a.length < b.length
}

// ---------- wire frames (post-kx, all binary) ----------

// frame = IV(12) || AES-GCM(ciphertext || tag)
export async function encryptFrame(sendKey, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sendKey, utf8(JSON.stringify(obj)))
  const out = new Uint8Array(12 + ct.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(ct), 12)
  return out
}

export async function decryptFrame(recvKey, buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf)
  const iv = bytes.slice(0, 12)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, recvKey, bytes.slice(12))
  return JSON.parse(fromUtf8(pt))
}

// ---------- kx handshake helpers ----------

// Both sides send kx-a {epk}. After both arrive, each sends kx-b {idPub, sig}
// where sig = ed25519_sign( mixDigest(epkSelf, epkPeer, session) ).
export async function kxBindingDigest(epkSelfRaw, epkPeerRaw, session) {
  return mixDigest(epkSelfRaw, epkPeerRaw, session)
}

export { sha256 }
