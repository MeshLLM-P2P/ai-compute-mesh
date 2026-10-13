// Anthropic Messages API 适配:URL 归一、鉴权头、SSE 流式解析。
// 用真实形状的 SSE 帧(含必须丢弃的 thinking_delta)验证,不依赖网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeBackendUrl,
  anthropicHeaders,
  anthropicSseDeltas,
  cachedTokensOf,
  ANTHROPIC_VERSION,
} from '../src/channel.js'

// 把若干 SSE 文本块包装成 anthropicSseDeltas 需要的 { body: ReadableStream }
function sseRes(text) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  return { body: stream }
}

test('normalizeBackendUrl: anthropic 归一到 /messages, OpenAI 仍走 /chat/completions', () => {
  assert.equal(
    normalizeBackendUrl('https://api.anthropic.com/v1', 'anthropic'),
    'https://api.anthropic.com/v1/messages'
  )
  assert.equal(
    normalizeBackendUrl('https://api.anthropic.com/v1/messages', 'anthropic'),
    'https://api.anthropic.com/v1/messages'
  )
  // 尾斜杠归一
  assert.equal(
    normalizeBackendUrl('https://api.anthropic.com/v1/messages/', 'anthropic'),
    'https://api.anthropic.com/v1/messages'
  )
  // 缺省 kind 保持旧行为(custom),不破坏既有 listing
  assert.equal(
    normalizeBackendUrl('https://api.openai.com/v1'),
    'https://api.openai.com/v1/chat/completions'
  )
  assert.equal(
    normalizeBackendUrl('https://api.openai.com/v1/chat/completions', 'custom'),
    'https://api.openai.com/v1/chat/completions'
  )
})

test('anthropicHeaders: x-api-key + anthropic-version,不是 Bearer', () => {
  const h = anthropicHeaders('sk-ant-123')
  assert.equal(h['x-api-key'], 'sk-ant-123')
  assert.equal(h['anthropic-version'], ANTHROPIC_VERSION)
  assert.equal(h.Authorization, undefined)
  // 无 key 时仍要带版本头(否则 400)
  const h2 = anthropicHeaders('')
  assert.equal(h2['anthropic-version'], ANTHROPIC_VERSION)
  assert.equal(h2['x-api-key'], undefined)
})

test('anthropicSseDeltas: 只取 text_delta,丢弃 thinking_delta', async () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1,"cache_read_input_tokens":40}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"让我算一下"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n')

  let usage = null
  let text = ''
  for await (const d of anthropicSseDeltas(sseRes(sse), (u) => {
    usage = u
  }))
    text += d

  assert.equal(text, 'Hello world')
  assert.ok(!text.includes('让我算一下'), 'thinking_delta 不是可见回复,必须丢弃')
  assert.equal(usage.input_tokens, 100)
  // message_delta 的 output_tokens 是累计值,覆盖 message_start 的初始值 1
  assert.equal(usage.output_tokens, 20)
  assert.equal(cachedTokensOf(usage), 40)
})

test('anthropicSseDeltas: 流被截断(无 message_stop)也要交出 usage', async () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":7,"cache_read_input_tokens":3}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ab"}}',
    '',
  ].join('\n')

  let usage = null
  let text = ''
  for await (const d of anthropicSseDeltas(sseRes(sse), (u) => {
    usage = u
  }))
    text += d

  assert.equal(text, 'ab')
  assert.equal(usage.input_tokens, 7)
  assert.equal(cachedTokensOf(usage), 3)
})
