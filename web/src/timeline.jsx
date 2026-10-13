// [P1 可观测] 调用时间线:服务端事件( begin-call / receipt / settle / dispute /
// resolve / cancel / refund / slash ) + 数据面 dc 统计(kx 握手帧数、帧数/字节数、
// 时长)。纯展示组件;数据由调用方传入(GET /escrows/conversation 的 response)。
import { ts, fmtUsd, fmtMs, fmtBytes, shortHash } from './util.js'

const KIND_META = {
  'begin-call': { label: '调用开始(资金锁定)', tone: 'accent' },
  receipt: { label: '回执到达(供应商签名)', tone: 'ok' },
  settle: { label: '结算完成(双签)', tone: 'ok' },
  'settle-window': { label: '结算完成(窗口单签)', tone: 'ok' },
  dispute: { label: '争议提交', tone: 'err' },
  resolve: { label: '争议解决', tone: 'warn' },
  cancel: { label: '调用取消', tone: 'warn' },
  refund: { label: '超时释放', tone: 'warn' },
  slash: { label: '供应商押金扣划', tone: 'err' },
}
const DOT = { accent: 'var(--accent)', ok: 'var(--ok)', err: 'var(--err)', warn: 'var(--warn)', muted: 'var(--muted)' }

function eventDetail(e) {
  if (e.tokensIn != null && e.tokensOut != null)
    return (
      ' · ' + e.tokensIn + ' 入 / ' + e.tokensOut + ' 出(缓存 ' + (e.tokensCache || 0) +
      ' · 端到端 ' + fmtMs(e.latencyMs) + ')'
    )
  if (e.amountRaw != null) {
    let s = ' · 金额 ' + fmtUsd(e.amountRaw)
    if (e.providerRaw != null && e.providerRaw !== e.amountRaw) s += ' · 供应方实收 ' + fmtUsd(e.providerRaw)
    if (e.refundRaw != null && e.refundRaw > 0) s += ' · 退回消费者 ' + fmtUsd(e.refundRaw)
    return s
  }
  if (e.reason) return ' · ' + String(e.reason).slice(0, 80)
  return ''
}

export default function CallTimeline({
  title = '调用时间线(服务器视角)',
  listingId,
  sessionId,
  events = [],
  dc = null,
  onClose,
}) {
  const sorted = [...events]
    .filter((e) => e)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
  const list = sorted.reverse().slice(0, 120)

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ gap: 8, marginBottom: 8, alignItems: 'center' }}>
        <b style={{ fontSize: 14 }}>{title}</b>
        <span className="muted mono" style={{ fontSize: 11 }}>
          {listingId
            ? 'Listing ' + shortHash(listingId, 12) + (sessionId ? ' · 会话 ' + shortHash(sessionId) : ' · 全部')
            : '全部会话'}
        </span>
        <span style={{ flex: 1 }} />
        {dc?.truncated && (
          <span className="badge" style={{ background: 'rgba(255, 166, 35, 0.15)', color: 'var(--warn)' }}>
            帧采样中
          </span>
        )}
        {onClose && (
          <button className="ghost" onClick={onClose}>
            收起
          </button>
        )}
      </div>
      {dc && (
        <div className="mono" style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.8, marginBottom: 8 }}>
          E2EE 握手: kx-a ×{dc.kxA || 0} / kx-b ×{dc.kxB || 0}
          {dc.firstTs ? ' · 首帧 ' + ts(dc.firstTs) : ''}
          <br />
          数据通道: 成员#1 发 {dc.frames[0] || 0} / 成员#2 发 {dc.frames[1] || 0} · 共 {fmtBytes(dc.bytes)} ·
          时长 {fmtMs(dc.durMs)}
        </div>
      )}
      <div className="mono" style={{ maxHeight: 280, overflow: 'auto', fontSize: 12, lineHeight: 1.8, padding: '8px 12px' }}>
        {list.length === 0 ? (
          <span className="muted">
            (服务器侧尚无事件:调用未锁定资金,或 kx 握手帧将在 dc 统计中呈现)
          </span>
        ) : (
          list.map((e, i) => {
            const m = KIND_META[e.event] || { label: e.event, tone: 'muted' }
            return (
              <div key={i} style={{ marginBottom: 6 }}>
                <span
                  style={{
                    display: 'inline-block',
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: DOT[m.tone] || 'var(--muted)',
                    marginRight: 6,
                    marginTop: 5,
                  }}
                />
                <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{ts(e.ts)}</span>
                <span style={{ marginLeft: 6, fontWeight: 600 }}>{m.label}</span>
                <span style={{ color: 'var(--muted)', marginLeft: 4 }}>{eventDetail(e)}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
