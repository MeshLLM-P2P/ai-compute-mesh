// ICE 配置构造(GET /ice 的纯函数部分,便于单测)。
//
// 规则:
// - STUN 公开下发(不打洞就没法建连,不涉及凭据)
// - TURN 凭据只给已登录会话:中转带宽是真金白银,不能给匿名者白嫖
// - hasTurn 反映"本次调用方能否真的用上 TURN" —— web 端据此决定
//   跨网段是"直连优先"还是"直接中转"
export function splitUrls(s) {
  return String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

export function buildIceConfig(cfg, { authed = false } = {}) {
  const stun = splitUrls(cfg.stunUrls)
  const turn = splitUrls(cfg.turnUrls)
  const iceServers = []
  if (stun.length) iceServers.push({ urls: stun })
  const hasTurn = !!authed && turn.length > 0
  if (hasTurn) {
    iceServers.push({
      urls: turn,
      username: cfg.turnUsername || '',
      credential: cfg.turnCredential || '',
    })
  }
  return { iceServers, hasTurn, turnConfigured: turn.length > 0 }
}
