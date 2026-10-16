// 节点发现(阶段 1:bootstrap 注册表)。
// 任何已登录的节点 POST /peers/join 即加入网络 —— 无审批、无许可门槛。
// 在线判定复用 directory 的 presenceTtlSec(默认 120s):节点定期心跳保活,
// 掉线后 TTL 衰减自动从网络视图消失。
// 这是走向"无许可 GPU 节点网络"的第一步:节点不再需要预先知道彼此 IP,
// 加入后经 GET /peers 即可发现全网在线节点。
export function createPeers(store, cfg) {
  const now = () => Date.now()
  const peers = () => store.get('peers', {}) || {}
  const isOnline = (p) => now() - (p.lastSeen || 0) < cfg.presenceTtlSec * 1000

  // nodeId 缺省时用钱包地址派生(一个钱包一个节点,够用于发现)
  const resolveNodeId = (wallet, nodeId) =>
    nodeId && typeof nodeId === 'string' && nodeId.length >= 6 ? nodeId.slice(0, 64) : 'node:' + wallet

  function join(wallet, { nodeId, endpoint, models } = {}) {
    const id = resolveNodeId(wallet, nodeId)
    store.update('peers', (m) => {
      if (m === null) m = {}
      const prev = m[id]
      m[id] = {
        nodeId: id,
        wallet,
        // endpoint:节点自报的可直连地址(ws://host:port)。浏览器 agent 无法
        // 直连(NAT 后),留空即可 —— 发现层只关心"这个节点存在且在线"。
        endpoint: typeof endpoint === 'string' && endpoint ? endpoint.slice(0, 200) : prev?.endpoint || null,
        // models:该节点当前上线的模型摘要[{ name, listingId?, per1kInputRaw?, per1kOutputRaw? }]
        models: Array.isArray(models) ? models.slice(0, 50).map((x) => ({
          name: typeof x?.name === 'string' ? x.name.slice(0, 120) : '?',
          listingId: typeof x?.listingId === 'string' ? x.listingId : null,
        })) : prev?.models || [],
        joinedAt: prev?.joinedAt || now(),
        lastSeen: now(),
      }
      return m
    })
    return { peer: peers()[id], peers: list() }
  }

  function heartbeat(wallet, nodeId) {
    const id = resolveNodeId(wallet, nodeId)
    const p = peers()[id]
    // 只允许节点本人续命;未注册先 join
    if (!p || p.wallet !== wallet) return false
    store.update('peers', (m) => {
      if (m && m[id]) m[id].lastSeen = now()
      return m
    })
    return true
  }

  function leave(wallet, nodeId) {
    const id = resolveNodeId(wallet, nodeId)
    const p = peers()[id]
    if (!p || p.wallet !== wallet) return false
    store.update('peers', (m) => {
      if (m) delete m[id]
      return m
    })
    return true
  }

  function list() {
    return Object.values(peers())
      .filter(isOnline)
      .map((p) => ({
        nodeId: p.nodeId,
        wallet: p.wallet,
        endpoint: p.endpoint,
        models: p.models || [],
        joinedAt: p.joinedAt,
        lastSeen: p.lastSeen,
      }))
      .sort((a, b) => b.lastSeen - a.lastSeen)
  }

  // 节点下线(listing agent 停)时同步清掉该节点的 peers 记录,
  // 避免 120s TTL 内市场仍显示"在线"。按 wallet 精确匹配,不动其他节点。
  function leaveByWallet(wallet) {
    let removed = 0
    store.update('peers', (m) => {
      if (m === null) return m
      for (const id of Object.keys(m)) {
        if (m[id] && m[id].wallet === wallet) {
          delete m[id]
          removed++
        }
      }
      return m
    })
    return removed
  }

  return { join, heartbeat, leave, leaveByWallet, list, resolveNodeId }
}
