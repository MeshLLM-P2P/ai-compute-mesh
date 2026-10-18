// ICE 配置构造测试:跨网段能否直连取决于 hasTurn 是否正确。
//
// 三个必须守住的点:
//   ① 没配 TURN → hasTurn=false(web 端据此走中转,不会白试直连然后 5s 掉线)
//   ② 配了 TURN 但未登录 → 不下发凭据(避免匿名白嫖中转带宽)
//   ③ 配了 TURN 且已登录 → 下发 urls + username + credential
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildIceConfig, splitUrls } from '../src/ice.js'

const cfg = (o = {}) => ({
  stunUrls: 'stun:stun.l.google.com:19302',
  turnUrls: '',
  turnUsername: '',
  turnCredential: '',
  ...o,
})

test('splitUrls:去空白、丢空项', () => {
  assert.deepEqual(splitUrls(' a , ,b,'), ['a', 'b'])
  assert.deepEqual(splitUrls(''), [])
  assert.deepEqual(splitUrls(undefined), [])
})

test('未配 TURN:只下发 STUN,hasTurn=false', () => {
  const r = buildIceConfig(cfg(), { authed: true })
  assert.deepEqual(r.iceServers, [{ urls: ['stun:stun.l.google.com:19302'] }])
  assert.equal(r.hasTurn, false)
  assert.equal(r.turnConfigured, false)
})

test('配了 TURN 但未登录:不下发凭据,hasTurn=false', () => {
  const r = buildIceConfig(
    cfg({ turnUrls: 'turn:t.example.com:3478', turnUsername: 'u', turnCredential: 'p' }),
    { authed: false }
  )
  assert.equal(r.iceServers.length, 1, '未登录只能拿到 STUN')
  assert.equal(r.hasTurn, false)
  assert.equal(r.turnConfigured, true, '但要让运维看到"已配置"')
})

test('配了 TURN 且已登录:下发完整凭据,hasTurn=true', () => {
  const r = buildIceConfig(
    cfg({
      turnUrls: 'turn:t.example.com:3478?transport=udp,turns:t.example.com:5349',
      turnUsername: 'mesh',
      turnCredential: 's3cret',
    }),
    { authed: true }
  )
  assert.equal(r.hasTurn, true)
  assert.equal(r.iceServers.length, 2)
  assert.deepEqual(r.iceServers[1].urls, [
    'turn:t.example.com:3478?transport=udp',
    'turns:t.example.com:5349',
  ])
  assert.equal(r.iceServers[1].username, 'mesh')
  assert.equal(r.iceServers[1].credential, 's3cret')
})

test('STUN/TURN 都为空:iceServers 为空数组', () => {
  const r = buildIceConfig({ stunUrls: '', turnUrls: '', turnUsername: '', turnCredential: '' }, { authed: true })
  assert.deepEqual(r.iceServers, [])
  assert.equal(r.hasTurn, false)
})
