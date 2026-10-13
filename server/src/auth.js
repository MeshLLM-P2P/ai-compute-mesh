import crypto from 'node:crypto'
import nacl from 'tweetnacl'
import { PublicKey } from '@solana/web3.js'
import { utf8, b64decode } from '@mesh/shared/protocol'

const NONCE_TTL_MS = 5 * 60 * 1000
const SESSION_TTL_MS = 30 * 60 * 1000

// Wallet-address login: issue a nonce, verify the wallet signature,
// return a short-lived session token. The platform never stores keys.
export function createAuth(store) {
  const prune = (m) => {
    const out = {}
    const now = Date.now()
    for (const [k, v] of Object.entries(m)) if (now - v.ts < NONCE_TTL_MS) out[k] = v
    return out
  }

  function issueNonce(wallet) {
    store.update('nonces', (m) => {
      const out = prune(m || {})
      out[wallet] = { nonce: crypto.randomBytes(16).toString('hex'), ts: Date.now() }
      return out
    })
    return store.get('nonces', {})[wallet]
  }

  function verify(wallet, signatureB64) {
    const n = store.get('nonces', {})[wallet]
    if (!n) return { ok: false, error: 'no-nonce' }
    let pub
    try {
      pub = new PublicKey(wallet).toBytes()
    } catch {
      return { ok: false, error: 'bad-wallet' }
    }
    let ok = false
    try {
      ok = nacl.sign.detached.verify(utf8(n.nonce), b64decode(signatureB64), pub)
    } catch {
      ok = false
    }
    if (!ok) return { ok: false, error: 'bad-signature' }
    const token = crypto.randomBytes(24).toString('base64url')
    store.update('sessions', (m) => {
      if (m === null) m = {}
      // prune old sessions
      const now = Date.now()
      for (const [t, s] of Object.entries(m)) if (now - s.ts > SESSION_TTL_MS) delete m[t]
      m[token] = { wallet, ts: Date.now() }
      return m
    })
    // one-shot nonce
    store.update('nonces', (m) => {
      const out = { ...(m || {}) }
      delete out[wallet]
      return out
    })
    return { ok: true, session: token }
  }

  function resolveWallet(token) {
    if (!token) return null
    const s = store.get('sessions', {})[token]
    if (!s || Date.now() - s.ts > SESSION_TTL_MS) return null
    return s.wallet
  }

  function sessionWallet(req) {
    return resolveWallet(req.headers['x-mesh-session'])
  }

  function requireSession(req, res, next) {
    const wallet = sessionWallet(req)
    if (!wallet) return res.status(401).json({ error: 'session-required' })
    req.wallet = wallet
    next()
  }

  return { issueNonce, verify, sessionWallet, requireSession, resolveWallet }
}
