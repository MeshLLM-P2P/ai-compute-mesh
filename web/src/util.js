export function fmtUsd(raw) {
  if (raw === undefined || raw === null) return '—'
  return (raw / 1e6).toFixed(4) + ' USDT'
}

export function shortHash(h, n = 8) {
  if (!h) return '—'
  return h.slice(0, n) + '…' + h.slice(-4)
}

export function ts(t) {
  if (!t) return '—'
  return new Date(t).toLocaleTimeString()
}

// [P1 可观测] 时间线/导出展示辅助
export function fmtMs(ms) {
  if (ms == null || ms < 0) return '—'
  if (ms < 1000) return Math.round(ms) + ' ms'
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' s'
  return Math.round(ms / 1000) + ' s'
}

export function fmtBytes(b) {
  if (b == null || b < 0) return '—'
  if (b < 1024) return b + ' B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
  return (b / (1024 * 1024)).toFixed(2) + ' MB'
}
