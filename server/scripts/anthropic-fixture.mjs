// 本地 Anthropic 桩服务:严格模拟真实 Messages API 的校验与 SSE 形状。
// 用途:本机所在地区被 Anthropic 地理封锁(403 Request not allowed)时,
// 仍可端到端验证 anthropic 适配——请求构造、鉴权头、system 分离、SSE 解析、
// usage 与计费。桩会对不合规请求返回 400,因此"调用成功"本身就证明适配正确。
//
//   node server/scripts/anthropic-fixture.mjs [port]
import http from 'node:http'

const PORT = Number(process.argv[2] || 8899)
const MODEL = 'claude-sonnet-4-5-fixture'

// 校验失败的明细会打到 stderr,便于定位
const seen = { requests: 0, violations: [] }

function sse(res, events) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  for (const [name, data] of events) {
    res.write('event: ' + name + '\n')
    res.write('data: ' + JSON.stringify(data) + '\n\n')
  }
  res.end()
}

const server = http.createServer((req, res) => {
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(obj))
  }

  // ---- GET /v1/models ----
  if (req.method === 'GET' && /\/v1\/models\/?$/.test(req.url)) {
    if (!req.headers['anthropic-version']) {
      return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'missing anthropic-version header' } })
    }
    if (!req.headers['x-api-key']) {
      return send(401, { type: 'error', error: { type: 'authentication_error', message: 'missing x-api-key' } })
    }
    return send(200, { data: [{ id: MODEL, display_name: 'Fixture Sonnet' }] })
  }

  // ---- POST /v1/messages ----
  if (req.method === 'POST' && /\/v1\/messages\/?$/.test(req.url)) {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      seen.requests++
      // 真实 Anthropic 的硬性要求,桩逐条校验
      if (!req.headers['anthropic-version']) {
        seen.violations.push('missing anthropic-version')
        return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'anthropic-version required' } })
      }
      if (!req.headers['x-api-key']) {
        seen.violations.push('missing x-api-key')
        return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
      }
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad json' } })
      }
      // system 必须位于顶层,不能混进 messages
      if ((body.messages || []).some((m) => m.role === 'system')) {
        seen.violations.push('system mixed into messages')
        return send(400, {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'system must be a top-level field' },
        })
      }
      // max_tokens 必填
      if (typeof body.max_tokens !== 'number') {
        seen.violations.push('missing max_tokens')
        return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens is required' } })
      }
      if (body.stream_options) {
        seen.violations.push('stream_options sent to anthropic')
        return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'unknown field stream_options' } })
      }
      // 记录本次请求(供人工核对,不含 key)
      console.error('[fixture] ok  model=' + body.model + ' max_tokens=' + body.max_tokens +
        ' system=' + JSON.stringify(body.system || null) +
        ' messages=' + JSON.stringify((body.messages || []).map((m) => m.role)))

      // 真实形状的 SSE:含 thinking_delta(必须被丢弃)与 cache_read_input_tokens
      return sse(res, [
        ['message_start', {
          type: 'message_start',
          message: {
            id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model,
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 42, output_tokens: 1, cache_read_input_tokens: 12 },
          },
        }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        // 思维链:不是可见回复,适配层必须丢弃
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先算一下 P2P 的用途' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'P2P 算力共享' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '可以把闲置 GPU 出租给需要推理的人。' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 33 } }],
        ['message_stop', { type: 'message_stop' }],
      ])
    })
    return
  }

  send(404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('[fixture] Anthropic 桩服务已启动: http://127.0.0.1:' + PORT)
})
process.on('SIGINT', () => {
  console.error('\n[fixture] 收到请求数=' + seen.requests + ' 违规=' + JSON.stringify(seen.violations))
  process.exit(0)
})
