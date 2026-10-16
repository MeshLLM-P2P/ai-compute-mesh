import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, SERVER, getSession } from '../api.js'
import { startProviderAgent } from '../session.js'
import { listingHashOf, hexToBytes, b64encode } from '@mesh/shared/protocol'
import { anthropicHeaders } from '@mesh/shared/channel'
import { fmtUsd, shortHash, ts } from '../util.js'
import { DEMO_KEY } from '../wallet.js'

// 发布表单持久化:整页刷新会清空表单(model/backendType/backendUrl 全丢),
// 用户看到的就是"探测不到模型 ID / 无法发布"——刷新后 apiKey 为空,第三方后端
// 一律 401;若类型是 echo,探测按钮还会被禁用。这里恢复上次的表单状态。
// apiKey 不进这份持久化(密钥不应长期落盘),由 LAST_KEY_KEY 单独回退。
const FORM_PREF_KEY = 'meshllm-provider-form'
const LAST_KEY_KEY = 'meshllm-provider-lastkey'
const DEFAULT_FORM = {
  model: '',
  backendType: 'mock', // echo | mock | custom(OpenAI 兼容) | anthropic(Claude)
  backendUrl: '',
  apiKey: '', // custom/anthropic 后端密钥:只在浏览器内存 + 中继请求中,不写入 listing
  useRelay: false, // custom/anthropic:走平台中继绕过浏览器 CORS
  per1kIn: '0.005',
  per1kOut: '0.015',
  per1kCache: '0.001', // 留空 = 与输入同价
  minFee: '0.0001',
  maxTokens: '2000',
  maxUsers: '2',
  bondUsdt: '100',
  version: '1',
}
const readFormPrefs = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(FORM_PREF_KEY) || '{}')
    return { ...DEFAULT_FORM, ...raw, apiKey: '' }
  } catch {
    return { ...DEFAULT_FORM }
  }
}
const saveFormPref = (k, v) => {
  try {
    localStorage.setItem(FORM_PREF_KEY, JSON.stringify({ ...readFormPrefs(), [k]: v }))
  } catch {}
}

