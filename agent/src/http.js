// Node 端 HTTP 客户端:平台 API + 钱包登录(nonce → verify → session)。
// 自签证书处理:运行时设置 NODE_EXTRA_CA_CERTS 对内置 fetch 无效,
// 因此直接用 node:http / node:https,把 PEM 证书作为 `ca` 选项传入。
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { b64encode, utf8 } from '@mesh/shared/protocol'

function doRequest(url, { method = 'GET', body, token, ca, rejectUnauthorized, headers: extraHeaders = {} } = {}) {
  const u = new URL(url)
  const doReq = u.protocol === 'https:' ? httpsRequest : httpRequest
  const payload = body === undefined || body === null ? null : JSON.stringify(body)
  const headers = { 'Content-Type': 'application/json', ...extraHeaders }
  if (token) headers['x-mesh-session'] = token
  if (payload !== null) headers['Content-Length'] = Buffer.byteLength(payload)
  const opts = { method, headers }
  if (u.protocol === 'https:' && ca) opts.ca = ca
  // 显式传入 rejectUnauthorized 时才覆盖默认(严格)校验;用于 devnet 下
  // 目标服务器自签证书 SAN 未含其公网 IP 的情形(见 README 限制说明)。
  if (u.protocol === 'https:' && rejectUnauthorized !== undefined) opts.rejectUnauthorized = rejectUnauthorized
  return new Promise((resolve, reject) => {
    const req = doReq(u, opts, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        data += c
      })
      res.on('end', () => resolve({ status: res.statusCode, text: data }))
    })
    req.on('error', (e) => reject(new Error('http-error: ' + e.message)))
    req.setTimeout(60000, () => req.destroy(new Error('http-timeout')))
    if (payload !== null) req.write(payload)
    req.end()
  })
}

export async function api(base, path, { method = 'GET', body, token, ca, rejectUnauthorized } = {}) {
  const { status, text } = await doRequest(base + path, { method, body, token, ca, rejectUnauthorized })
  let data = null
  try {
    data = JSON.parse(text)
  } catch {}
  if (status < 200 || status >= 300) {
    const msg = (data && data.error) || text.slice(0, 200) || 'http ' + status
    throw new Error('http-' + status + ': ' + msg)
  }
  return data === null ? null : data
}

// login: 取 nonce → 钱包签名 → verify,返回 session token(TTL 30 分钟)
// 可选 rejectUnauthorized:仅 HTTPS 且 devnet 下证书 SAN 未含公网 IP 时设为 false 绕过主机名校验。
export async function login(base, wallet, ca, { rejectUnauthorized } = {}) {
  const n = await api(base, '/nonce?wallet=' + encodeURIComponent(wallet.address), { ca, rejectUnauthorized })
  const signature = b64encode(wallet.signMessage(utf8(n.nonce)))
  const v = await api(base, '/verify', {
    method: 'POST',
    body: { wallet: wallet.address, signature },
    ca,
    rejectUnauthorized,
  })
  if (!v || !v.session) throw new Error('login-failed: response has no session')
  return v.session
}

// 仅取状态码(探测用;不读 body)
export async function getStatus(url, { ca, rejectUnauthorized, headers = {} } = {}) {
  const u = new URL(url)
  const doReq = u.protocol === 'https:' ? httpsRequest : httpRequest
  const opts = { method: 'GET', headers }
  if (u.protocol === 'https:' && ca) opts.ca = ca
  if (u.protocol === 'https:' && rejectUnauthorized !== undefined) opts.rejectUnauthorized = rejectUnauthorized
  return new Promise((resolve, reject) => {
    const req = doReq(u, opts, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', (e) => reject(new Error('http-error: ' + e.message)))
    req.setTimeout(15000, () => req.destroy(new Error('http-timeout')))
    req.end()
  })
}