// 计费口径:真实 usage 归一化 + 单边上限校验。
//
// 这组测试锁住一个具体回归:改成真实 usage 后,中文调用的真实 token 数是
// chars/4 估算的 4~6 倍,旧的 ±5% 双向比对会把**正确**的回执判死。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  turnInputChars,
  tokenCeiling,
  checkMeteringBounds,
  METERING_MAX_TOKENS_PER_CHAR,
  METERING_TEMPLATE_TOKENS,
} from '../src/protocol.js'
import { usageTokensOf } from '../src/channel.js'

test('usageTokensOf:OpenAI 形状', () => {
  const u = usageTokensOf({ prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 })
  assert.deepEqual(u, { tokensIn: 120, tokensOut: 45 })
})

test('usageTokensOf:Anthropic 形状', () => {
  const u = usageTokensOf({ input_tokens: 88, output_tokens: 30, cache_read_input_tokens: 12 })
  assert.deepEqual(u, { tokensIn: 88, tokensOut: 30 })
})

test('usageTokensOf:只回一半也能用,缺的那半为 null', () => {
  assert.deepEqual(usageTokensOf({ output_tokens: 7 }), { tokensIn: null, tokensOut: 7 })
  assert.deepEqual(usageTokensOf({ prompt_tokens: 9 }), { tokensIn: 9, tokensOut: null })
})

test('usageTokensOf:拿不到 usage 时返回 null(调用方据此回退估算)', () => {
  assert.equal(usageTokensOf(null), null)
  assert.equal(usageTokensOf(undefined), null)
  assert.equal(usageTokensOf({}), null)
  assert.equal(usageTokensOf({ prompt_tokens: 'x', completion_tokens: NaN }), null)
  assert.equal(usageTokensOf({ prompt_tokens: -1 }), null, '负数视为无效')
})

test('turnInputChars:与 turnInputEstimate 同口径,只换成字符数', () => {
  const messages = [
    { role: 'user', content: '你好世界' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'abc' },
  ]
  assert.equal(turnInputChars(messages), 4 + 5 + 3)
  assert.equal(turnInputChars([]), 0)
  assert.equal(turnInputChars([{ role: 'user' }]), 0, '缺 content 不炸')
})

test('tokenCeiling:空文本只留模板余量', () => {
  assert.equal(tokenCeiling(0), 0)
  assert.equal(tokenCeiling(-5), 0)
  assert.equal(tokenCeiling(NaN), 0)
  assert.equal(tokenCeiling(0, 16), 16)
  assert.equal(tokenCeiling(10), 10 * METERING_MAX_TOKENS_PER_CHAR)
  assert.equal(tokenCeiling(10, 16), 10 * METERING_MAX_TOKENS_PER_CHAR + 16)
})

test('checkMeteringBounds:英文估算值通过', () => {
  const r = checkMeteringBounds({
    tokensIn: 25,
    tokensOut: 10,
    charsIn: 100,
    charsOut: 40,
    msgCount: 2,
  })
  assert.equal(r.ok, true)
})

test('checkMeteringBounds:中文真实用量必须通过(旧的 ±5% 容差会误杀)', () => {
  // 4 个汉字:估算 chars/4 = 1 token,真实 usage 约 4~6 token
  const charsIn = 4
  const est = Math.ceil(charsIn / 4)
  const real = 6
  assert.ok(real > est * 1.05 + 1, '前提:真实值确实落在旧容差之外')
  const r = checkMeteringBounds({ tokensIn: real, tokensOut: 6, charsIn, charsOut: 4, msgCount: 2 })
  assert.equal(r.ok, true)
})

