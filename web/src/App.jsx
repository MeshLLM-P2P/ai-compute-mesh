import React, { useCallback, useState, useEffect } from 'react'
import { api, setSession } from './api.js'
import { connectWallet, shortAddr, DEMO_KEY } from './wallet.js'
import { utf8, b64encode } from '@mesh/shared/protocol'
import Market from './pages/Market.jsx'
import ProviderPanel from './pages/ProviderPanel.jsx'
import EscrowPanel from './pages/EscrowPanel.jsx'
import ConfigPanel from './pages/ConfigPanel.jsx'

const TABS = [
  { id: 'market', label: '算力市场' },
  { id: 'provider', label: 'Provider 面板' },
  { id: 'escrow', label: '结算账户' },
  { id: 'config', label: '配置' },
]

export default function App() {
  const [wallet, setWallet] = useState(null)
  const [loginErr, setLoginErr] = useState(null)
  const [logging, setLogging] = useState(false)
  const [tab, setTab] = useState('market')
  const [log, setLog] = useState([])
  // 网络选择: 测试网/实网。实际结算模式由服务端 MESH_SETTLE_MODE 决定,
  // 前端按钮用于"选择要连的网"并校验当前服务器是否匹配。
  const [netChoice, setNetChoice] = useState('test')          // 'test' | 'main'
  const [netInfo, setNetInfo] = useState(null)                // /network 响应
  const [netMatch, setNetMatch] = useState(null)              // 登录时校验结果: null|true|false

  // 页面加载时查询服务器当前真实结算模式,作为选择器的默认参照
  useEffect(() => {
    api('/network')
      .then((d) => setNetInfo(d))
      .catch(() => setNetInfo({ error: '查询失败' }))
  }, [])

  const pushLog = useCallback((m) => {
    const line = new Date().toLocaleTimeString() + '  ' + m
    setLog((l) => [line, ...l].slice(0, 120))
  }, [])

  const login = async () => {
    setLogging(true)
    setLoginErr(null)
    try {
      const w = await connectWallet({ real: netChoice === 'main' })
      const { nonce } = await api('/nonce?wallet=' + encodeURIComponent(w.address))
      const sigB64 = b64encode(await w.signMessage(utf8(nonce)))
      const { session, settleMode } = await api('/verify', {
        method: 'POST',
        body: { wallet: w.address, signature: sigB64 },
      })
      setSession(session)
      setWallet(w)
      // 校验所选网络与服务端真实结算模式是否一致
      const serverIsTest = settleMode === 'sim' || settleMode === 'devnet' || !settleMode
      const match = netChoice === 'test' ? serverIsTest : settleMode === 'mainnet'
      setNetMatch(match)
      pushLog('登录成功 (' + w.name + '): ' + shortAddr(w.address) + (match ? ' · 网络匹配' : ' · 网络不一致'))
    } catch (e) {
      let msg = '登录失败: ' + (e.message || String(e))
      // 实网但未连接真实钱包 -> 给出明确指引
      if (e.code === 'NEED_REAL_WALLET') {
        msg =
          '⚠ 选择「实网」需先连接真实钱包。\n' +
          e.message + '\n' +
          '安装 Phantom 钱包并连接后重试。'
      }
      setLoginErr(msg)
    } finally {
      setLogging(false)
    }
  }

  // 导入 Demo 钱包密钥(JSON 字节数组):换机器、换端口/协议(http→https)、
  // 或浏览器重装后,把旧浏览器 localStorage 里的密钥带过来,钱包地址不变
  const importDemoKey = () => {
    const raw = window.prompt(
      '粘贴 Demo 钱包密钥(JSON 字节数组)。\n在旧页面的浏览器控制台(F12 → Console)执行:\nlocalStorage.getItem("meshllm-demo-key-v1")'
    )
    if (!raw) return
    try {
      const arr = JSON.parse(raw)
      if (!Array.isArray(arr) || arr.length === 0) throw new Error('not-array')
      localStorage.setItem(DEMO_KEY, JSON.stringify(arr))
      pushLog('已导入钱包密钥,请重新点击"用钱包登录"')
    } catch {
      pushLog('导入失败:必须是形如 [1,2,3,…] 的 JSON 字节数组')
    }
  }

  const logout = () => {
    setWallet(null)
    setSession(null)
    setTab('market')
  }

  if (!wallet) {
    return (
      <div className="wrap" style={{ paddingTop: 80, textAlign: 'center', maxWidth: 560 }}>
        <h1 style={{ fontSize: 26 }}>MeshLLM</h1>
        <p className="muted" style={{ lineHeight: 1.8 }}>
          AI 大模型算力共享网络
          <br />
          去中心化点对点直连 · 端到端加密 · 钱包即身份 · 逐次 USDT 结算
        </p>
        <div className="card" style={{ marginTop: 24, textAlign: 'left', fontSize: 13, lineHeight: 1.9 }}>
          <b>工作原理</b>
          <br />1. Provider 把本地模型(或任意 API)发布为签名 Listing,价格自定。
          <br />2. Consumer 经平台数据通道(WS /dc)与 Provider 建立会话,应用层 E2E 加密(P-256 ECDH → HKDF → AES-256-GCM)。
          <br />3. 每次调用结束后 Provider 对回执(代币数 + 转录哈希)签名,双方双签触发 Solana USDT 托管结算。
          <br />4. 平台服务器只做目录 / 信令 / 密文中继 / 托管账本,推理数据对平台始终为密文。
        </div>

        {/* ---------- 网络选择: 测试网 / 实网 ---------- */}
        <div className="card" style={{ marginTop: 18, textAlign: 'left', fontSize: 13, lineHeight: 1.8 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
            选择网络
            {netInfo && <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}> 服务器实际: {netInfo.mode && netInfo.mode.label}</span>}
          </div>
          <div className="row" style={{ gap: 12 }}>
            <button
              className="net-opt"
              onClick={() => setNetChoice('test')}
              style={{
                flex: 1,
                background: netChoice === 'test' ? 'var(--accent)' : 'var(--panel2)',
                border: '1px solid ' + (netChoice === 'test' ? 'var(--accent)' : 'var(--line)'),
                color: netChoice === 'test' ? '#fff' : 'var(--text)',
                fontSize: 13,
                padding: '10px 12px',
                borderRadius: 8,
                cursor: 'pointer',
              }}
            >
              测试网
              <span style={{ display: 'block', fontSize: 11, opacity: 0.8, marginTop: 2 }}>
                模拟结算(免费,自动充值 100 USDT)
              </span>
            </button>
            <button
              className="net-opt"
              onClick={() => setNetChoice('main')}
              style={{
                flex: 1,
                background: netChoice === 'main' ? 'var(--accent)' : 'var(--panel2)',
                border: '1px solid ' + (netChoice === 'main' ? 'var(--accent)' : 'var(--line)'),
                color: netChoice === 'main' ? '#fff' : 'var(--text)',
                fontSize: 13,
                padding: '10px 12px',
                borderRadius: 8,
                cursor: 'pointer',
              }}
            >
              实网
              <span style={{ display: 'block', fontSize: 11, opacity: 0.8, marginTop: 2 }}>
                Solana mainnet(真实 USDT 结算)
              </span>
            </button>
          </div>
          <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.7, color: netInfo?.error ? 'var(--err)' : 'var(--muted)' }}>
            {netInfo?.error ? (
              <span style={{ color: 'var(--err)' }}>{netInfo.error}</span>
            ) : (
              <>
                结算模式由服务端启动方式决定(<code style={{ color: 'var(--text)', fontSize: 11 }}>MESH_SETTLE_MODE</code> 变量,取值
                <code style={{ color: 'var(--text)', fontSize: 11 }}>sim</code>/<code style={{ color: 'var(--text)', fontSize: 11 }}>devnet</code>/<code style={{ color: 'var(--text)', fontSize: 11 }}>mainnet</code>),重启 server 才能生效。
                {netMatch !== null && (
                  <>
                    <br />
                    当前 {netInfo.mode && netInfo.mode.label}:
                    {netMatch
                      ? <span style={{ color: 'var(--ok)' }}>✓ 所选网络与服务器一致</span>
                      : <span style={{ color: 'var(--warn)' }}>△ 所选网络与服务器不一致(结算将沿用服务器当前模式)</span>}
                  </>
                )}
                {netMatch === false && (
                  <>
                    <br />
                    需切换: 停止 server,改
                    <code style={{ color: 'var(--text)', fontSize: 11 }}>MESH_SETTLE_MODE</code>
                    后重新
                    <code style={{ color: 'var(--text)', fontSize: 11 }}>npm run dev</code>。
                  </>
                )}
              </>
            )}
          </div>
        </div>
        <button onClick={login} disabled={logging} style={{ marginTop: 18, padding: '12px 28px', fontSize: 15 }}>
          {logging ? '正在登录…' : '用钱包登录'}
        </button>
        <div>
          <button onClick={importDemoKey} className="ghost" style={{ marginTop: 10, fontSize: 12 }}>
            导入 Demo 钱包密钥(换机器 / 换端口协议时用)
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          已安装 Phantom 时优先使用;否则自动生成浏览器内 Demo 钱包(Ed25519,可离线签名)。
        </p>
        {loginErr && <p style={{ color: 'var(--err)' }}>{loginErr}</p>}
      </div>
    )
  }

  return (
    <div>
      <div className="topbar">
        <div style={{ fontWeight: 700, fontSize: 16 }}>MeshLLM</div>
        <div className="row">
          <span className="pill mono" title={wallet.address}>
            {wallet.name} · {shortAddr(wallet.address)}
          </span>
          <button className="ghost" onClick={logout}>
            退出
          </button>
        </div>
      </div>
      <div className="wrap">
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {/* 三个页签保持挂载(仅用 CSS 隐藏):切走时 Provider 的 agent/心跳不卸载,
            否则 provider 会随页签切换而下线 */}
        <div style={{ display: tab === 'market' ? 'block' : 'none' }}>
          <Market wallet={wallet} pushLog={pushLog} />
        </div>
        <div style={{ display: tab === 'provider' ? 'block' : 'none' }}>
          <ProviderPanel wallet={wallet} pushLog={pushLog} />
        </div>
        <div style={{ display: tab === 'escrow' ? 'block' : 'none' }}>
          <EscrowPanel wallet={wallet} pushLog={pushLog} />
        </div>
        <div style={{ display: tab === 'config' ? 'block' : 'none' }}>
          <ConfigPanel wallet={wallet} pushLog={pushLog} />
        </div>
        <div className="card" style={{ marginTop: 18 }}>
          <h3 style={{ marginTop: 0 }}>事件日志</h3>
          <div className="mono" style={{ maxHeight: 160, overflow: 'auto', fontSize: 11.5, lineHeight: 1.7 }}>
            {log.length === 0 && <span className="muted">(暂无事件)</span>}
            {log.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
