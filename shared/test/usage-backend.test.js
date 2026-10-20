// 集成测试:真实 HTTP SSE 后端 → runBackend 取回 usage → 归一化 → 通过边界校验。
//
// 这条链路是"按真实用量计费"的核心。用真实 HTTP 而不是 mock fetch,
// 是因为 SSE 解析、流末尾 usage 提取、Anthropic 与 OpenAI 两种形状的差异
// 都只有跑一遍才靠得住。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { runBackend, usageTokensOf, cachedTokensOf } from '../src/channel.js'
import { checkMeteringBounds } from '../src/protocol.js'

function startSseServer(onRequest) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => onRequest(req, res, body))
    })
    srv.listen(0, '127.0.0.1', () => {
      resolve({ srv, port: srv.address().port, close: () => new Promise((r) => srv.close(r)) })
    })
  })
}

const sse = (res) => ({
  send(obj) {
    res.write('data: ' + JSON.stringify(obj) + '\n\n')
  },
  done() {
    res.write('data: [DONE]\n\n')
    res.end()
  },
})

test('OpenAI 形状:prompt_tokens / completion_tokens 被取到', async () => {
  const s = await startSseServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const w = sse(res)
    w.send({ choices: [{ delta: { content: '你好' } }] })
    w.send({ choices: [{ delta: { content: '世界' } }] })
    // 真实后端在流尾的空 choices chunk 里带 usage
    w.send({ choices: [{ delta: {} }], usage: { prompt_tokens: 120, completion_tokens: 6, total_tokens: 126 } })
    w.done()
  })

  try {
    const listing = {
      backend: { type: 'custom', url: 'http://127.0.0.1:' + s.port + '/v1', relay: false },
      model: { name: 'm', context: 4096 },
      limits: { maxTokens: 256 },
    }
    const out = await runBackend({
      listing,
      messages: [{ role: 'user', content: '你好世界' }],
      params: { model: 'm', maxTokens: 256 },
      onToken: () => {},
      apiKey: 'test-key',
      env: { allowRelay: false },
    })

    assert.equal(out.text, '你好世界')
    assert.deepEqual(usageTokensOf(out.usage), { tokensIn: 120, tokensOut: 6 })

    // 4 个汉字:估算只有 1 token,真实 120(含后端 system 模板)。
    // 这必须通过 —— 否则"按真实用量计费"根本落不了地。
    const bounds = checkMeteringBounds({
      tokensIn: 120,
      tokensOut: 6,
      charsIn: 4,
      charsOut: 4,
      msgCount: 1,
      maxIn: 4096,
      maxOut: 256,
    })
    assert.equal(bounds.ok, true)
  } finally {
    await s.close()
  }
})

test('Anthropic 形状:input_tokens / output_tokens / cache_read 被取到', async () => {
  const s = await startSseServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const w = sse(res)
    w.send({ type: 'message_start', message: { usage: { input_tokens: 88, cache_read_input_tokens: 12 } } })
    w.send({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })
    w.send({ type: 'message_delta', usage: { output_tokens: 30 } })
    w.send({ type: 'message_stop' })
    res.end()
  })

  try {
    const listing = {
      backend: { type: 'anthropic', url: 'http://127.0.0.1:' + s.port + '/v1', relay: false },
      model: { name: 'claude-x', context: 8192 },
      limits: { maxTokens: 128 },
    }
    const out = await runBackend({
      listing,
      messages: [{ role: 'user', content: 'hi' }],
      params: { model: 'claude-x', maxTokens: 128 },
      onToken: () => {},
      apiKey: 'sk-ant-test',
      env: { allowRelay: false },
    })

    assert.equal(out.text, 'hi')
    assert.deepEqual(usageTokensOf(out.usage), { tokensIn: 88, tokensOut: 30 })
    assert.equal(cachedTokensOf(out.usage), 12, '缓存命中仍单独取真值')
  } finally {
    await s.close()
  }
})

test('后端不回 usage:归一化返回 null,调用方据此回退估算', async () => {
  const s = await startSseServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const w = sse(res)
    w.send({ choices: [{ delta: { content: 'ok' } }] })
    w.done()
  })

  try {
    const listing = {
      backend: { type: 'custom', url: 'http://127.0.0.1:' + s.port + '/v1', relay: false },
      model: { name: 'm' },
      limits: { maxTokens: 64 },
    }
    const out = await runBackend({
      listing,
      messages: [{ role: 'user', content: 'hello' }],
      params: { model: 'm', maxTokens: 64 },
      onToken: () => {},
      apiKey: '',
      env: { allowRelay: false },
    })
    assert.equal(out.text, 'ok')
    assert.equal(usageTokensOf(out.usage), null)
  } finally {
    await s.close()
  }
})
