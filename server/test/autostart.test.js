// 网页配置页的服务端部分:config.json 合并写 + 开机自启脚本生成。
// 只测校验与脚本内容,不写真实 config.json、不碰启动文件夹。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildScript, writeAgentConfig } from '../src/autostart.js'
import { HttpError } from '../src/directory.js'

test('bat script quotes paths with spaces and uses absolute node', () => {
  const s = buildScript({
    startServer: true,
    startAgent: true,
    hidden: false,
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  })
  assert.match(s, /^@echo off/)
  assert.match(s, /"C:\\Program Files\\nodejs\\node\.exe" ".*server\\src\\index\.js"/)
  // agent 自带崩溃重启循环
  assert.match(s, /:loop/)
  assert.match(s, /goto loop/)
})

test('hidden mode emits a VBS launcher that runs the bat silently', () => {
  const s = buildScript({ startServer: true, startAgent: false, hidden: true })
  assert.match(s, /CreateObject\("WScript\.Shell"\)\.Run/)
  assert.match(s, /, 0, True/)
  assert.match(s, /MeshLLM-autostart\.bat/)
})

test('only the selected components appear in the script', () => {
  const agentOnly = buildScript({ startServer: false, startAgent: true, hidden: false })
  assert.doesNotMatch(agentOnly, /server\\src\\index\.js/)
  assert.match(agentOnly, /agent\\src\\index\.js/)
})

test('validation errors are HttpError 400 (not 500)', () => {
  const tmp = path.join(os.tmpdir(), 'meshllm-cfgtest-' + process.pid + '.json')
  for (const bad of [{ server: '' }, { listings: 'x' }, { listings: [{ apiKey: 'k' }] }, { heartbeatSec: 0 }]) {
    let err = null
    try {
      writeAgentConfig(bad, tmp)
    } catch (e) {
      err = e
    }
    assert.ok(err instanceof HttpError, 'expected HttpError for ' + JSON.stringify(bad))
    assert.equal(err.status, 400)
  }
  fs.rmSync(tmp, { force: true })
})

test('merge keeps unknown fields and normalizes numeric strings', () => {
  const tmp = path.join(os.tmpdir(), 'meshllm-cfgtest-merge-' + process.pid + '.json')
  fs.writeFileSync(tmp, JSON.stringify({ server: '127.0.0.1:4011', listings: [{ listingId: 'abc' }], customField: 'keep' }))
  const out = writeAgentConfig({ heartbeatSec: '45', tls: 'false' }, tmp)
  assert.equal(out.customField, 'keep')
  assert.equal(out.heartbeatSec, 45)
  assert.equal(typeof out.heartbeatSec, 'number')
  assert.equal(out.tls, false)
  assert.deepEqual(out.listings, [{ listingId: 'abc' }])
  fs.rmSync(tmp, { force: true })
})
