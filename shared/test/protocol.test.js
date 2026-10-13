import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canonical,
  sha256Hex,
  utf8,
  transcriptHash,
  calcAmountRaw,
  splitFees,
  listingHashOf,
  estimateTokens,
  turnInputEstimate,
  receiptPayloadForHash,
  mixDigest,
  bytesToHex,
  hexToBytes,
} from '../src/protocol.js'

test('canonical is deterministic and key-order independent', async () => {
  const a = { z: 1, b: { y: 2, x: [1, 2, 3] }, a: 'hi' }
  const b = { a: 'hi', b: { x: [1, 2, 3], y: 2 }, z: 1 }
  assert.equal(canonical(a), canonical(b))
  assert.equal(canonical(a), '{"a":"hi","b":{"x":[1,2,3],"y":2},"z":1}')
})

test('transcriptHash is deterministic and content-sensitive', async () => {
  const params = { maxPromptTokens: 2048, metering: 'chars/4' }
  const msgs = [
    { role: 'user', content: 'hello 你好' },
    { role: 'assistant', content: 'hi there' },
  ]
  const h1 = await transcriptHash('sess-1', params, msgs)
  const h2 = await transcriptHash('sess-1', params, msgs.map((m) => ({ ...m })))
  assert.equal(h1, h2)
  const h3 = await transcriptHash('sess-1', params, [
    { role: 'user', content: 'hello 你好' },
    { role: 'assistant', content: 'hi there!' },
  ])
  assert.notEqual(h1, h3)
  const h4 = await transcriptHash('sess-2', params, msgs)
  assert.notEqual(h1, h4)
})

test('calcAmountRaw: exact integer math with minFee and ceil', () => {
  const price = { per1kInputRaw: 500, per1kOutputRaw: 1500, minFeeRaw: 10 }
  // 100 in * 500/1000 = 50 ; 200 out * 1500/1000 = 300 → 350
  assert.equal(calcAmountRaw(price, 100, 200), 350)
  // ceiling: 1 in * 500/1000 = 0.5 → 1
  assert.equal(calcAmountRaw({ per1kInputRaw: 500, per1kOutputRaw: 0, minFeeRaw: 0 }, 1, 0), 1)
  // minFee dominates
  assert.equal(calcAmountRaw(price, 0, 0), 10)
})

test('calcAmountRaw: cache-hit tokens bill at per1kCacheRaw (fallback input price)', () => {
  const price = { per1kInputRaw: 500, per1kOutputRaw: 1500, per1kCacheRaw: 100, minFeeRaw: 10 }
  // 100 in + 50 cache: ceil(100*500/1000)=50 + ceil(50*100/1000)=5 + 0 out → 55
  assert.equal(calcAmountRaw(price, 100, 0, 50), 55)
  // no per1kCacheRaw → cache tokens fall back to the input price
  const noCache = { per1kInputRaw: 500, per1kOutputRaw: 1500, minFeeRaw: 10 }
  assert.equal(calcAmountRaw(noCache, 100, 0, 50), 75)
  // zero cache = legacy behaviour; minFee still applies
  assert.equal(calcAmountRaw(price, 0, 0, 0), 10)
})

test('splitFees: 1% maintenance + 2% guarantee + 2% promotion, provider keeps the rest', () => {
  // 1,000,000 → 10,000 / 20,000 / 20,000 / provider 950,000
  const s = splitFees(1_000_000)
  assert.deepEqual(s.parts, { maintenance: 10_000, guarantee: 20_000, promotion: 20_000 })
  assert.equal(s.totalRaw, 50_000)
  assert.equal(s.providerRaw, 950_000)
  assert.equal(s.providerRaw + s.totalRaw, 1_000_000)
  // sub-micro rounding is floored into the provider remainder
  const s2 = splitFees(101)
  assert.equal(s2.totalRaw + s2.providerRaw, 101)
  assert.equal(splitFees(0).providerRaw, 0)
})

