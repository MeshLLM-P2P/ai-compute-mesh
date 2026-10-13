// 用真实 Anthropic Key 端到端验证 anthropic 后端适配。
// 用法( key 只走环境变量, 绝不写入文件/日志 ):
//   ANTHROPIC_API_KEY=sk-ant-… node server/scripts/verify-anthropic.mjs
// 可选:
//   MESH_ANTHROPIC_MODEL=claude-…   指定模型(默认从 /v1/models 里挑一个 sonnet)
//   MESH_ANTHROPIC_URL=…            自定义 Messages 端点(默认 https://api.anthropic.com/v1/messages)
//
// 校验链路:
//   1) 探测  GET /v1/models  —— 验证 x-api-key + anthropic-version 头
//   2) 真实调用 runBackend() —— 验证请求体(system 分离/max_tokens)、SSE 解析、usage
//   3) 计费   —— 用回执口径复算 amountRaw 与 5% 分账, 确认能进结算
import {
  anthropicHeaders,
  anthropicSseDeltas,
  normalizeBackendUrl,
  runBackend,
  callParams,
  cachedTokensOf,
} from '@mesh/shared/channel'
import { calcAmountRaw, splitFees, estimateTokens, turnInputEstimate } from '@mesh/shared/protocol'

const KEY = (process.env.ANTHROPIC_API_KEY || '').trim()
if (!KEY) {
  console.error('缺少 ANTHROPIC_API_KEY。用法: ANTHROPIC_API_KEY=sk-ant-… node server/scripts/verify-anthropic.mjs')
  process.exit(2)
}
const BASE_URL = (process.env.MESH_ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages').trim()
const ANTHROPIC_ROOT = BASE_URL.replace(/\/messages\/?$/, '').replace(/\/+$/, '')

const ok = (b) => (b ? '✅' : '❌')
let failed = 0
const check = (label, cond, extra = '') => {
  if (!cond) failed++
  console.log('  ' + ok(cond) + ' ' + label + (extra ? '  ' + extra : ''))
}

// ---------- 1) 探测 /v1/models ----------
console.log('\n===== 1) 探测 GET /v1/models (验证鉴权头) =====')
console.log('  URL: ' + ANTHROPIC_ROOT + '/models')
let models = []
try {
  const res = await fetch(ANTHROPIC_ROOT + '/models', { headers: anthropicHeaders(KEY) })
  console.log('  HTTP ' + res.status)
  check('鉴权通过 (非 401/403)', res.status !== 401 && res.status !== 403, 'status=' + res.status)
  if (res.ok) {
    const j = await res.json()
    models = (j.data || []).map((m) => m.id).filter(Boolean)
    check('返回模型列表', models.length > 0, models.length + ' 个')
    console.log('  可用模型: ' + models.slice(0, 10).join(', ') + (models.length > 10 ? ' …' : ''))
  }
} catch (e) {
  check('探测请求可达', false, e.message)
  process.exit(1)
}

const model =
  (process.env.MESH_ANTHROPIC_MODEL || '').trim() ||
  models.find((m) => /sonnet/i.test(m)) ||
  models.find((m) => /haiku/i.test(m)) ||
  models[0]
if (!model) {
  console.error('未能确定模型名,请用 MESH_ANTHROPIC_MODEL 指定')
  process.exit(1)
}
console.log('  选用模型: ' + model)

// ---------- 2) 真实调用 runBackend ----------
console.log('\n===== 2) 真实调用 runBackend() (type=anthropic) =====')
const listing = {
  id: 'verify-anthropic',
  model: { name: model },
  backend: { type: 'anthropic', url: BASE_URL, relay: false },
  limits: { maxTokens: 300, maxConcurrent: 1 },
  pricing: {
    currency: 'USDT',
    per1kInputRaw: 5000,
    per1kOutputRaw: 15000,
    per1kCacheRaw: 1000,
    minFeeRaw: 100,
  },
}
console.log('  归一后端点: ' + normalizeBackendUrl(BASE_URL, 'anthropic'))

const messages = [
  { role: 'system', content: 'You are terse. Reply in at most two short sentences.' },
  { role: 'user', content: 'Say hello and name one use of P2P compute sharing.' },
]
const params = callParams(listing)

let streamed = ''
let chunkCount = 0
const t0 = Date.now()
let result
try {
  result = await runBackend({
    listing,
    messages,
    params,
    apiKey: KEY,
    env: { serverBase: '', allowRelay: false },
    onToken: (c) => {
      if (c) {
        streamed += c
        chunkCount++
      }
    },
  })
} catch (e) {
  check('runBackend 调用成功', false, e.message)
  console.log('\n(若报 CORS/网络错误:本脚本在 Node 端直连,无 CORS;多为 key/模型名/端点问题)')
  process.exit(1)
}
const ms = Date.now() - t0

check('runBackend 无异常', true, ms + 'ms')
check('收到流式 chunk', chunkCount > 0, chunkCount + ' 个增量')
check('回复非空', streamed.trim().length > 0)
check('runBackend 返回的 text 与流式拼接一致', result.text === streamed)
check('拿到 usage', !!result.usage, JSON.stringify(result.usage || {}))
console.log('\n  --- 模型回复 ---')
console.log(
  String(streamed)
    .split('\n')
    .map((l) => '  | ' + l)
    .join('\n')
)

// system 分离是否正确:若把 system 混进 messages 会 400,能走到这里即证明分离生效
check('system 已正确抽为顶层字段 (否则会 400)', true)

// ---------- 3) 计费复算 ----------
console.log('\n===== 3) 计费复算 (回执口径) =====')
const assistant = { role: 'assistant', content: result.text }
const history = [...messages.filter((m) => m.role !== 'system'), assistant]
const tokensIn = turnInputEstimate(history)
const tokensOut = estimateTokens(result.text)
const tokensCache = cachedTokensOf(result.usage)
console.log('  tokensIn=' + tokensIn + '  tokensOut=' + tokensOut + '  tokensCache=' + tokensCache)
const amountRaw = calcAmountRaw(listing.pricing, tokensIn, tokensOut, tokensCache)
const fees = splitFees(amountRaw)
console.log('  amountRaw=' + amountRaw + '  平台费=' + fees.totalRaw + '  供应方=' + fees.providerRaw)
console.log('  分账: ' + JSON.stringify(fees.parts))
check('amount == provider + fees', fees.providerRaw + fees.totalRaw === amountRaw)
check('平台费率 ≈5%', Math.abs(fees.totalRaw / amountRaw - 0.05) < 0.01, (fees.totalRaw / amountRaw * 100).toFixed(3) + '%')
console.log('  折合: ' + (amountRaw / 1e6).toFixed(6) + ' USDT')

console.log('\n===== 结论 =====')
console.log(failed === 0 ? '  ✅ 全部通过: anthropic 后端可正常接单、流式返回、按 5% 分账结算' : '  ❌ ' + failed + " 项未通过")
process.exit(failed === 0 ? 0 : 1)
