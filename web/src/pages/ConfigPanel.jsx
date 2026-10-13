import React, { useCallback, useEffect, useState } from 'react'
import { api, downloadJson } from '../api.js'
import { shortAddr } from '../wallet.js'

// 网页端 config.json 配置页。
// 原则:能自动填的一律自动填 —— server 地址取自当前页面主机、TLS 取自页面协议、
// 证书/钱包路径用项目默认值、listings 从"我的 Listing"直接生成(含已保存的 API Key)。
// 写入走服务端 /agent-config(浏览器无法写磁盘);未知字段由服务端合并保留。
const KEY_PREFIX = 'meshllm-apikey:'

export default function ConfigPanel({ wallet, pushLog }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [applying, setApplying] = useState(false)
  const [info, setInfo] = useState(null)
  const [cfg, setCfg] = useState(null)
  const [auto, setAuto] = useState({ enable: false, startServer: true, startAgent: true, hidden: true })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api('/agent-config')
      setInfo(r)
      // 文件不存在时按默认值 + 当前页面自动填充(用户只需确认,不必从零填)
      const host = location.hostname || '127.0.0.1'
      const base = r.config || { ...r.defaults, listings: [] }
      if (!r.config) base.server = host + ':4011'
      setCfg(base)
      setAuto((a) => ({ ...a, enable: !!r.autostart?.enabled }))
      pushLog(r.config ? '已读取配置: config.json' : 'config.json 不存在,已按默认值 + 当前页面预填')
    } catch (e) {
      pushLog('读取配置失败: ' + e.message)
    } finally {
      setLoading(false)
    }
  }, [pushLog])

  useEffect(() => {
    load()
  }, [load])

  const set = (k) => (e) => setCfg((c) => ({ ...c, [k]: e.target.value }))

  // 自动填充:当前页面主机 + 项目默认路径
  const autoFill = async () => {
    const host = location.hostname || '127.0.0.1'
    const r = await api('/listings?provider=' + encodeURIComponent(wallet.address))
    const mine = (r.listings || []).filter((l) => l.status === 'active')
    if (mine.length === 0) {
      pushLog('自动填充:没有你名下的 Listing,只填了 server/TLS/路径')
    }
    setCfg((c) => ({
      ...c,
      server: host + ':4011',
      tls: location.protocol === 'https:',
      caCert: c.caCert || '../server/tls/cert.pem',
      wallet: c.wallet || './wallet.json',
      heartbeatSec: c.heartbeatSec || 30,
      probeSec: c.probeSec || 30,
      probeFailThreshold: c.probeFailThreshold || 2,
      listings: mine.map((l) => ({
        listingId: l.id,
        apiKey: localStorage.getItem(KEY_PREFIX + l.id) || '',
      })),
    }))
    pushLog('已自动填充:server=' + host + ':4011, listings=' + mine.length)
  }

  const save = async () => {
    setSaving(true)
    try {
      const r = await api('/agent-config', { method: 'POST', body: cfg })
      setCfg(r.config)
      pushLog('已写入 config.json: ' + r.config.listings.length + ' 个 listing')
    } catch (e) {
      pushLog('保存失败: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const applyAutostart = async () => {
    setApplying(true)
    try {
      const r = await api('/autostart', { method: 'POST', body: auto })
      setAuto((a) => ({ ...a, enable: !!r.enabled }))
      if (r.enabled) pushLog('开机自启已启用: ' + r.file)
      else if (r.supported) pushLog('开机自启已取消')
      else pushLog('当前系统不支持自动写入启动文件夹,脚本内容可复制/下载后手工放置')
      if (r.script) pushLog('脚本: ' + r.script.split('\n')[0])
      load()
    } catch (e) {
      pushLog('开机自启设置失败: ' + e.message)
    } finally {
      setApplying(false)
    }
  }

  if (loading || !cfg) return <p className="muted">读取配置中…</p>

  return (
    <div>
      <h1>配置 (config.json)</h1>
      <p className="muted">
        Agent 的配置文件 <span className="mono">{info?.path || 'agent/config.json'}</span>
        。本页只读写这一份文件;保存后需重启 Agent 才生效。
      </p>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>1) 自动填充</h3>
        <div className="row">
          <button onClick={autoFill} className="ghost">按当前页面 + 我的 Listing 自动填充</button>
          <span className="muted">
            登录钱包 {shortAddr(wallet.address)} · 当前页 {location.host}
          </span>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>2) Agent 参数</h3>
        <div className="grid2">
          <div>
            <label>平台服务器 (host:port)</label>
            <input value={cfg.server || ''} onChange={set('server')} placeholder="127.0.0.1:4011" />
            <label>使用 TLS (https/wss)</label>
            <select value={String(!!cfg.tls)} onChange={(e) => setCfg((c) => ({ ...c, tls: e.target.value === 'true' }))}>
              <option value="true">是(自签证书)</option>
              <option value="false">否(纯 http)</option>
            </select>
            <label>CA 证书路径(相对 agent/)</label>
            <input value={cfg.caCert || ''} onChange={set('caCert')} placeholder="../server/tls/cert.pem" />
            <label>钱包文件(相对 agent/)</label>
            <input value={cfg.wallet || ''} onChange={set('wallet')} placeholder="./wallet.json" />
          </div>
          <div>
            <label>心跳间隔(秒)</label>
            <input value={String(cfg.heartbeatSec ?? 30)} onChange={set('heartbeatSec')} />
            <label>模型健康探测间隔(秒)</label>
            <input value={String(cfg.probeSec ?? 30)} onChange={set('probeSec')} />
            <label>连续失败判定下线(次)</label>
            <input value={String(cfg.probeFailThreshold ?? 2)} onChange={set('probeFailThreshold')} />
            <p className="muted" style={{ fontSize: 12 }}>
              这些值与 Agent 的在线判定直接相关:心跳 ≤ 服务端 presence TTL(120s),
              探测失败达阈值会主动下线。
            </p>
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>3) listings(采用你名下的 Listing)</h3>
        {(!cfg.listings || cfg.listings.length === 0) && <p className="muted">当前为空。用上面的自动填充,或手工添加。</p>}
        {(cfg.listings || []).map((e, i) => (
          <div className="row" key={i} style={{ marginBottom: 8 }}>
            <input
              style={{ flex: 2, minWidth: 260 }}
              value={e.listingId || ''}
              placeholder="listingId"
              onChange={(ev) =>
                setCfg((c) => ({
                  ...c,
                  listings: c.listings.map((x, j) => (j === i ? { ...x, listingId: ev.target.value } : x)),
                }))
              }
            />
            <input
              style={{ flex: 1, minWidth: 160 }}
              value={e.apiKey || ''}
              placeholder="API Key(可留空)"
              onChange={(ev) =>
                setCfg((c) => ({
                  ...c,
                  listings: c.listings.map((x, j) => (j === i ? { ...x, apiKey: ev.target.value } : x)),
                }))
              }
            />
            <button
              className="ghost"
              onClick={() => setCfg((c) => ({ ...c, listings: c.listings.filter((_, j) => j !== i) }))}
            >
              删除
            </button>
          </div>
        ))}
        <div className="row">
          <button
            className="ghost"
            onClick={() => setCfg((c) => ({ ...c, listings: [...(c.listings || []), { listingId: '', apiKey: '' }] }))}
          >
            添加一行
          </button>
          <button onClick={save} disabled={saving}>
            {saving ? '保存中…' : '写入 config.json'}
          </button>
          <button className="ghost" onClick={() => downloadJson('agent-config.json', cfg)}>
            下载 JSON
          </button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>4) 开机启动服务</h3>
        <div className="row" style={{ marginBottom: 10 }}>
          <span className={'badge ' + (info?.autostart?.enabled ? 'online' : 'offline')}>
            {info?.autostart?.enabled ? '已启用' : '未启用'}
          </span>
          <span className="muted">
            {info?.autostart?.supported
              ? '写入启动文件夹: ' + info.autostart.dir
              : '当前系统(' + info?.autostart?.platform + ')不支持自动写入,可下载脚本手工放置'}
          </span>
        </div>
        <div className="row" style={{ marginBottom: 8 }}>
          <label>
            <input type="checkbox" checked={auto.enable} onChange={(e) => setAuto((a) => ({ ...a, enable: e.target.checked }))} />
            {' '}开机时启用
          </label>
          <label>
            <input type="checkbox" checked={auto.startServer} onChange={(e) => setAuto((a) => ({ ...a, startServer: e.target.checked }))} />
            {' '}启动平台服务(4011)
          </label>
          <label>
            <input type="checkbox" checked={auto.startAgent} onChange={(e) => setAuto((a) => ({ ...a, startAgent: e.target.checked }))} />
            {' '}启动 Agent(接单)
          </label>
          <label>
            <input type="checkbox" checked={auto.hidden} onChange={(e) => setAuto((a) => ({ ...a, hidden: e.target.checked }))} />
            {' '}后台隐藏运行
          </label>
        </div>
        <div className="row">
          <button onClick={applyAutostart} disabled={applying}>
            {applying ? '应用中…' : '应用开机启动'}
          </button>
          <span className="muted">node 路径自动用当前服务进程: {info?.nodePath}</span>
        </div>
        {info?.autostart?.script && (
          <div className="mono" style={{ marginTop: 10, fontSize: 11.5, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
            {info.autostart.script}
          </div>
        )}
        <p className="muted" style={{ fontSize: 12 }}>
          Agent 启动后会自己等服务器就绪(最多 10 分钟),所以两项同时开机启动是安全的。
        </p>
      </div>
    </div>
  )
}