test('listingHashOf: stable, excludes updatedAt, version-sensitive', async () => {
  const base = {
    provider: 'PROV1',
    p2pPublicKey: 'PUB1',
    model: { name: 'm', family: 'llama', contextLen: 8192 },
    pricing: { per1kInputRaw: 500, per1kOutputRaw: 1500, minFeeRaw: 10 },
    limits: { maxConcurrent: 4, maxPromptTokens: 2048, timeoutSec: 300 },
    metering: 'chars/4',
    bondUsdtRaw: 100_000_000,
    version: 1,
  }
  const h1 = await listingHashOf({ ...base, updatedAt: 1 })
  const h2 = await listingHashOf({ ...base, updatedAt: 999 })
  assert.equal(h1, h2)
  const h3 = await listingHashOf({ ...base, version: 2 })
  assert.notEqual(h1, h3)
  const h4 = await listingHashOf({ ...base, pricing: { per1kInputRaw: 501, per1kOutputRaw: 1500, minFeeRaw: 10 } })
  assert.notEqual(h1, h4)
})

test('estimateTokens: ceil(chars/4)', () => {
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
  assert.equal(estimateTokens(''), 0)
})

test('turnInputEstimate: sums per-message estimates over the full history', () => {
  const h1 = [{ role: 'user', content: 'abcd' }]
  assert.equal(turnInputEstimate(h1), 1)
  const h2 = [
    { role: 'user', content: 'abcd' },
    { role: 'assistant', content: 'wxyz' },
    { role: 'user', content: 'abcdabcd' },
  ]
  // 1 + 1 + 2 = 4 (turn-2 input counts the whole replayed context)
  assert.equal(turnInputEstimate(h2), 4)
  assert.equal(turnInputEstimate([]), 0)
})

test('multi-turn receipt: provider accumulation == consumer re-verification', async () => {
  const params = { maxPromptTokens: 2048, metering: 'chars/4' }
  const turns = [
    { prompt: '第一轮问题', reply: '第一轮回答' },
    { prompt: '第二轮追问', reply: '第二轮回答' },
  ]
  // ---- provider side: accumulate exactly like handleBusiness/sendFinalReceipt
  const history = []
  let tokensIn = 0
  let tokensOut = 0
  for (const t of turns) {
    history.push({ role: 'user', content: t.prompt })
    tokensIn += turnInputEstimate(history)
    history.push({ role: 'assistant', content: t.reply })
    tokensOut += estimateTokens(t.reply)
  }
  const txHash = await transcriptHash('sess-mt', params, history)
  const payload = receiptPayloadForHash({
    listingId: 'LST',
    sessionId: 'sess-mt',
    transcriptHash: txHash,
    tokensIn,
    tokensOut,
    tokensCache: 0,
    ts: 123,
  })
  // ---- consumer side: re-verify exactly like verifyReceipt
  const cMessages = []
  let cTi = 0
  let cTo = 0
  for (const t of turns) {
    cMessages.push({ role: 'user', content: t.prompt })
    cTi += turnInputEstimate(cMessages)
    cMessages.push({ role: 'assistant', content: t.reply })
    cTo += estimateTokens(t.reply)
  }
  const cHash = await transcriptHash('sess-mt', params, cMessages)
  assert.equal(cHash, txHash)
  assert.equal(cTi, payload.tokensIn)
  assert.equal(cTo, payload.tokensOut)
  // turn-2 input must count the replayed context, so tokensIn > single-turn sum
  const single = estimateTokens(turns[0].prompt) + estimateTokens(turns[1].prompt)
  assert.ok(payload.tokensIn > single)
})

test('mixDigest is symmetric in the two ephemeral keys', async () => {
  const a = hexToBytes('aa'.repeat(32))
  const b = hexToBytes('bb'.repeat(32))
  const session = utf8('sess')
  const m1 = await mixDigest(a, b, session)
  const m2 = await mixDigest(b, a, session)
  assert.equal(bytesToHex(m1), bytesToHex(m2))
  const m3 = await mixDigest(a, a, session)
  assert.notEqual(bytesToHex(m1), bytesToHex(m3))
})

test('sha256Hex known vector', async () => {
  // sha256("")
  assert.equal(await sha256Hex(utf8('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})
