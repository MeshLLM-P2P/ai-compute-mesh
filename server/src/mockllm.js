import { Router } from 'express'

// Deterministic OpenAI-compatible mock LLM endpoint for the devnet demo.
// POST /mock-llm/v1/chat/completions -> text/event-stream SSE of chat.completion.chunk
function buildReply(userText, model) {
  return [
    `You asked: "${userText}"`,
    '',
    'MeshLLM mock backend — this reply streams over the platform data channel (WS /dc):',
    '1) Transport: E2EE over the WS data plane — inference bytes never reach platform servers in cleartext.',
    '2) E2E: P-256 ECDH ephemeral keys, HKDF to per-session AES-256-GCM keys.',
    '3) Metering: provider signs a receipt (tokensIn, tokensOut, transcriptHash, listingId).',
    '4) Settlement: per-call USDT release via the mesh-escrow state machine.',
    '',
    `(model=${model}; deterministic response so transcriptHash can be verified by both sides)`,
  ].join('\n')
}

export function mockLlmRouter() {
  const r = Router()
  // OpenAI-compatible model directory — used by the Provider panel's
  // "探测后端模型" feature so the listing model name comes from the backend.
  r.get('/v1/models', (req, res) => {
    res.json({
      object: 'list',
      data: [
        { id: 'mock-llm-fast', object: 'model', owned_by: 'meshllm-demo' },
        { id: 'mock-llm-std', object: 'model', owned_by: 'meshllm-demo' },
      ],
    })
  })
  r.post('/v1/chat/completions', (req, res) => {
    const body = req.body || {}
    const messages = Array.isArray(body.messages) ? body.messages : []
    const model = typeof body.model === 'string' ? body.model : 'mock'
    const lastUser =
      [...messages].reverse().find((m) => m && m.role === 'user')?.content || ''
    const reply = buildReply(String(lastUser), model)

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    if (res.flushHeaders) res.flushHeaders()

    const words = reply.split(/(?<=\s)/)
    const id = 'mock-' + Date.now().toString(36)
    let i = 0
    let done = false
    const timer = setInterval(() => {
      if (done) return
      if (i >= words.length) {
        done = true
        clearInterval(timer)
        res.write(
          `data: {"id":"${id}","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`
        )
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.write(
        `data: {"id":"${id}","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":${JSON.stringify(words[i])}}}]}\n\n`
      )
      i += 1
    }, 25)
    // client aborted mid-stream: stop the timer (normal end sets `done` first)
    res.on('close', () => {
      if (!done) {
        done = true
        clearInterval(timer)
      }
    })
  })
  return r
}
