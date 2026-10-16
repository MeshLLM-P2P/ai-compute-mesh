// Bootstrap 联邦(阶段 3 提前):节点注册表跨服务器同步。
//
// 问题:每个 server 是独立 bootstrap,节点注册表只存本机 data.json ——
// 连 A bootstrap 的消费者看不到 join 在 B bootstrap 的节点。
//
// 方案(拉取式,无环路):每个 bootstrap 配置一组"对等 bootstrap" URL,
// 定时(默认 30s)GET 对端 /peers 合并进本地视图。合并后的联邦节点带
// origin 标记(来自哪个 bootstrap),在线判定 = 最近一次成功拉取在
// presenceTtlSec*2 内(上游 TTL 120s + 拉取间隔的余量)。
//
// 为什么拉取而不是推送:
// - 无环路(星型对等,每对独立拉取)
// - 对端 down 时本地不受影响(拉取失败静默跳过)
// - /peers 已是公开端点,无需鉴权
import https from 'node:https'
import http from 'node:http'

export function createFederation(store, cfg, peers) {
  const now = () => Date.now()

  // 配置来源:环境变量 MESH_PEER_BOOTSTRAPS(逗号分隔) ∪ store 'federation'
  const envList = () =>
    (cfg.peerBootstraps || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  const storedList = () => {
    const v = store.get('federation', [])
    return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : []
  }
  const bootstraps = () => [...new Set([...envList(), ...storedList()])]
  const setBootstraps = (urls) =>
    store.update('federation', () => (Array.isArray(urls) ? urls.map((s) => String(s).trim()).filter(Boolean).slice(0, 20) : []))

  // 联邦节点视图:fed_peers = { [bootstrapId]: { [nodeId]: peer+origin+lastFetched } }
  const fedView = () => store.get('fed_peers', {}) || {}
  const bootstrapId = (url) => String(url).replace(/\/+$/, '')
  // 自身标识(MESH_SELF_URL):用于回环防护 —— 对端返回的节点若 origin 是
  // 本 bootstrap,说明它本来就是我们这里的(只是绕了一圈被传回来),跳过。
  const selfId = cfg.selfUrl ? bootstrapId(cfg.selfUrl) : null

  // 合并一次拉取结果(整键替换:以对端视图为准,避免陈旧条目堆积)
  function mergeRemote(bootstrapUrl, remotePeers) {
    const id = bootstrapId(bootstrapUrl)
    const next = {}
    for (const p of remotePeers || []) {
      if (!p || !p.nodeId) continue
      // 回环防护 + origin 保留传递:远程节点自带 origin(它也是从别处联邦来的)
      // 时保留原 origin,让"节点真正来自哪"的信息在联邦里不丢失;
      // 若原 origin 恰是本 bootstrap,直接跳过(leave 后不会阴魂不散)。
      if (p.origin && selfId && p.origin === selfId) continue
      next[p.nodeId] = {
        ...p,
        origin: p.federated && p.origin ? p.origin : id,
        lastFetched: now(),
      }
    }
    store.update('fed_peers', (m) => {
      const out = m || {}
      if (Object.keys(next).length === 0) delete out[id]
      else out[id] = next
      return out
    })
    return Object.keys(next).length
  }

  // 全网视图 = 本地节点 + 各对端联邦节点(去重:同 nodeId 本地优先)
  function list() {
    const out = peers.list()
    const seen = new Set(out.map((p) => p.nodeId))
    const ttl = cfg.presenceTtlSec * 2000 // 上游 TTL + 拉取间隔余量
    for (const [id, m] of Object.entries(fedView())) {
      for (const p of Object.values(m || {})) {
        if (seen.has(p.nodeId)) continue
        if (now() - (p.lastFetched || 0) > ttl) continue // 拉取过期 = 掉线
        seen.add(p.nodeId)
        out.push({
          nodeId: p.nodeId,
          wallet: p.wallet,
          endpoint: p.endpoint,
          models: p.models || [],
          joinedAt: p.joinedAt,
          lastSeen: p.lastFetched,
          origin: id,
          federated: true,
        })
      }
    }
    return out.sort((a, b) => b.lastSeen - a.lastSeen)
  }

  // 单次拉取:GET {bootstrap}/peers。自签 devnet 证书 rejectUnauthorized:false。
  // 返回 null = 拉取失败(协议错/对端 down/超时),调用方据此报告状态。
  function fetchPeers(url) {
    return new Promise((resolve) => {
      const id = bootstrapId(url)
      let u
      try {
        u = new URL(id + '/peers')
      } catch {
        resolve(null)
        return
      }
      const mod = u.protocol === 'https:' ? https : http
      const req = mod.get(
        u,
        { rejectUnauthorized: false, timeout: 8000 },
        (res) => {
          let body = ''
          res.on('data', (c) => {
            body += c
          })
          res.on('end', () => {
            try {
              const j = JSON.parse(body)
              resolve(Array.isArray(j.peers) ? j.peers : [])
            } catch {
              resolve(null)
            }
          })
        }
      )
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', () => resolve(null))
    })
  }

  async function pullOnce() {
    const results = []
    for (const url of bootstraps()) {
      const remote = await fetchPeers(url)
      if (remote === null) {
        results.push({ bootstrap: bootstrapId(url), ok: false, error: 'unreachable' })
        continue
      }
      const n = mergeRemote(url, remote)
      results.push({ bootstrap: bootstrapId(url), ok: true, peers: n })
    }
    return results
  }

  function start() {
    const intervalMs = Math.max(10, Number(cfg.federationPullSec || 30)) * 1000
    pullOnce().catch(() => {}) // 启动即拉一次
    const t = setInterval(() => {
      pullOnce().catch(() => {})
    }, intervalMs)
    t.unref?.() // 不阻塞进程退出
    return t
  }

  return { list, bootstraps, setBootstraps, mergeRemote, pullOnce, start, bootstrapId }
}
