// 跨 bootstrap 代理测试:验证 /xboot/<host:port>/... 的 HTTP 与 WS 转发。
//
// 为什么需要这个测试:浏览器直连远程 bootstrap 会被自签证书/代理/混合内容拦截,
// 所以改为经本机转发。代理必须做到三件事,任一坏掉跨机调用就断:
//   ① HTTP 状态/头/体原样透传
//   ② POST 请求体不被本机 express.json 消费掉(所以路由必须挂在 json 之前)
//   ③ WS(/signal、/dc)双向转发,且文本帧仍是文本帧
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import express from 'express'
import cors from 'cors'
import { WebSocketServer, WebSocket } from 'ws'
import { attachXbootHttp, xbootUpgrade } from '../src/xboot-proxy.js'

const here = import.meta.dirname
const tlsKey = fs.readFileSync(path.resolve(here, '..', 'tls', 'key.pem'))
const tlsCert = fs.readFileSync(path.resolve(here, '..', 'tls', 'cert.pem'))

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)))
}

test('xboot proxy forwards HTTP body and WS frames', async (t) => {
  // ---- 上游:模拟"远程 bootstrap"(自签 TLS) ----
  const upApp = express()
  upApp.use(express.json())
  upApp.get('/health', (_req, res) => res.json({ ok: true, who: 'upstream' }))
  upApp.post('/echo', (req, res) => res.json({ got: req.body, session: req.headers['x-mesh-session'] || null }))
  const upServer = https.createServer({ key: tlsKey, cert: tlsCert }, upApp)
  const upWss = new WebSocketServer({ server: upServer })
  upWss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
      // 模拟服务端:收到 join 就回 joined(文本帧)
      if (!isBinary) {
        const m = JSON.parse(data.toString())
        ws.send(JSON.stringify({ t: 'joined', room: m.room, echo: m.room }))
      } else {
        ws.send(data, { binary: true })
      }
    })
  })
  const upPort = await listen(upServer)
  t.after(() => {
    upWss.close()
    upServer.close()
  })

  // ---- 代理:本机 bootstrap(cors + /xboot 路由,挂在 json 之前) ----
  const app = express()
  app.use(cors())
  attachXbootHttp(app)
  app.use(express.json())
  const proxyServer = http.createServer(app)
  proxyServer.on('upgrade', (req, socket, head) => {
    const pathname = req.url.split('?')[0]
    if (pathname.startsWith('/xboot/')) {
      xbootUpgrade(req, socket, head)
      return
    }
    socket.destroy()
  })
  const proxyPort = await listen(proxyServer)
  t.after(() => proxyServer.close())

  const base = `http://127.0.0.1:${proxyPort}/xboot/127.0.0.1:${upPort}`

  await t.test('GET 透传', async () => {
    const r = await fetch(base + '/health')
    assert.equal(r.status, 200)
    const j = await r.json()
    assert.deepEqual(j, { ok: true, who: 'upstream' })
  })

  await t.test('POST 请求体透传(未被本机 json 解析器吃掉)', async () => {
    const r = await fetch(base + '/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mesh-session': 'tok-123' },
      body: JSON.stringify({ amountRaw: 42, listingId: 'abc' }),
    })
    assert.equal(r.status, 200)
    const j = await r.json()
    assert.deepEqual(j.got, { amountRaw: 42, listingId: 'abc' })
    assert.equal(j.session, 'tok-123', '自定义会话头必须透传')
  })

  await t.test('上游不可达时返回 502 + 结构化错误', async () => {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/xboot/127.0.0.1:1/health`)
    assert.equal(r.status, 502)
    const j = await r.json()
    assert.equal(j.error, 'xboot-unreachable')
  })

  await t.test('WS 双向转发(/signal 房间协议)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/xboot/127.0.0.1:${upPort}/signal`)
    const got = await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('ws-timeout')), 8000)
      ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room: 'sess:test' })))
      ws.on('message', (data, isBinary) => {
        clearTimeout(timer)
        res({ data: data.toString(), isBinary })
      })
      ws.on('error', (e) => {
        clearTimeout(timer)
        rej(e)
      })
    })
    ws.close()
    assert.equal(got.isBinary, false, '文本帧必须保持文本帧')
    const m = JSON.parse(got.data)
    assert.equal(m.t, 'joined')
    assert.equal(m.room, 'sess:test')
  })
})
