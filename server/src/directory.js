import nacl from 'tweetnacl'
import { PublicKey } from '@solana/web3.js'
import { listingHashOf, b64decode, hexToBytes } from '@mesh/shared/protocol'

export class HttpError extends Error {
  constructor(status, code) {
    super(code)
    this.status = status
    this.code = code
  }
}

// Listing registry + presence + per-listing call log (server-side simulated ledger view).
export async function createDirectory(store, cfg) {
  const now = () => Date.now()
  const listings = () => store.get('listings', {}) || {}
  const isOnline = (l) => now() - (l.lastSeen || 0) < cfg.presenceTtlSec * 1000

  async function upsertSigned({ listing, signatureB64, wallet }) {
    const computed = await listingHashOf(listing)
    if (listing.id !== computed) throw new HttpError(400, 'listing-hash-mismatch')
    if (listing.provider !== wallet) throw new HttpError(403, 'not-provider')
    let pub
    try {
      pub = new PublicKey(wallet).toBytes()
    } catch {
      throw new HttpError(400, 'bad-provider-wallet')
    }
    let ok = false
    try {
      ok = nacl.sign.detached.verify(hexToBytes(computed), b64decode(signatureB64), pub)
    } catch {
      ok = false
    }
    if (!ok) throw new HttpError(400, 'bad-signature')

    store.update('listings', (m) => {
      if (m === null) m = {}
      // a new version supersedes the previous active version of the same
      // provider + model + backend (same model on a different backend coexists)
      const model = listing.model?.name
      const sameBackend = (a, b) =>
        (a?.type || 'echo') === (b?.type || 'echo') && (a?.url || '') === (b?.url || '')
      for (const l of Object.values(m)) {
        if (
          l.provider === wallet &&
          l.model?.name === model &&
          sameBackend(l.backend, listing.backend) &&
          l.status === 'active'
        )
          l.status = 'superseded'
      }
      m[computed] = { status: 'active', ...listing, updatedAt: now(), lastSeen: now() }
      return m
    })
    return listings()[computed]
  }

  function presence(wallet, listingId) {
    store.update('listings', (m) => {
      if (m === null) m = {}
      const l = m[listingId]
      // suppressUntil:刚下线时短暂拒收心跳,防止一个已在途的旧心跳把状态翻回在线
      if (l && l.provider === wallet && !(l.suppressUntil && now() < l.suppressUntil))
        l.lastSeen = now()
      return m
    })
  }

  // 显式下线:立即清除在线状态(不等 120s TTL 衰减),并短暂抑制在途心跳
  function offline(wallet, listingId) {
    let ok = false
    store.update('listings', (m) => {
      if (m === null) m = {}
      const l = m[listingId]
      if (l && l.provider === wallet) {
        l.lastSeen = 0
        l.suppressUntil = now() + 5000
        ok = true
      }
      return m
    })
    if (!ok) throw new HttpError(404, 'not-found')
    return true
  }

  function list({ onlyOnline = false, provider = null, model = null } = {}) {
    return Object.values(listings() || {})
      .filter((l) => l.status === 'active' || l.status === 'superseded')
      .filter((l) => (onlyOnline ? isOnline(l) : true))
      .filter((l) => (provider ? l.provider === provider : true))
      .filter((l) => (model ? l.model?.name === model : true))
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
      .map(onlineSummary)
  }

  function onlineSummary(l) {
    const online = isOnline(l)
    return {
      id: l.id,
      provider: l.provider,
      model: l.model,
      pricing: l.pricing,
      limits: l.limits,
      status: l.status,
      online,
      version: l.version,
      backend: l.backend,
      bondRaw: l.bondUsdtRaw,
      updatedAt: l.updatedAt,
    }
  }

  function get(id) {
    return listings()[id] || null
  }

  function recordCall(listingId, entry) {
    const k = 'calls:' + listingId
    store.update(k, (arr) => [...(Array.isArray(arr) ? arr : []), entry].slice(-100))
  }

  function calls(listingId) {
    return store.get('calls:' + listingId, [])
  }

  // Soft delete: the provider marks a listing deleted. It disappears from the
  // market (list() only returns active/superseded) but stays in the ledger so
  // in-flight escrows for it can still settle.
  function del(wallet, listingId) {
    const l = listings()[listingId]
    if (!l) throw new HttpError(404, 'not-found')
    if (l.provider !== wallet) throw new HttpError(403, 'not-provider')
    if (l.status === 'deleted') return true
    store.update('listings', (m) => {
      if (m === null) m = {}
      const e = m[listingId]
      if (e) {
        e.status = 'deleted'
        // 立即离开市场:清 presence 并抑制在途心跳
        e.lastSeen = 0
        e.suppressUntil = now() + 5000
      }
      return m
    })
    return true
  }

  // Consumer reviews / 留言 (sim ledger, keyed by listingId).
  function addReview(wallet, listingId, body) {
    const l = listings()[listingId]
    if (!l || l.status !== 'active') throw new HttpError(404, 'listing-not-active')
    const text = String(body || '').trim().slice(0, 500)
    if (!text) throw new HttpError(400, 'empty-review')
    const entry = { wallet, text, ts: now() }
    store.update('reviews:' + listingId, (arr) =>
      [...(Array.isArray(arr) ? arr : []), entry].slice(-50)
    )
    return entry
  }

  function reviews(listingId) {
    return store.get('reviews:' + listingId, []).slice(-50).reverse()
  }

  return { upsertSigned, presence, offline, list, get, recordCall, calls, del, addReview, reviews }
}
