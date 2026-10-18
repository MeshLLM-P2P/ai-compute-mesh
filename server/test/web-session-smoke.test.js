// web/src/session.js 静态防护:防止 preferRelay 分支再次踩 TDZ。
//
// 背景(2026-10-18 真机故障):为让跨网段调用立刻走中转,在 handleFrame /
// openRelayChannel 定义之前调用了 openRelayChannel(),而 handleFrame 是
// const 箭头函数(不提升),运行时抛 "Cannot access 'handleFrame' before
// initialization",调用在连接阶段即失败。浏览器里才炸,Node 测试测不到,
// 所以用静态断言把这类"提前引用"挡在提交前。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const here = import.meta.dirname
const SESSION = path.resolve(here, '..', '..', 'web', 'src', 'session.js')

test('web/session.js 可被加载(无语法/导入错误)', async () => {
  // 顶层不触碰 location/window(Node 下 api.js 已做 typeof 守卫),
  // 这里只验证模块能求值,语法与导入链是好的。
  const mod = await import('../../web/src/session.js')
  assert.equal(typeof mod.startConsumerCall, 'function')
  assert.equal(typeof mod.startProviderAgent, 'function')
})

test('preferRelay 分支必须位于 handleFrame / openRelayChannel 定义之后(TDZ 防护)', () => {
  const src = fs.readFileSync(SESSION, 'utf8')
  const at = (re) => {
    const m = src.match(re)
    return m ? m.index : -1
  }
  const handleFrame = at(/const handleFrame\s*=/)
  const openRelay = at(/function openRelayChannel\s*\(/)
  const prefer = at(/if \(preferRelay\) \{/)
  assert.ok(handleFrame > 0, '未找到 handleFrame 定义')
  assert.ok(openRelay > 0, '未找到 openRelayChannel 定义')
  assert.ok(prefer > 0, '未找到 preferRelay 分支')
  assert.ok(
    prefer > handleFrame,
    'preferRelay 分支在 handleFrame 之前 —— 运行时会抛 TDZ(Cannot access before initialization)'
  )
  assert.ok(prefer > openRelay, 'preferRelay 分支在 openRelayChannel 之前 —— 运行时 TDZ')
})