test('checkMeteringBounds:输入虚报被拒', () => {
  // 1000 字符最多 2000 token;报 5000 必须被拦
  const r = checkMeteringBounds({
    tokensIn: 5000,
    tokensOut: 10,
    charsIn: 1000,
    charsOut: 40,
    msgCount: 1,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'tokens-in-over-ceiling')
})

test('checkMeteringBounds:输出虚报被拒', () => {
  const r = checkMeteringBounds({
    tokensIn: 10,
    tokensOut: 900,
    charsIn: 40,
    charsOut: 100,
    msgCount: 1,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'tokens-out-over-ceiling')
})

test('checkMeteringBounds:负数与非法值被拒', () => {
  assert.equal(checkMeteringBounds({ tokensIn: -1, tokensOut: 0, charsIn: 10, charsOut: 10 }).ok, false)
  assert.equal(checkMeteringBounds({ tokensIn: 1, tokensOut: -2, charsIn: 10, charsOut: 10 }).ok, false)
  assert.equal(checkMeteringBounds({ tokensIn: NaN, tokensOut: 0, charsIn: 10, charsOut: 10 }).ok, false)
})

test('checkMeteringBounds:缓存命中不得超过输入上限', () => {
  const ok = checkMeteringBounds({
    tokensIn: 100,
    tokensOut: 10,
    tokensCache: 80,
    charsIn: 100,
    charsOut: 20,
    msgCount: 1,
  })
  assert.equal(ok.ok, true)

  const bad = checkMeteringBounds({
    tokensIn: 100,
    tokensOut: 10,
    tokensCache: 5000,
    charsIn: 100,
    charsOut: 20,
    msgCount: 1,
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'tokens-cache-over-ceiling')
})

test('checkMeteringBounds:少报不拦(provider 自己少收,不需要防)', () => {
  const r = checkMeteringBounds({
    tokensIn: 1,
    tokensOut: 1,
    charsIn: 1000,
    charsOut: 500,
    msgCount: 2,
  })
  assert.equal(r.ok, true)
})

test('checkMeteringBounds:模板余量随消息数增长', () => {
  const chars = 100
  const tokens = 300
  // 关掉固定余量,单独看"每消息模板开销"的影响
  const many = checkMeteringBounds({
    tokensIn: tokens,
    tokensOut: 1,
    charsIn: chars,
    charsOut: 10,
    msgCount: 10,
    inputOverhead: 0,
  })
  assert.equal(many.ok, true, '10 条消息:上限 200+160=360')

  const few = checkMeteringBounds({
    tokensIn: tokens,
    tokensOut: 1,
    charsIn: chars,
    charsOut: 10,
    msgCount: 1,
    inputOverhead: 0,
  })
  assert.equal(few.ok, false, '1 条消息:上限 200+16=216')
})

test('checkMeteringBounds:后端 system 提示词的固定余量', () => {
  // 4 个汉字 + 后端自带 system 模板 → 真实 prompt_tokens 可能上百
  const args = { tokensIn: 120, tokensOut: 6, charsIn: 4, charsOut: 4, msgCount: 2 }
  assert.equal(checkMeteringBounds(args).ok, true, '默认 512 余量应放行')
  assert.equal(
    checkMeteringBounds({ ...args, inputOverhead: 0 }).ok,
    false,
    '余量归零后,120 明显超过 8+32 的字符上限'
  )
})

test('checkMeteringBounds:模型硬上限比字符上限更紧时以模型为准', () => {
  // 输出字符很多,字符上限很宽,但 listing 声明 maxTokens=64
  const r = checkMeteringBounds({
    tokensIn: 10,
    tokensOut: 100,
    charsIn: 40,
    charsOut: 400,
    msgCount: 1,
    maxOut: 64,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'tokens-out-over-ceiling')
  assert.equal(r.ceiling, 64, '取 min(字符上限, maxTokens)')

  // 输入同理:上下文窗口 256 时,报 300 必须被拦
  const r2 = checkMeteringBounds({
    tokensIn: 300,
    tokensOut: 5,
    charsIn: 100,
    charsOut: 10,
    msgCount: 1,
    maxIn: 256,
  })
  assert.equal(r2.ok, false)
  assert.equal(r2.reason, 'tokens-in-over-ceiling')
  assert.equal(r2.ceiling, 256)
})
