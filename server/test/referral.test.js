// 推荐返利 (referral rewards) 测试 — 新规则:
//   1) 首登未填分享码 → 默认推荐人 = 平台收款钱包(platformCollectionWallet)
//   2) 返利不设上限(capRaw=0 → 无上限)
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { createStore } from '../src/store.js'
import { createDirectory } from '../src/directory.js'
import { createEscrow } from '../src/escrow.js'
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
// 新规则: capRaw=0(无上限), 有默认平台收款钱包
const PLATFORM_WALLET = '9BSx7r2Vo6XVXU5Ew4TFopZsKCEo9L3MszKRGwmZ7FPu'
const CFG = {
  settleWindowSec: 60,
  callTimeoutSec: 300,
  presenceTtlSec: 15,
  referralRate: 5,
  referralCapRaw: 0,
  platformCollectionWallet: PLATFORM_WALLET,
}
const AMT = 400000
const EACH = Math.floor(AMT * 5 / 100) // 20000

async function freshEnv() {
  const file =
    path.join(os.tmpdir(), `mesh-ref-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  const store = createStore(file)
  const directory = await createDirectory(store, CFG)
  const escrow = createEscrow(store, CFG, directory.get, directory.recordCall)
  const providerKp = nacl.sign.keyPair()
  const consumerKp = nacl.sign.keyPair()
  const listing = {
    id: 'pending',
    provider: bs58.encode(providerKp.publicKey),
    p2pPublicKey: 'sim-p2p-key',
    model: { name: 'test-model', maxContext: 8192 },
    pricing: PRICING,
    limits: { maxTokens: 1000, maxConcurrency: 1 },
    metering: { tolerancePct: 5 },
    bondUsdtRaw: 100_000_000,
    version: 1,
  }
  listing.id = await listingHashOf(listing)
  const sig = b64encode(nacl.sign.detached(new Uint8Array(Buffer.from(listing.id, 'hex')), providerKp.secretKey))
  const saved = await directory.upsertSigned({ listing, signatureB64: sig, wallet: listing.provider })
  const wallet = (kp) => bs58.encode(kp.publicKey)
  const sign = (kp, digest) => b64encode(nacl.sign.detached(digest, kp.secretKey))
  const p = wallet(providerKp)
  const c = wallet(consumerKp)
  store.set('balances', { [c]: 100_000_000, [p]: 0, [PLATFORM_WALLET]: 0 })
  async function makeReceipt(sid, in_, out_, signerKp = providerKp, cache = 0) {
    const payload = receiptPayloadForHash({
      listingId: saved.id, sessionId: sid,
      transcriptHash: sha256Hex(utf8('t-' + sid)), tokensIn: in_, tokensOut: out_,
      tokensCache: cache, ts: Date.now(),
    })
    return { ...payload, signature: sign(signerKp, await receiptDigest(payload)) }
  }
  return { store, escrow, p, c, listing: saved, sign, providerKp, consumerKp, makeReceipt }
}

async function settleFast(env, in_ = 1000, out_ = 1000) {
  const { escrow, p, c, listing, sign, providerKp, consumerKp, makeReceipt } = env
  const sid = 's-' + Date.now() + Math.random().toString(36).slice(2)
  escrow.fund({ consumer: c, listingId: listing.id, amountRaw: FUND, wallet: c })
  escrow.beginCall({ consumer: c, listingId: listing.id, sessionId: sid, wallet: c })
  const receipt = await makeReceipt(sid, in_, out_, providerKp, 0)
  await escrow.submitReceipt({ consumer: c, listingId: listing.id, receipt, wallet: c })
  const digest = await receiptDigest(receipt)
  await escrow.settleFast({
    consumer: c, listingId: listing.id,
    acceptSigB64: sign(consumerKp, digest), attestSigB64: sign(providerKp, digest), wallet: c,
  })
}

test('recordReferral: 无 refCode → 默认绑定平台收款钱包', async () => {
  const env = await freshEnv()
  const r = env.escrow.recordReferral(env.c, '', CFG)
  assert.equal(r.bound, true)
  assert.equal(r.referrer, PLATFORM_WALLET)
  assert.equal(r.refCode, PLATFORM_WALLET)
  assert.equal(r.defaultPlatform, true)
  assert.equal(env.escrow.getReferral(env.c).referrer, PLATFORM_WALLET)
})

test('recordReferral: undefined refCode → 默认绑定平台收款钱包', async () => {
  const env = await freshEnv()
  const r = env.escrow.recordReferral(env.c, undefined, CFG)
  assert.equal(r.bound, true)
  assert.equal(r.referrer, PLATFORM_WALLET)
})

test('recordReferral: 有效分享码 → 绑定到该码(非平台)', async () => {
  const env = await freshEnv()
  const other = env.p // 用另一个有效钱包
  const r = env.escrow.recordReferral(env.c, other, CFG)
  assert.equal(r.bound, true)
  assert.equal(r.referrer, other)
  assert.equal(r.defaultPlatform, false)
  assert.notEqual(r.referrer, PLATFORM_WALLET)
})

test('recordReferral: 填了平台码 → 等价默认平台', async () => {
  const env = await freshEnv()
  const r = env.escrow.recordReferral(env.c, PLATFORM_WALLET, CFG)
  assert.equal(r.bound, true)
  assert.equal(r.referrer, PLATFORM_WALLET)
  assert.equal(r.defaultPlatform, true)
})

test('recordReferral: 无效码 → 回落到平台默认', async () => {
  const env = await freshEnv()
  const r = env.escrow.recordReferral(env.c, 'not-a-valid-wallet', CFG)
  assert.equal(r.bound, true)
  assert.equal(r.referrer, PLATFORM_WALLET)
  assert.equal(r.defaultPlatform, true)
})

test('recordReferral: 自推码 → 回落到平台默认', async () => {
  const env = await freshEnv()
  const r = env.escrow.recordReferral(env.c, env.c, CFG)
  assert.equal(r.bound, true)
  assert.equal(r.referrer, PLATFORM_WALLET)
  assert.notEqual(r.referrer, env.c)
})

test('recordReferral: 已绑定不覆盖', async () => {
  const env = await freshEnv()
  assert.equal(env.escrow.recordReferral(env.c, env.p, CFG).bound, true)
  const r2 = env.escrow.recordReferral(env.c, '', CFG)
  assert.equal(r2.bound, false)
  assert.equal(r2.error, 'already-bound')
  assert.equal(env.escrow.getReferral(env.c).referrer, env.p)
})

test('无上限: 多次结算返利累加(不再被封顶)', async () => {
  const env = await freshEnv()
  // 无 refCode → 默认平台
  assert.equal(env.escrow.recordReferral(env.c, '', CFG).bound, true)
  const provRaw = splitFees(AMT).providerRaw
  await settleFast(env, 1000, 1000)
  await settleFast(env, 1000, 1000)
  await settleFast(env, 1000, 1000)
  const led = env.escrow.getReferralLedger(PLATFORM_WALLET)
  // 无上限 → raw = earned = 3 * EACH
  assert.equal(led.raw, EACH * 3)
  assert.equal(led.earned, EACH * 3)
})

test('平台钱包余额收到全部返利(无上限)', async () => {
  const env = await freshEnv()
  assert.equal(env.escrow.recordReferral(env.c, '', CFG).bound, true)
  await settleFast(env, 1000, 1000)
  const led = env.escrow.getReferralLedger(PLATFORM_WALLET)
  assert.equal(led.raw, EACH)
  // 平台余额 = 返利(0 因为之前为 0)
  assert.equal(env.store.get('balances', {})[PLATFORM_WALLET], EACH)
})

test('rate=0 时不发(绑定时用 rate=0 的 cfg)', async () => {
  const env = await freshEnv()
  const noRate = { ...CFG, referralRate: 0 }
  env.escrow.recordReferral(env.c, env.p, noRate)
  assert.equal(env.escrow.getReferral(env.c).refRate, 0)
  const out = env.escrow.payoutReferral(env.c, AMT, CFG)
  assert.equal(out.rewardRaw, 0)
  assert.equal(out.earnedRaw, 0)
  // 无奖励入账: 累计额为 0
  const led = env.escrow.getReferralLedger(env.p)
  assert.equal(led.raw, 0)
  assert.equal(led.earned, 0)
})

test('payoutReferral 手动调用: 未绑定 → referrer=null; 绑定 → 正常发奖', async () => {
  const env = await freshEnv()
  // 未绑定前
  const out0 = env.escrow.payoutReferral(env.c, AMT, CFG)
  assert.equal(out0.referrer, null)
  assert.equal(out0.rewardRaw, 0)
  assert.equal(out0.earnedRaw, 0)
  // 绑定后: 非平台码
  const refCode = env.p
  const bind = env.escrow.recordReferral(env.c, refCode, CFG)
  assert.equal(bind.bound, true)
  const out = env.escrow.payoutReferral(env.c, AMT, CFG)
  assert.equal(out.referrer, refCode)
  assert.equal(out.amountRaw, AMT)
  assert.equal(out.rewardRaw, EACH)
  assert.equal(out.earnedRaw, EACH)
  assert.equal(out.capRaw, 0)
})

test('payoutReferral: 无 referrer 时短路', async () => {
  const env = await freshEnv()
  const o = env.escrow.payoutReferral(env.c, AMT, CFG)
  assert.equal(o.referrer, null)
  assert.equal(o.rewardRaw, 0)
})

test('amountRaw=0 不发', async () => {
  const env = await freshEnv()
  env.escrow.recordReferral(env.c, env.p, CFG)
  const o = env.escrow.payoutReferral(env.c, 0, CFG)
  assert.equal(o.rewardRaw, 0)
  assert.equal(o.earnedRaw, 0)
})

test('resolve(payRaw>0) 触发, 全额退款不触发(无上限)', async () => {
  const env = await freshEnv()
  const { c, p, listing, sign, providerKp, consumerKp, makeReceipt } = env
  const provRaw = splitFees(AMT).providerRaw

  // 场景 A: 部分退款 payRaw=400000 -> 触发 EACH
  env.escrow.recordReferral(c, p, CFG)
  env.escrow.fund({ consumer: c, listingId: listing.id, amountRaw: 500_000, wallet: c })
  env.escrow.beginCall({ consumer: c, listingId: listing.id, sessionId: 'r-1', wallet: c })
  const r1 = await makeReceipt('r-1', 1000, 1000, providerKp, 0)
  await env.escrow.submitReceipt({ consumer: c, listingId: listing.id, receipt: r1, wallet: c })
  env.escrow.dispute({ actor: 'consumer', consumer: c, listingId: listing.id, reason: 'partial', wallet: c })
  const d1 = await receiptDigest(r1)
  await env.escrow.resolve({ consumer: c, listingId: listing.id, refundRaw: 100_000, sigConsumerB64: sign(consumerKp, d1), sigProviderB64: sign(providerKp, d1), wallet: c })
  assert.equal(env.escrow.getReferralLedger(p).raw, EACH)

  // 场景 B: 全额退款 -> 不触发
  const env2 = await freshEnv()
  const { c: c2, p: p2, listing: listing2, sign: s2, providerKp: pk2, consumerKp: ck2, makeReceipt: mr2 } = env2
  env2.escrow.recordReferral(c2, p2, CFG)
  env2.escrow.fund({ consumer: c2, listingId: listing2.id, amountRaw: 500_000, wallet: c2 })
  env2.escrow.beginCall({ consumer: c2, listingId: listing2.id, sessionId: 'r-2', wallet: c2 })
  const r2 = await mr2('r-2', 1000, 1000, pk2, 0)
  await env2.escrow.submitReceipt({ consumer: c2, listingId: listing2.id, receipt: r2, wallet: c2 })
  env2.escrow.dispute({ actor: 'consumer', consumer: c2, listingId: listing2.id, reason: 'full', wallet: c2 })
  const d2 = await receiptDigest(r2)
  await env2.escrow.resolve({ consumer: c2, listingId: listing2.id, refundRaw: 500_000, sigConsumerB64: s2(ck2, d2), sigProviderB64: s2(pk2, d2), wallet: c2 })
  assert.equal(env2.escrow.getReferralLedger(p2).raw, 0)
  assert.equal(env2.escrow.getReferralLedger(p2).earned, 0)
})

test('settleWindow 也触发返利(默认平台)', async () => {
  const env = await freshEnv()
  assert.equal(env.escrow.recordReferral(env.c, '', CFG).bound, true)
  const { p, listing, sign, providerKp, consumerKp, makeReceipt } = env
  env.escrow.fund({ consumer: env.c, listingId: listing.id, amountRaw: FUND, wallet: env.c })
  env.escrow.beginCall({ consumer: env.c, listingId: listing.id, sessionId: 'w-1', wallet: env.c })
  const r1 = await makeReceipt('w-1', 1000, 1000, providerKp, 0)
  await env.escrow.submitReceipt({ consumer: env.c, listingId: listing.id, receipt: r1, wallet: env.c })
  const d1 = await receiptDigest(r1)
  for (const e of Object.values(env.store.get('escrows', {}))) {
    if (e.state === 'SETTLE_WINDOW') e.windowStartedAt -= 61_000
  }
  env.store.set('escrows', env.store.get('escrows', {}))
  await env.escrow.settleWindow({ provider: p, listingId: listing.id, attestSigB64: sign(providerKp, d1), wallet: p })
  assert.equal(env.escrow.getReferralLedger(PLATFORM_WALLET).raw, EACH)
})

test('getReferralInfo: 本人默认绑定到平台 → defaultPlatform=true', async () => {
  const env = await freshEnv()
  assert.equal(env.escrow.recordReferral(env.c, '', CFG).bound, true)
  const info = env.escrow.getReferralInfo(env.c)
  assert.equal(info.referrer, PLATFORM_WALLET)
  assert.equal(info.boundAsConsumer, true)
  assert.equal(info.defaultPlatform, true)
})