export default function ProviderPanel({ wallet, pushLog }) {
  // 初始表单从本地恢复(FORM_PREF_KEY)。apiKey 不在表单持久化里,但按"上次用过的
  // key"回退填充 —— 否则整页刷新后探测必然 401,用户看到的就是"获取不到模型 ID"。
  const [form, setForm] = useState(() => {
    const f = readFormPrefs()
    try {
      f.apiKey = localStorage.getItem(LAST_KEY_KEY) || ''
    } catch {}
    return f
  })
  const [myListings, setMyListings] = useState([])
  const [publishing, setPublishing] = useState(false)
  const [models, setModels] = useState([])
  const [probing, setProbing] = useState(false)
  const [stateMap, setStateMap] = useState({}) // listingId -> { online, phase }
  const [logListingId, setLogListingId] = useState('')
  const [calls, setCalls] = useState([])
  const agentsRef = useRef({})
  const beatsRef = useRef({})
  // 本页启动过的 agent(与服务器 presence 无关)。页面重载后本上下文必然没有活 agent,
  // 恢复逻辑必须只看这个集合,不能信服务端 online(重载后 120s 内仍是旧的"在线")
  const startedRef = useRef(new Set())

  // 用户手动上线过的 listing 持久化:整页刷新会杀掉所有 agent,
  // 刷新后据此自动恢复上线
  const ONLINE_PREF_KEY = 'meshllm-online-prefs'
  const readPrefs = () => {
    try {
      return JSON.parse(localStorage.getItem(ONLINE_PREF_KEY) || '[]')
    } catch {
      return []
    }
  }
  const savePrefs = (ids) => {
    try {
      localStorage.setItem(ONLINE_PREF_KEY, JSON.stringify(ids))
    } catch {}
  }

  // 后端 API key 按 listing 存本机 localStorage(仍不写入 listing;信任级别与
  // 钱包 key 相同)。没有这一步,整页刷新后「自动恢复上线」的 agent 表单为空、
  // key 丢失 → 第三方 backend 一律 401(05:38 tlvip 故障根因)
  const readSavedKey = (id) => {
    try {
      return localStorage.getItem('meshllm-apikey:' + id) || ''
    } catch {
      return ''
    }
  }
  const saveKeyFor = (id, key) => {
    try {
      if (key) localStorage.setItem('meshllm-apikey:' + id, key)
      else localStorage.removeItem('meshllm-apikey:' + id)
    } catch {}
  }

  const set = (k) => (e) => {
    const v = e.target.value
    saveFormPref(k, v)
    // 密钥单独记一份"上次用过的 key",刷新后新发布也能回退(否则探测必然 401)
    if (k === 'apiKey' && v) {
      try {
        localStorage.setItem(LAST_KEY_KEY, v)
      } catch {}
    }
    setForm((f) => ({ ...f, [k]: v }))
  }

  const loadMine = useCallback(async () => {
    try {
      // [P3 供应方仪表盘] 附 stats=1:返回 revenueRaw/totalCalls/providerRep/activeUsers
      const r = await api('/listings?provider=' + encodeURIComponent(wallet.address) + '&stats=1')
      const active = (r.listings || []).filter((l) => l.status === 'active')
      setMyListings(active)
      // 在线状态以服务端 presence 为准(而不是本地点击记录),
      // 这样切换页签/刷新后徽章仍与市场一致
      setStateMap((cur) => {
        const next = { ...cur }
        for (const l of active) {
          const prev = next[l.id]
          next[l.id] = { online: !!l.online, phase: prev?.phase || null }
        }
        return next
      })
      setLogListingId((cur) =>
        cur && active.some((l) => l.id === cur) ? cur : active[0]?.id || ''
      )
    } catch {}
  }, [wallet.address])

  useEffect(() => {
    loadMine()
    const t = setInterval(loadMine, 8000) // 定期同步在线状态
    return () => clearInterval(t)
  }, [loadMine])

  useEffect(() => () => {
    // 卸载:清理所有 agent 与心跳
    for (const id of Object.keys(agentsRef.current)) {
      agentsRef.current[id] && agentsRef.current[id].stop()
      agentsRef.current[id] = null
    }
    for (const id of Object.keys(beatsRef.current)) {
      const b = beatsRef.current[id]
      if (b && b.timer) clearInterval(b.timer)
      beatsRef.current[id] = null
    }
    if (disarmTimer.current) clearTimeout(disarmTimer.current)
  }, [])

  // 页签重新可见时立即补一次心跳(后台页签的定时器会被浏览器节流,
  // 这是 Provider "自动下线" 的主因之一)
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== 'visible') return
      for (const id of Object.keys(beatsRef.current)) {
        const b = beatsRef.current[id]
        if (b && b.beat) b.beat()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // 页面刷新/关闭时立即通知服务端清 presence,不让 120s TTL 把已死 agent 挂成"在线"。
  // sendBeacon 无法携带自定义 header,session 走 query 参数(服务端已支持)
  useEffect(() => {
    const onHide = () => {
      const token = getSession()
      if (!token) return
      for (const id of Object.keys(beatsRef.current)) {
        if (!beatsRef.current[id]) continue
        navigator.sendBeacon(
          SERVER +
            '/presence/offline?session=' +
            encodeURIComponent(token) +
            '&listingId=' +
            encodeURIComponent(id)
        )
      }
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [])

  // 页面刷新后自动恢复之前手动上线的 listing(agent 不会跨刷新存活)
  useEffect(() => {
    let cancelled = false
    const restore = async () => {
      const prefs = readPrefs()
      if (prefs.length === 0) return
      let r = null
      try {
        r = await api('/listings?provider=' + encodeURIComponent(wallet.address))
      } catch {
        return
      }
      if (cancelled || !r) return
      for (const l of r.listings || []) {
        // 不判断 l.online:重载后服务端 presence 可能仍是旧的"在线"(120s TTL),
        // 而本页必然没有活 agent —— 只认 startedRef
        if (l.status === 'active' && prefs.includes(l.id) && !startedRef.current.has(l.id)) {
          pushLog('自动恢复上线: ' + (l.model?.name || shortHash(l.id, 8)))
          setOnlineFor(l, true)
        }
      }
    }
    const t = setTimeout(restore, 1500) // 等首屏 loadMine 完成后再恢复
    return () => {
      cancelled = true
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.address])

  const cachePriceRaw = () => {
    const v = Math.round(parseFloat(form.per1kCache) * 1e6)
    return Number.isFinite(v) && v >= 0 ? v : Math.round(parseFloat(form.per1kIn) * 1e6)
  }
  const buildSigned = async (modelName) => {
    const payload = {
      provider: wallet.address,
      p2pPublicKey: wallet.address, // demo: 钱包公钥作为 P2P 身份锚
      model: { name: modelName, context: 8192, modalities: ['text'] },
      pricing: {
        currency: 'USDT',
        per1kInputRaw: Math.round(parseFloat(form.per1kIn) * 1e6),
        per1kOutputRaw: Math.round(parseFloat(form.per1kOut) * 1e6),
        // 缓存命中单价;留空 = 与输入同价
        per1kCacheRaw: cachePriceRaw(),
        minFeeRaw: Math.round(parseFloat(form.minFee) * 1e6),
      },
      limits: {
        maxTokens: parseInt(form.maxTokens, 10) || 2000,
        maxConcurrent: Math.max(1, parseInt(form.maxUsers, 10) || 2),
      },
      metering: { charsPerToken: 4, tolerancePct: 5 },
      bondUsdtRaw: Math.round(parseFloat(form.bondUsdt) * 1e6),
      version: parseInt(form.version, 10) || 1,
      backend: {
        type: form.backendType,
        url: form.backendUrl,
        // custom(OpenAI 兼容)与 anthropic 都可能受 CORS 限制,都允许勾选中继
        relay:
          form.backendType === 'custom' || form.backendType === 'anthropic'
            ? !!form.useRelay
            : false,
      },
    }
    const id = await listingHashOf(payload)
    const signatureB64 = b64encode(await wallet.signMessage(hexToBytes(id)))
    return { payload, id, signatureB64 }
  }

  const doPublish = async (modelName) => {
    const { payload, id, signatureB64 } = await buildSigned(modelName)
    const { listing: stored } = await api('/listings', {
      method: 'POST',
      body: { listing: { ...payload, id }, signature: signatureB64 },
    })
    // 同步质押保证金(仿真账本)
    if (stored.bondUsdtRaw > 0) {
      await api('/bonds', {
        method: 'POST',
        body: { provider: wallet.address, listingId: id, amountRaw: stored.bondUsdtRaw },
      })
    }
    return stored
  }

  const publish = async () => {
    if (!form.model.trim()) {
      pushLog('请先填写或探测选择模型名')
      return
    }
    setPublishing(true)
    try {
      const stored = await doPublish(form.model.trim())
      pushLog('Listing 已发布 v' + stored.version + ': ' + shortHash(stored.id, 10))
      setOnlineFor(stored, true) // 发布即上线:agent 自动启动,无需再点"上线"
      await loadMine()
    } catch (e) {
      pushLog('发布失败: ' + e.message)
    } finally {
      setPublishing(false)
    }
  }

  // 批量发布:探测到的每个模型各发一个 listing(同价同保证金)
  const publishAll = async () => {
    if (models.length === 0) return
    setPublishing(true)
    for (const name of models) {
      try {
        const stored = await doPublish(name)
        pushLog('已发布模型 ' + name + ': ' + shortHash(stored.id, 10))
        setOnlineFor(stored, true) // 批量发布同样自动上线
      } catch (e) {
        pushLog('发布 ' + name + ' 失败: ' + e.message)
      }
    }
    await loadMine()
    setPublishing(false)
    pushLog('批量发布完成')
  }

  // 从后端获取模型名:mock 走平台内置目录,custom 走 OpenAI 兼容 /v1/models
  const probeModels = async () => {
    if (form.backendType === 'echo') {
      pushLog('echo 后端没有模型目录,请手动填写模型名')
      return
    }
    setProbing(true)
    try {
      const isAnthropic = form.backendType === 'anthropic'
      let url
      if (form.backendType === 'mock') {
        url = SERVER + '/mock-llm/v1/models'
      } else {
        const u = form.backendUrl.trim()
        if (!u) throw new Error('请先填写后端 URL')
        // Anthropic 填的是 .../v1/messages,探测要换成 .../v1/models
        url = isAnthropic
          ? /\/messages\/?$/i.test(u)
            ? u.replace(/\/messages\/?$/i, '/models')
            : u.replace(/\/+$/, '') + '/models'
          : /\/chat\/completions\/?$/i.test(u)
            ? u.replace(/\/chat\/completions\/?$/i, '/models')
            : u.replace(/\/+$/, '') + '/models'
      }
      const useRelay = (form.backendType === 'custom' || isAnthropic) && form.useRelay
      const key = form.apiKey.trim()
      // 明确提示而不是让后端回一个 401:第三方后端无 Key 必然鉴权失败,
      // 用户看到的现象就是"获取不到模型 ID"。
      if ((form.backendType === 'custom' || isAnthropic) && !key)
        throw new Error('请先填写后端 API Key(该后端需要鉴权,无 Key 会 401)')
      // Anthropic 用 x-api-key + anthropic-version;其余 OpenAI 兼容端点用 Bearer
      const probeHeaders = isAnthropic ? anthropicHeaders(key) : { Authorization: 'Bearer ' + key }
      // 探测超时兜底:直连第三方 API 可能挂起(无 CORS 头 / 被 WAF 拦),
      // fetch 永不 settle 会让 probing 恒为 true,按钮永久 disabled,
      // 之后勾上「平台中继」再点也进不来(按钮已禁用)——正是"第一次没反应、
      // 勾了中继再点也没反应、一开始勾中继就正常"的根因。超时后走 catch 复位。
      const withTimeout = (p, ms, label) =>
        Promise.race([
          p,
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error(label + ' 超时 ' + ms / 1000 + 's 无响应')), ms)
          ),
        ])
      let j
      if (useRelay) {
        j = await withTimeout(
          api('/relay', {
            method: 'POST',
            body: { url, method: 'GET', headers: probeHeaders },
          }),
          15000,
          '中继探测'
        )
      } else {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), 10000)
        let res
        try {
          // 必须带鉴权头:Anthropic /v1/models 无 key 会 401,探测直接失败
          res = await fetch(url, { signal: ctl.signal, headers: probeHeaders })
        } catch (e) {
          clearTimeout(timer)
          if (e.name === 'AbortError')
            throw new Error('直连 10s 无响应(该后端多半不支持浏览器直连/CORS,请勾选「使用平台中继」)')
          throw e
        }
        clearTimeout(timer)
        if (!res.ok) {
          if (res.status === 401) throw new Error('HTTP 401 鉴权失败:API Key 不对或未生效')
          throw new Error('HTTP ' + res.status + '(直连失败,建议勾选「使用平台中继」)')
        }
        j = await res.json()
      }
      const arr = Array.isArray(j.data) ? j.data : Array.isArray(j) ? j : []
      const names = arr.map((m) => (typeof m === 'string' ? m : (m && m.id) || '')).filter(Boolean)
      if (names.length === 0) throw new Error('后端未返回模型列表')
      setModels(names)
      setForm((f) => ({ ...f, model: names[0] }))
      pushLog('探测到 ' + names.length + ' 个模型: ' + names.join(', '))
    } catch (e) {
      pushLog('探测模型失败: ' + e.message)
    } finally {
      setProbing(false)
    }
  }

  // 每个 listing 独立 agent + 独立心跳
  const setOnlineFor = (l, on) => {
    const id = l.id
    const patch = (p) => setStateMap((m) => ({ ...m, [id]: { online: on, phase: p } }))
    if (on) {
      patch(null)
      const beat = async () => {
        try {
          await api('/presence', { method: 'POST', body: { listingId: id } })
        } catch (e) {
          // 401 = 会话 token 过期(30min TTL):agent 还活着但服务端不收心跳,
          // 卡片会永远"离线"且后续回执提交也会失败 —— 明确告警而不是静默
          if (e.status === 401 && !beat.warned) {
            beat.warned = true
            pushLog('⚠ 会话已过期(30 分钟):心跳被拒绝。请在页面顶部重新登录,agent 无需重启')
          }
        }
      }
      beat()
      const prev = beatsRef.current[id]
      if (prev && prev.timer) clearInterval(prev.timer)
      beatsRef.current[id] = { timer: setInterval(beat, 5000), beat }
      // [阶段1 节点发现] 心跳同时给 /peers 续命(join 幂等,顺带刷新 models)
      joinPeer()
      if (!agentsRef.current[id]) {
        try {
          // 表单里的 key 优先(并持久化);空表单(自动恢复)回退到上次保存的 key
          const formKey = form.apiKey.trim()
          if (formKey) saveKeyFor(id, formKey)
          agentsRef.current[id] = startProviderAgent({
            listing: l,
            wallet,
            apiKey: (formKey || readSavedKey(id)) || null,
            log: (s) => pushLog('agent[' + shortHash(id, 6) + ']: ' + s),
            onCall: (c) => patch(c.phase || 'connecting'),
            onCallEnd: (c) => {
              pushLog('agent[' + shortHash(id, 6) + '] 调用结束: ' + (c.ok ? '成功' : c.error || '失败'))
              patch(null)
            },
          })
        } catch (e) {
          // agent 启动失败:停掉心跳并回退状态,避免"假在线"
          const b = beatsRef.current[id]
          if (b && b.timer) clearInterval(b.timer)
          beatsRef.current[id] = null
          setStateMap((m) => ({ ...m, [id]: { online: false, phase: null } }))
          startedRef.current.delete(id)
          savePrefs(readPrefs().filter((x) => x !== id))
          pushLog('agent 上线失败: ' + e.message)
          return
        }
      }
      startedRef.current.add(id)
      savePrefs([...new Set([...readPrefs(), id])])
      // [阶段1 节点发现] agent 上线 = 宣告本节点加入网络(携带该模型摘要)
      peerModelsRef.current = [
        ...peerModelsRef.current.filter((m) => m.listingId !== id),
        { name: l.model?.name || shortHash(id, 8), listingId: id },
      ]
      joinPeer()
      pushLog('agent 上线: ' + (l.model?.name || shortHash(id, 8)))
    } else {
      const b = beatsRef.current[id]
      if (b && b.timer) clearInterval(b.timer)
      beatsRef.current[id] = null
      // 立即通知服务端清 presence,否则要等 120s TTL 衰减;
      // 期间 UI 的 8s 轮询会把徽章翻回"已上线",市场也继续显示"在线"
      api('/presence/offline', { method: 'POST', body: { listingId: id } }).catch(() => {})
      agentsRef.current[id] && agentsRef.current[id].stop()
      agentsRef.current[id] = null
      startedRef.current.delete(id)
      patch(null)
      savePrefs(readPrefs().filter((x) => x !== id))
      // [阶段1 节点发现] 从节点模型清单移除;清单空了则正式离开网络
      peerModelsRef.current = peerModelsRef.current.filter((m) => m.listingId !== id)
      if (peerModelsRef.current.length === 0) {
        api('/peers/leave', { method: 'POST', body: {} }).catch(() => {})
      } else {
        joinPeer()
      }
      pushLog('agent 下线: ' + (l.model?.name || shortHash(id, 8)))
    }
  }

  // 删除 listing:两步内联确认,不用 window.confirm。
  // 原因:浏览器若拦截 JS 弹窗/对话框,confirm 会静默返回 false,点击"删除模型"
  // 看起来毫无反应、模型删不掉,且无任何日志。改为:第一次点击"arm"(按钮变
  // 成"确认删除/取消"),第二次点击才真正删除;8s 未确认自动取消。每个分支都有日志。
  const [confirmDelId, setConfirmDelId] = useState(null)
  const disarmTimer = useRef(null)
  // [阶段1 节点发现] 本浏览器节点当前在线的模型摘要,agent 上线时同步宣告。
  // nodeId 按钱包派生(一个浏览器 = 一个节点);下线到空时自动 leave。
  const peerModelsRef = useRef([])
  const joinPeer = () => {
    api('/peers/join', {
      method: 'POST',
      body: { nodeId: 'browser:' + wallet.address.slice(0, 16), models: peerModelsRef.current },
    }).catch(() => {})
  }
  const armDelete = (l) => {
    setConfirmDelId(l.id)
    pushLog('准备删除「' + (l.model?.name || shortHash(l.id, 8)) + '」:再点一次「确认删除」执行(8 秒后自动取消)')
    if (disarmTimer.current) clearTimeout(disarmTimer.current)
    disarmTimer.current = setTimeout(() => setConfirmDelId(null), 8000)
  }
  const cancelDelete = () => {
    if (disarmTimer.current) clearTimeout(disarmTimer.current)
    setConfirmDelId(null)
    pushLog('已取消删除')
  }
  const doDelete = async (l) => {
    if (disarmTimer.current) clearTimeout(disarmTimer.current)
    setConfirmDelId(null)
    setOnlineFor(l, false)
    try {
      await api('/listings/' + l.id, { method: 'DELETE' })
      pushLog('已删除 listing ' + shortHash(l.id, 10))
      await loadMine()
    } catch (e) {
      pushLog('删除失败: ' + e.message)
    }
  }

  // 导出钱包文件(Node agent 用)。仅 Demo 钱包可导出(私钥在 localStorage);
  // Phantom 不暴露私钥,无法导出。生成 { address, secretKeyB64 } 并触发下载。
  const exportWalletFile = () => {
    if (wallet.name !== 'Demo 钱包') {
      pushLog('仅 Demo 钱包可导出钱包文件(Phantom 不暴露私钥)')
      return
    }
    try {
      const raw = localStorage.getItem(DEMO_KEY)
      if (!raw) {
        pushLog('本地未找到 Demo 钱包密钥')
        return
      }
      const secretKey = Uint8Array.from(JSON.parse(raw))
      if (secretKey.length !== 64) throw new Error('密钥长度异常')
      const obj = { address: wallet.address, secretKeyB64: b64encode(secretKey) }
      const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'wallet.json'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      pushLog('已导出 wallet.json:放入 agent/ 目录,config.json 的 listings 填本钱包的 listingId 即可')
    } catch (e) {
      pushLog('导出失败: ' + e.message)
    }
  }

  // 调用记录:轮询选中的 listing,并拉取每个消费者钱包的信誉(结算率)
  const [repMap, setRepMap] = useState({})
  useEffect(() => {
    if (!logListingId) {
      setCalls([])
      setRepMap({})
      return
    }
    const load = async () => {
      try {
        const r = await api('/listings/' + logListingId + '/calls')
        const cs = r.calls || []
        setCalls(cs)
        // 调用记录里出现过的消费者钱包,逐个查信誉(结算率 = settled/(settled+abandoned))
        const wallets = [...new Set(cs.map((c) => c.consumer).filter(Boolean))]
        if (wallets.length === 0) {
          setRepMap({})
          return
        }
        const reps = await Promise.all(
          wallets.map(async (w) => {
            try {
              const rr = await api('/consumers/reputation?wallet=' + encodeURIComponent(w))
              return [w, rr]
            } catch {
              return [w, null]
            }
          })
        )
        setRepMap(Object.fromEntries(reps))
      } catch {}
    }
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [logListingId])

  const backendLabel = (l) => {
    const t = (l.backend && l.backend.type) || 'echo'
    return t === 'custom' && l.backend.url ? 'custom ' + shortHash(l.backend.url, 18) : t
  }

  return (
    <div>
      <h1>Provider 面板</h1>
      <p className="muted">
        一个账户可以在多个后端发布多个模型:每个模型一个独立 listing,Agent 逐个上线接单。真实 API 密钥只存在于你的后端,绝不经过平台。
      </p>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>1) 发布 / 更新 Listing</h3>
        <div className="grid2">
          <div>
            <label>模型名称(会原样发给你的后端)</label>
            <input
              value={form.model}
              onChange={set('model')}
              placeholder="如 gpt-4o,或点右侧按钮探测"
            />
            <div className="row" style={{ alignItems: 'center', gap: 8, marginTop: 6 }}>
              <button
                type="button"
                onClick={probeModels}
                disabled={probing || form.backendType === 'echo'}
                className="ghost"
                title={
                  form.backendType === 'echo'
                    ? 'echo 是本地回显演示后端,没有模型目录,请手动填写模型名'
                    : form.backendType !== 'mock' && !form.apiKey.trim()
                      ? '该后端需要 API Key,请先填写 Key'
                      : ''
                }
              >
                {probing ? '探测中…' : '探测后端模型'}
              </button>
              {models.length > 0 && (
                <select value={form.model} onChange={set('model')}>
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <label>后端类型</label>
            <select value={form.backendType} onChange={set('backendType')}>
              <option value="echo">echo(本地确定性回显,演示用)</option>
              <option value="mock">mock(平台内置流式 mock LLM)</option>
              <option value="custom">custom(你的 OpenAI 兼容端点,直连需 CORS,或勾选平台中继)</option>
              <option value="anthropic">anthropic(Claude Messages API,直连需 CORS,或勾选平台中继)</option>
            </select>
            {(form.backendType === 'custom' || form.backendType === 'anthropic') && (
              <>
                <label>后端 URL</label>
                <input
                  value={form.backendUrl}
                  onChange={set('backendUrl')}
                  placeholder={
                    form.backendType === 'anthropic'
                      ? 'https://api.anthropic.com/v1/messages'
                      : 'https://…/v1/chat/completions'
                  }
                />
                <label>
                  API Key(直连随请求头 / 中继随请求转发,不写入 listing;
                  填一次后存本机,刷新页面后自动恢复的 agent 也会带上)
                </label>
                <input
                  value={form.apiKey}
                  onChange={set('apiKey')}
                  type="password"
                  placeholder={form.backendType === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
                  autoComplete="off"
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={!!form.useRelay}
                    onChange={(e) => setForm((f) => ({ ...f, useRelay: e.target.checked }))}
                  />
                  使用平台中继(绕过浏览器 CORS,第三方 API 推荐)
                </label>
              </>
            )}
          </div>
          <div>
            <label>价格 — 每 1k 输入 tokens(USD)</label>
            <input value={form.per1kIn} onChange={set('per1kIn')} />
            <label>价格 — 每 1k 输出 tokens(USD)</label>
            <input value={form.per1kOut} onChange={set('per1kOut')} />
            <label>价格 — 每 1k 缓存命中 tokens(USD,留空=与输入同价)</label>
            <input value={form.per1kCache} onChange={set('per1kCache')} />
            <label>最低费用(USD)</label>
            <input value={form.minFee} onChange={set('minFee')} />
            <label>maxTokens</label>
            <input value={form.maxTokens} onChange={set('maxTokens')} />
             <label>用户数量限制(最大并发连接)</label>
             <input value={form.maxUsers} onChange={set('maxUsers')} />
            <label>质押保证金(USD)</label>
            <input value={form.bondUsdt} onChange={set('bondUsdt')} />
            <label>版本(同模型同后端改价 = 新版本,替代旧版)</label>
            <input value={form.version} onChange={set('version')} />
          </div>
        </div>
        <button onClick={publish} disabled={publishing} style={{ marginTop: 12 }}>
          发布 Listing(钱包签名)
        </button>
        {models.length > 1 && (
          <button onClick={publishAll} disabled={publishing} style={{ marginLeft: 8 }}>
            批量发布全部模型({models.length})
          </button>
        )}
        <p className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
          模型名 + 后端共同决定 listing 身份:同模型换后端 = 新 listing(并存);同模型同后端改价 = 新版本(替代旧版)。
        </p>
      </div>

      {myListings.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>2) 我的 Listings({myListings.length})</h3>
          <table>
            <thead>
              <tr>
                <th>模型</th>
                <th>后端</th>
                <th>v</th>
                <th>价格(每 1k 入/出/缓存)</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {myListings.map((l) => {
                const st = stateMap[l.id] || { online: false, phase: null }
                return (
                  <tr key={l.id}>
                    <td className="mono" title={l.id}>
                      {l.model?.name}
                      <br />
                      <span style={{ fontSize: 11, opacity: 0.6 }}>{shortHash(l.id, 14)}</span>
                    </td>
                    <td>{backendLabel(l)}</td>
                    <td>{l.version}</td>
                    <td className="mono">
                      {fmtUsd(l.pricing?.per1kInputRaw)} / {fmtUsd(l.pricing?.per1kOutputRaw)} / {fmtUsd(l.pricing?.per1kCacheRaw ?? l.pricing?.per1kInputRaw)}
                    </td>
                    <td>
                      {st.online ? (
                        <span className="badge online">
                          已上线{st.phase ? ' · ' + st.phase : ''}
                        </span>
                      ) : (
                        <span className="badge offline">离线</span>
                      )}
                    </td>
                    <td>
                      <button onClick={() => setOnlineFor(l, !st.online)} className={st.online ? 'danger' : ''}>
                        {st.online ? '下线 agent' : '上线 agent'}
                      </button>
                      {confirmDelId === l.id ? (
                        <>
                          <button onClick={() => doDelete(l)} className="danger">
                            确认删除
                          </button>
                          <button onClick={cancelDelete} className="ghost">
                            取消
                          </button>
                        </>
                      ) : (
                        <button onClick={() => armDelete(l)} className="danger ghost">
                          删除模型
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {myListings.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>3) 调用记录</h3>
          <select value={logListingId} onChange={(e) => setLogListingId(e.target.value)}>
            {myListings.map((l) => (
              <option key={l.id} value={l.id}>
                {l.model?.name} ({shortHash(l.id, 8)})
              </option>
            ))}
          </select>
          {calls.length === 0 ? (
            <p className="muted">暂无记录。收到调用后,回执/结算/退款事件会出现在这里。</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>事件</th>
                  <th>消费者</th>
                  <th>session</th>
                  <th>tokens</th>
                  <th>金额 / txId</th>
                </tr>
              </thead>
              <tbody>
                {[...calls].reverse().slice(0, 20).map((c, i) => {
                  const rep = c.consumer ? repMap[c.consumer] : null
                  const rate = rep && rep.settleRate !== null && rep.settleRate !== undefined ? rep.settleRate : null
                  return (
                    <tr key={i}>
                      <td>{ts(c.ts)}</td>
                      <td>{c.event}</td>
                      <td className="mono">
                        {c.consumer ? (
                          <>
                            {c.consumer.slice(0, 4)}…{c.consumer.slice(-4)}
                            {rate === null ? (
                              <span className="badge offline" title="无结算/烂尾记录">
                                {' '}无记录
                              </span>
                            ) : (
                              <span
                                className={'badge ' + (rate >= 0.9 ? 'online' : rate >= 0.5 ? 'state' : 'offline')}
                                style={rate < 0.5 ? { background: 'rgba(255, 99, 99, 0.15)', color: 'var(--err)' } : undefined}
                                title={
                                  '结算 ' + rep.settled + ' 次 / 烂尾 ' + rep.abandoned +
                                  ' 次 / 取消 ' + rep.cancelled + ' 次 / 调用 ' + rep.calls + ' 次'
                                }
                              >
                                {' '}
                                结算率 {Math.round(rate * 100)}%
                              </span>
                            )}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="mono">{c.sessionId ? c.sessionId.slice(0, 8) + '…' : '—'}</td>
                      <td>
                        {c.tokensIn !== undefined ? c.tokensIn + ' / ' + c.tokensOut : '—'}
                      </td>
                      <td className="mono">
                        {c.amountRaw !== undefined ? fmtUsd(c.amountRaw) : c.txId ? c.txId : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          {/* [P3 供应方仪表盘] 收入/并发/调用质量(后端 /listings?stats=1 已就绪) */}
          {myListings.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h3 style={{ marginTop: 14 }}>收入与质量仪表盘</h3>
              <table>
                <thead>
                  <tr>
                    <th>模型 / 结算率</th>
                    <th>累计结算(我实收)</th>
                    <th>调用次数</th>
                    <th>当前在线用户</th>
                    <th>争议 / 败诉</th>
                  </tr>
                </thead>
                <tbody>
                  {myListings.map((l) => {
                    const rep = l.providerRep
                    const rate = rep?.settleRate
                    const quality =
                      rate === null
                        ? '—'
                        : rate >= 0.9
                          ? '优'
                          : rate >= 0.5
                            ? '中'
                            : '差'
                    return (
                      <tr key={l.id}>
                        <td className="mono">
                          {l.model?.name || shortHash(l.id, 10)}
                          {rate !== null && (
                            <span
                              className={'badge ' +
                              (rate >= 0.9
                                ? 'online'
                                : rate >= 0.5
                                  ? 'state'
                                  : 'offline')}
                              style={
                                rate < 0.5
                                  ? { background: 'rgba(255, 99, 99, 0.15)', color: 'var(--err)' }
                                  : undefined
                              }
                              title={'结算 ' +
                                (rep?.settled || 0) +
                                ' 次 / 调用 ' +
                                (rep?.calls || 0) +
                                ' 次 / 争议 ' +
                                (rep?.disputes || 0) +
                                ' 次 / 败诉 ' +
                                (rep?.disputesLost || 0) + ' 次'}
                            >
                              {' '}结算率 {Math.round(rate * 100)}%({quality})
                            </span>
                          )}
                        </td>
                        <td className="mono">{fmtUsd(l.revenueRaw || 0)}</td>
                        <td className="mono">{l.totalCalls || 0}</td>
                        <td className="mono">
                          {l.activeUsers || 0}
                          {l.limits && l.limits.maxConcurrent
                            ? ' / ' + l.limits.maxConcurrent
                            : ''}
                        </td>
                        <td className="mono">
                          {l.providerRep
                            ? (l.providerRep.disputes || 0) +
                              ' / ' +
                              (l.providerRep.disputesLost || 0)
                            : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p
                className="muted"
                style={{ fontSize: 11.5, marginTop: 8 }}
              >
                累计结算为平台按 listing 定价 × 实际 tokens 重算后的 Provider 实收
                (95%;5% 平台费已扣:维护 1% / 售后保障 2% / 推广 2%,见结算账户页顶部平台费用账本)。
              </p>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>4) Node Agent(无头方案 C)</h3>
        <p className="muted">
          以独立 Node 进程跑 provider:不需要浏览器登录,在线 = 进程在跑 ∧ 模型探测健康。
          点右侧按钮导出钱包文件,放到 agent/wallet.json,在 agent/config.json 填本钱包的 listingId,
          然后运行 agent/run.cmd(或 npm start -w agent)。
        </p>
        <button onClick={exportWalletFile} className="ghost">
          导出钱包文件(wallet.json)
        </button>
      </div>
    </div>
  )
}
