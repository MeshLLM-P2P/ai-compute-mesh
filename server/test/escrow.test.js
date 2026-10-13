import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { createStore } from '../src/store.js'
import { createDirectory } from '../src/directory.js'
import { createEscrow, EscrowError } from '../src/escrow.js'
import {
  listingHashOf,
  receiptPayloadForHash,
  receiptDigest,
  calcAmountRaw,
  splitFees,
  b64encode,
  utf8,
  sha256Hex,
} from '@mesh/shared/protocol'

const PRICING = { per1kInputRaw: 100000, per1kOutputRaw: 300000, per1kCacheRaw: 10000, minFeeRaw: 50000 }
const FUND = 1_000_000 // 1 USDT

async function freshEnv() {
  const file =
    path.join(os.tmpdir(), `mesh-escrow-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  const store = createStore(file)
  const cfg = { settleWindowSec: 60, callTimeoutSec: 300, presenceTtlSec: 15 }
  const directory = await createDirectory(store, cfg)
  const escrow = createEscrow(store, cfg, directory.get, directory.recordCall)
  const provider = nacl.sign.keyPair()
  const consumer = nacl.sign.keyPair()
  const listing = {
    id: 'pending',
    provider: bs58.encode(provider.publicKey),
    p2pPublicKey: 'sim-p2p-key',
    model: { name: 'test-model', maxContext: 8192 },
    pricing: PRICING,
    limits: { maxTokens: 1000, maxConcurrency: 1 },
    metering: { tolerancePct: 5 },
    bondUsdtRaw: 100_000_000,
    version: 1,
  }
  listing.id = await listingHashOf(listing)
  const sig = b64encode(nacl.sign.detached(new Uint8Array(Buffer.from(listing.id, 'hex')), provider.secretKey))
  const saved = await directory.upsertSigned({ listing, signatureB64: sig, wallet: listing.provider })

  const wallet = (kp) => bs58.encode(kp.publicKey)
  const sign = (kp, digest) => b64encode(nacl.sign.detached(digest, kp.secretKey))
  async function makeReceipt(sessionId, tokensIn, tokensOut, signerKp = provider, tokensCache = 0) {
    const payload = receiptPayloadForHash({
      listingId: saved.id,
      sessionId,
      transcriptHash: sha256Hex(utf8('transcript-' + sessionId)),
      tokensIn,
      tokensOut,
      tokensCache,
      ts: Date.now(),
    })
    return { ...payload, signature: sign(signerKp, await receiptDigest(payload)) }
  }
  const escrowKey = (c) => c + '|' + saved.id
  const shift = (field, ms) => {
    const rows = store.get('escrows', {})
    const parts = field.split('.')
    let obj = rows[escrowKey(wallet(consumer))]
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]]
    obj[parts[parts.length - 1]] -= ms
    store.set('escrows', rows)
  }
  // Sim ledger: seed the consumer with 100 USDT (same as first-login auto credit)
  store.set('balances', {
    [wallet(consumer)]: 100_000_000,
    [wallet(provider)]: 0,
  })
  return { store, cfg, directory, escrow, provider, consumer, listing: saved, wallet, sign, makeReceipt, escrowKey, shift }
}

test('happy path: fund -> call -> receipt -> dual-sig fast settle', async () => {
  const env = await freshEnv()
  const c = env.wallet(env.consumer)
  const p = env.wallet(env.provider)
  const sid = 'sess-0001'

  assert.equal(env.escrow.fund({ consumer: c, listingId: env.listing.id, amountRaw: FUND, wallet: c }).state, 'FUNDED')
  assert.equal(env.escrow.beginCall({ consumer: c, listingId: env.listing.id, sessionId: sid, wallet: c }).state, 'IN_CALL')

  const receipt = await env.makeReceipt(sid, 100, 50)
  assert.equal((await env.escrow.submitReceipt({ consumer: c, listingId: env.listing.id, receipt, wallet: c })).state, 'SETTLE_WINDOW')

  const expected = calcAmountRaw(PRICING, 100, 50) // min-fee floor: 50000
  const digest = await receiptDigest(receipt)
  const e = await env.escrow.settleFast({
    consumer: c,
    listingId: env.listing.id,
    acceptSigB64: env.sign(env.consumer, digest),
    attestSigB64: env.sign(env.provider, digest),
    wallet: c,
  })
  assert.equal(e.state, 'SETTLED')
  assert.equal(e.balanceRaw, FUND - expected)
  assert.equal(e.totalSettledRaw, expected)
  assert.equal(e.totalCalls, 1)
  assert.equal(e.tx.kind, 'settle')
  // 5% platform split: provider nets 95%, split accrues to the platform ledger
  const fees = splitFees(expected)
  assert.equal(e.tx.providerRaw, fees.providerRaw)
  assert.deepEqual(e.tx.fees, fees.parts)
  const ledger = env.store.get('platform', {})
  assert.equal(ledger.guaranteeRaw, fees.parts.guarantee)
})

test('settle: cache-hit tokens bill at per1kCacheRaw', async () => {
  const env = await freshEnv()
  const c = env.wallet(env.consumer)
  const p = env.wallet(env.provider)
  const sid = 'sess-cache-01'

  env.escrow.fund({ consumer: c, listingId: env.listing.id, amountRaw: FUND, wallet: c })
  env.escrow.beginCall({ consumer: c, listingId: env.listing.id, sessionId: sid, wallet: c })
  const receipt = await env.makeReceipt(sid, 100, 50, env.provider, 40)
  await env.escrow.submitReceipt({ consumer: c, listingId: env.listing.id, receipt, wallet: c })

  const expected = calcAmountRaw(PRICING, 100, 50, 40)
  const digest = await receiptDigest(receipt)
  const e = await env.escrow.settleFast({
    consumer: c,
    listingId: env.listing.id,
    acceptSigB64: env.sign(env.consumer, digest),
    attestSigB64: env.sign(env.provider, digest),
    wallet: c,
  })
  assert.equal(e.tx.amountRaw, expected)
  assert.equal(e.tx.providerRaw, splitFees(expected).providerRaw)
})

test('settle-fast without a submitted receipt fails cleanly (no 500)', async () => {
  const env = await freshEnv()
  const c = env.wallet(env.consumer)
  const sid = 'sess-noreceipt-01'

  env.escrow.fund({ consumer: c, listingId: env.listing.id, amountRaw: FUND, wallet: c })
  env.escrow.beginCall({ consumer: c, listingId: env.listing.id, sessionId: sid, wallet: c })
  await assert.rejects(
    env.escrow.settleFast({
      consumer: c,
      listingId: env.listing.id,
      acceptSigB64: env.sign(env.consumer, new Uint8Array(32)),
      attestSigB64: env.sign(env.provider, new Uint8Array(32)),
      wallet: c,
    }),
    { code: 'no-receipt-to-settle' }
  )
})

test('window settle: provider settles alone after the settle window', async () => {
  const env = await freshEnv()
  const c = env.wallet(env.consumer)
  const p = env.wallet(env.provider)
  const sid = 'sess-0002'

  env.escrow.fund({ consumer: c, listingId: env.listing.id, amountRaw: FUND, wallet: c })
  env.escrow.beginCall({ consumer: c, listingId: env.listing.id, sessionId: sid, wallet: c })
  const receipt = await env.makeReceipt(sid, 200, 100)
  await env.escrow.submitReceipt({ consumer: c, listingId: env.listing.id, receipt, wallet: c })

  const digest = await receiptDigest(receipt)
  // window not elapsed yet
  await assert.rejects(
    env.escrow.settleWindow({ provider: p, listingId: env.listing.id, attestSigB64: env.sign(env.provider, digest), wallet: p }),
    { code: 'window-not-elapsed' }
  )

  env.shift('windowStartedAt', 61 * 1000)
  const e = await env.escrow.settleWindow({
    provider: p,
    listingId: env.listing.id,
    attestSigB64: env.sign(env.provider, digest),
    wallet: p,
  })
  assert.equal(e.state, 'SETTLED')
  assert.equal(e.tx.kind, 'settle-window')
  assert.equal(e.totalCalls, 1)
})

test('call timeout: consumer refunds the earmark', async () => {
  const env = await freshEnv()
  const c = env.wallet(env.consumer)
  const sid = 'sess-0003'

  env.escrow.fund({ consumer: c, listingId: env.listing.id, amountRaw: FUND, wallet: c })
  env.escrow.beginCall({ consumer: c, listingId: env.listing.id, sessionId: sid, wallet: c })
  assert.throws(
    () => env.escrow.refund({ consumer: c, listingId: env.listing.id, wallet: c }),
    (e) => e.code === 'call-not-timed-out'
  )
  env.shift('call.ts', 301 * 1000)
  const e = env.escrow.refund({ consumer: c, listingId: env.listing.id, wallet: c })
  assert.equal(e.state, 'FUNDED')
  assert.equal(e.call, null)
  assert.equal(e.balanceRaw, FUND)
})

test('consumer cancel: immediate IN_CALL -> FUNDED without waiting the timeout', async () => {
  const env = await freshEnv()
  const c = env.wallet(env.consumer)
  const sid = 'sess-0006'

  env.escrow.fund({ consumer: c, listingId: env.listing.id, amountRaw: FUND, wallet: c })
  env.escrow.beginCall({ consumer: c, listingId: env.listing.id, sessionId: sid, wallet: c })

  // no timeout shift — cancel works immediately
  const e = env.escrow.cancel({ consumer: c, listingId: env.listing.id, wallet: c })
  assert.equal(e.state, 'FUNDED')
  assert.equal(e.call, null)
  assert.equal(e.balanceRaw, FUND)

  // FUNDED (call never entered IN_CALL, e.g. connect failure) → whole
  // amount released back to the available balance (row goes EMPTY)
  const e2 = env.escrow.cancel({ consumer: c, listingId: env.listing.id, wallet: c })
  assert.equal(e2.state, 'EMPTY')
  assert.equal(e2.balanceRaw, FUND)

  // only the consumer may cancel
  assert.throws(
    () => env.escrow.cancel({ consumer: c, listingId: env.listing.id, wallet: env.wallet(env.provider) }),
    (err) => err.code === 'forbidden'
  )

  // and a follow-up fund + beginCall on the same row still works
  env.escrow.fund({ consumer: c, listingId: env.listing.id, amountRaw: FUND, wallet: c })
  assert.equal(
    env.escrow.beginCall({ consumer: c, listingId: env.listing.id, sessionId: 'sess-again', wallet: c }).state,
    'IN_CALL'
  )
})

test('stale IN_CALL row: beginCall auto-releases the orphan and re-enters', async () => {
  const env = await freshEnv()
  const c = env.wallet(env.consumer)

  env.escrow.fund({ consumer: c, listingId: env.listing.id, amountRaw: FUND, wallet: c })
  env.escrow.beginCall({ consumer: c, listingId: env.listing.id, sessionId: 'sess-old', wallet: c })

  // live IN_CALL: a concurrent beginCall is still rejected
  assert.throws(
    () => env.escrow.beginCall({ consumer: c, listingId: env.listing.id, sessionId: 'sess-2', wallet: c }),
    (e) => e.code === 'begin-call-not-allowed-in-IN_CALL'
  )

  // after the 300s protocol timeout the orphan row is released and re-entered
  env.shift('call.ts', 301 * 1000)
  const e = env.escrow.beginCall({ consumer: c, listingId: env.listing.id, sessionId: 'sess-3', wallet: c })
  assert.equal(e.state, 'IN_CALL')
  assert.equal(e.call.sessionId, 'sess-3')
  assert.equal(e.balanceRaw, FUND)
})

test('dispute then resolve with dual signatures', async () => {
  const env = await freshEnv()
  const c = env.wallet(env.consumer)
  const p = env.wallet(env.provider)
  const sid = 'sess-0004'

  env.escrow.fund({ consumer: c, listingId: env.listing.id, amountRaw: FUND, wallet: c })
  env.escrow.beginCall({ consumer: c, listingId: env.listing.id, sessionId: sid, wallet: c })
  const receipt = await env.makeReceipt(sid, 100, 100)
  await env.escrow.submitReceipt({ consumer: c, listingId: env.listing.id, receipt, wallet: c })

  const d = env.escrow.dispute({ actor: 'consumer', consumer: c, listingId: env.listing.id, reason: 'wrong output', wallet: c })
  assert.equal(d.state, 'DISPUTED')
  assert.equal(d.dispute.frozenRaw, FUND)

  const digest = await receiptDigest(receipt)
  const refundRaw = 400_000
  const e = await env.escrow.resolve({
    consumer: c,
    listingId: env.listing.id,
    refundRaw,
    sigConsumerB64: env.sign(env.consumer, digest),
    sigProviderB64: env.sign(env.provider, digest),
    wallet: c,
  })
  assert.equal(e.state, 'FUNDED')
  assert.equal(e.balanceRaw, refundRaw)
  assert.equal(e.totalSettledRaw, FUND - refundRaw)
  assert.equal(e.totalCalls, 1)
})

test('tampered receipts and bad signatures are rejected', async () => {
  const env = await freshEnv()
  const c = env.wallet(env.consumer)
  const sid = 'sess-0005'

  env.escrow.fund({ consumer: c, listingId: env.listing.id, amountRaw: FUND, wallet: c })
  env.escrow.beginCall({ consumer: c, listingId: env.listing.id, sessionId: sid, wallet: c })

  // receipt signed by the consumer instead of the provider
  const bad = await env.makeReceipt(sid, 10, 10, env.consumer)
  await assert.rejects(
    env.escrow.submitReceipt({ consumer: c, listingId: env.listing.id, receipt: bad, wallet: c }),
    { code: 'bad-signature' }
  )

  // fund not allowed while IN_CALL
  assert.throws(
    () => env.escrow.fund({ consumer: c, listingId: env.listing.id, amountRaw: 1000, wallet: c }),
    (e) => e.code === 'fund-not-allowed-in-IN_CALL'
  )

  // only the consumer (row owner) may operate consumer-side ops
  assert.throws(
    () => env.escrow.beginCall({ consumer: c, listingId: env.listing.id, sessionId: 'x', wallet: env.wallet(env.provider) }),
    (e) => e.code === 'forbidden'
  )
})

test('listing versioning: new price = new id, old listing superseded', async () => {
  const env = await freshEnv()
  const p = env.wallet(env.provider)
  const v2 = { ...env.listing, version: 2, pricing: { ...PRICING, minFeeRaw: 60000 } }
  v2.id = 'pending'
  v2.id = await listingHashOf(v2)
  assert.notEqual(v2.id, env.listing.id)
  const sig = b64encode(nacl.sign.detached(new Uint8Array(Buffer.from(v2.id, 'hex')), env.provider.secretKey))
  const saved2 = await env.directory.upsertSigned({ listing: v2, signatureB64: sig, wallet: p })
  assert.equal(saved2.status, 'active')
  assert.equal(env.directory.get(env.listing.id).status, 'superseded')

  // hash mismatch rejected
  const badListing = { ...v2, id: v2.id, pricing: { ...PRICING, minFeeRaw: 1 } }
  await assert.rejects(
    env.directory.upsertSigned({ listing: badListing, signatureB64: sig, wallet: p }),
    { code: 'listing-hash-mismatch' }
  )
})

test('bonds: post, read, slash', async () => {
  const env = await freshEnv()
  const p = env.wallet(env.provider)
  assert.equal(env.escrow.postBond({ provider: p, listingId: env.listing.id, amountRaw: 100_000_000, wallet: p }), 100_000_000)
  assert.equal(env.escrow.bondOf(p, env.listing.id), 100_000_000)
  assert.equal(env.escrow.slash({ provider: p, listingId: env.listing.id, amountRaw: 25_000_000, by: 'mediator' }), 75_000_000)
  assert.equal(env.escrow.bondOf(p, env.listing.id), 75_000_000)
})

test('sim balances: fund capped by available; settle transfers; receipt logs latency', async () => {
  const env = await freshEnv()
  const c = env.wallet(env.consumer)
  const p = env.wallet(env.provider)
  const sid = 'sess-bal-01'

  assert.throws(
    () => env.escrow.fund({ consumer: c, listingId: env.listing.id, amountRaw: 101_000_000, wallet: c }),
    (e) => e.code === 'insufficient-balance'
  )
  env.escrow.fund({ consumer: c, listingId: env.listing.id, amountRaw: FUND, wallet: c })
  // while FUNDED the earmark is frozen: available = balance - frozen
  assert.throws(
    () => env.escrow.fund({ consumer: c, listingId: env.listing.id, amountRaw: 99_000_001, wallet: c }),
    (e) => e.code === 'insufficient-balance'
  )

  env.escrow.beginCall({ consumer: c, listingId: env.listing.id, sessionId: sid, wallet: c })
  const receipt = await env.makeReceipt(sid, 256, 256)
  await env.escrow.submitReceipt({ consumer: c, listingId: env.listing.id, receipt, wallet: c })

  const digest = await receiptDigest(receipt)
  const after = await env.escrow.settleFast({
    consumer: c,
    listingId: env.listing.id,
    acceptSigB64: env.sign(env.consumer, digest),
    attestSigB64: env.sign(env.provider, digest),
    wallet: c,
  })
  assert.equal(after.state, 'SETTLED')
  const amount = after.tx.amountRaw
  const balances = env.store.get('balances', {})
  assert.equal(balances[c], 100_000_000 - amount)
  // provider nets 95% after the 5% platform split
  assert.equal(balances[p], splitFees(amount).providerRaw)

  const rcpt = env.directory.calls(env.listing.id).find((x) => x.event === 'receipt')
  assert.ok(rcpt && rcpt.latencyMs > 0)
})

test('SETTLED row archives on next beginCall / fund: remainder + counters carry over', async () => {
  const env = await freshEnv()
  const c = env.wallet(env.consumer)
  const p = env.wallet(env.provider)
  const k = env.escrowKey(c)

  // first call: fund 1 USDT, settle → remainder stays on the SETTLED row
  env.escrow.fund({ consumer: c, listingId: env.listing.id, amountRaw: FUND, wallet: c })
  env.escrow.beginCall({ consumer: c, listingId: env.listing.id, sessionId: 'sess-arch-01', wallet: c })
  const receipt = await env.makeReceipt('sess-arch-01', 100, 50)
  await env.escrow.submitReceipt({ consumer: c, listingId: env.listing.id, receipt, wallet: c })
  const digest = await receiptDigest(receipt)
  const settled = await env.escrow.settleFast({
    consumer: c,
    listingId: env.listing.id,
    acceptSigB64: env.sign(env.consumer, digest),
    attestSigB64: env.sign(env.provider, digest),
    wallet: c,
  })
  assert.equal(settled.state, 'SETTLED')
  const remainder = settled.balanceRaw
  assert.ok(remainder > 0)

  // second call on the SAME consumer+listing: beginCall must archive, not reject
  const fresh = env.escrow.beginCall({ consumer: c, listingId: env.listing.id, sessionId: 'sess-arch-02', wallet: c })
  assert.equal(fresh.state, 'IN_CALL')
  assert.equal(fresh.call.sessionId, 'sess-arch-02')
  assert.equal(fresh.balanceRaw, remainder) // remainder carried to the new row
  assert.equal(fresh.totalCalls, 1)
  assert.equal(fresh.totalSettledRaw, settled.tx.amountRaw) // lifetime counters preserved

  const rows = env.store.get('escrows', {})
  const archivedKey = k + ':archived:' + settled.tx.txId
  assert.ok(rows[archivedKey], 'archived row must exist')
  assert.equal(rows[archivedKey].archived, true)
  assert.equal(rows[archivedKey].state, 'SETTLED')
  assert.equal(rows[archivedKey].tx.txId, settled.tx.txId)
  assert.equal(rows[archivedKey].balanceRaw, 0)

  // settle the second call, then fund: fund must archive too
  const receipt2 = await env.makeReceipt('sess-arch-02', 100, 50)
  await env.escrow.submitReceipt({ consumer: c, listingId: env.listing.id, receipt: receipt2, wallet: c })
  const d2 = await receiptDigest(receipt2)
  const settled2 = await env.escrow.settleFast({
    consumer: c,
    listingId: env.listing.id,
    acceptSigB64: env.sign(env.consumer, d2),
    attestSigB64: env.sign(env.provider, d2),
    wallet: c,
  })
  assert.equal(settled2.state, 'SETTLED')
  const funded = env.escrow.fund({ consumer: c, listingId: env.listing.id, amountRaw: 500_000, wallet: c })
  assert.equal(funded.state, 'FUNDED')
  assert.equal(funded.balanceRaw, settled2.balanceRaw + 500_000)
  const rows2 = env.store.get('escrows', {})
  assert.ok(rows2[k + ':archived:' + settled2.tx.txId])
  assert.equal(rows2[k].archived, undefined)
})

test('P3: provider reputation tracks call/settle/dispute events', async () => {
  const env = await freshEnv()
  const c = env.wallet(env.consumer)
  const p = env.wallet(env.provider)

  // call + settle
  env.escrow.fund({ consumer: c, listingId: env.listing.id, amountRaw: FUND, wallet: c })
  env.escrow.beginCall({ consumer: c, listingId: env.listing.id, sessionId: 'sess-rep-01', wallet: c })
  const receipt = await env.makeReceipt('sess-rep-01', 100, 50)
  await env.escrow.submitReceipt({ consumer: c, listingId: env.listing.id, receipt, wallet: c })
  const digest = await receiptDigest(receipt)
  await env.escrow.settleFast({
    consumer: c,
    listingId: env.listing.id,
    acceptSigB64: env.sign(env.consumer, digest),
    attestSigB64: env.sign(env.provider, digest),
    wallet: c,
  })
  let rep = env.escrow.providerReputation()[p]
  assert.equal(rep.calls, 1)
  assert.equal(rep.settled, 1)
  assert.equal(rep.disputes, 0)
  assert.equal(rep.disputesLost, 0)

  // consumer dispute (counts as a dispute against the provider)
  env.escrow.beginCall({ consumer: c, listingId: env.listing.id, sessionId: 'sess-rep-02', wallet: c })
  const receipt2 = await env.makeReceipt('sess-rep-02', 100, 100)
  await env.escrow.submitReceipt({ consumer: c, listingId: env.listing.id, receipt: receipt2, wallet: c })
  env.escrow.dispute({ actor: 'consumer', consumer: c, listingId: env.listing.id, reason: 'bad', wallet: c })
  rep = env.escrow.providerReputation()[p]
  assert.equal(rep.calls, 2)
  assert.equal(rep.disputes, 1)
})

test('P3: full-refund dispute resolution auto-slashes the provider bond', async () => {
  const env = await freshEnv()
  const c = env.wallet(env.consumer)
  const p = env.wallet(env.provider)

  // provider posts a bond for the listing
  env.escrow.postBond({ provider: p, listingId: env.listing.id, amountRaw: 100_000_000, wallet: p })
  assert.equal(env.escrow.bondOf(p, env.listing.id), 100_000_000)

  // call -> receipt -> consumer dispute -> resolve with FULL refund (provider fault)
  env.escrow.fund({ consumer: c, listingId: env.listing.id, amountRaw: FUND, wallet: c })
  env.escrow.beginCall({ consumer: c, listingId: env.listing.id, sessionId: 'sess-slash-01', wallet: c })
  const receipt = await env.makeReceipt('sess-slash-01', 100, 100)
  await env.escrow.submitReceipt({ consumer: c, listingId: env.listing.id, receipt, wallet: c })
  const d = env.escrow.dispute({ actor: 'consumer', consumer: c, listingId: env.listing.id, reason: 'no delivery', wallet: c })
  assert.equal(d.dispute.frozenRaw, FUND)

  const digest = await receiptDigest(receipt)
  const e = await env.escrow.resolve({
    consumer: c,
    listingId: env.listing.id,
    refundRaw: FUND, // full refund = provider fault
    sigConsumerB64: env.sign(env.consumer, digest),
    sigProviderB64: env.sign(env.provider, digest),
    wallet: c,
  })
  assert.equal(e.state, 'FUNDED') // full refund: balance returns to the consumer's row
  assert.equal(e.balanceRaw, FUND)

  // bond auto-slashed by the frozen amount (capped at bond balance)
  assert.equal(env.escrow.bondOf(p, env.listing.id), 100_000_000 - FUND)
  const rep = env.escrow.providerReputation()[p]
  assert.equal(rep.disputesLost, 1)
  assert.equal(rep.refundedRaw, FUND)
  // the auto-slash is recorded in the listing call log
  const slash = env.directory.calls(env.listing.id).find((x) => x.event === 'slash' && x.by === 'auto')
  assert.ok(slash, 'auto slash event must be recorded')
  assert.equal(slash.amountRaw, FUND)
})

test('P3: partial-refund resolution does NOT slash the bond', async () => {
  const env = await freshEnv()
  const c = env.wallet(env.consumer)
  const p = env.wallet(env.provider)

  env.escrow.postBond({ provider: p, listingId: env.listing.id, amountRaw: 100_000_000, wallet: p })
  env.escrow.fund({ consumer: c, listingId: env.listing.id, amountRaw: FUND, wallet: c })
  env.escrow.beginCall({ consumer: c, listingId: env.listing.id, sessionId: 'sess-slash-02', wallet: c })
  const receipt = await env.makeReceipt('sess-slash-02', 100, 100)
  await env.escrow.submitReceipt({ consumer: c, listingId: env.listing.id, receipt, wallet: c })
  env.escrow.dispute({ actor: 'consumer', consumer: c, listingId: env.listing.id, reason: 'partial', wallet: c })

  const digest = await receiptDigest(receipt)
  const e = await env.escrow.resolve({
    consumer: c,
    listingId: env.listing.id,
    refundRaw: 400_000, // partial refund: provider still gets paid
    sigConsumerB64: env.sign(env.consumer, digest),
    sigProviderB64: env.sign(env.provider, digest),
    wallet: c,
  })
  assert.equal(e.state, 'FUNDED')
  // bond untouched
  assert.equal(env.escrow.bondOf(p, env.listing.id), 100_000_000)
  const rep = env.escrow.providerReputation()[p]
  assert.equal(rep.disputesLost, 0)
  assert.equal(rep.settled, 1) // consumer paid the remainder
})
