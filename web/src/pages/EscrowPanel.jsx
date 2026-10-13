import React, { useCallback, useEffect, useState } from 'react'
import { api, getConversation, downloadJson } from '../api.js'
import CallTimeline from '../timeline.jsx'
import { receiptDigest, b64encode } from '@mesh/shared/protocol'
import { fmtUsd, shortHash, ts } from '../util.js'

const STATE_LABEL = {
  EMPTY: '空(未充值)',
  FUNDED: '已充值',
  IN_CALL: '调用中',
  SETTLE_WINDOW: '结算窗口(60s)',
  DISPUTED: '争议中',
  SETTLED: '已结算',
}

export default function EscrowPanel({ wallet, pushLog }) {
  const [rows, setRows] = useState([])
  const [err, setErr] = useState(null)
  const [acting, setActing] = useState(null)
  const [fees, setFees] = useState(null)
  // [P3 消费者仪表盘] 消费明细/历史回执(后端 GET /me/calls 已就绪)
  const [myCalls, setMyCalls] = useState([])
  // [P1 可观测] 时间线面板数据
  const [tl, setTl] = useState(null)

  const load = useCallback(async () => {
    try {
      const r = await api('/escrows?consumer=' + wallet.address)
      setRows(r.rows || [])
      setErr(null)
    } catch (e) {
      setErr('无法加载结算账户: ' + e.message)
    }
    // 平台费用账本(每笔已结算交易 5%:维护 1% / 售后保障 2% / 推广 2%)
    api('/platform/fees')
      .then((r) => setFees(r.fees || null))
      .catch(() => {})
    // [P3 消费者仪表盘] 消费明细、token 成本、历史回执(按 listing 聚合)
    api('/me/calls')
      .then((r) => setMyCalls(r.rows || []))
      .catch(() => {})
  }, [wallet.address])

  useEffect(() => {
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [load])

  const run = async (key, fn) => {
    setActing(key)
    try {
      await fn()
      await load()
    } catch (e) {
      pushLog('操作失败: ' + e.message)
    } finally {
      setActing(null)
    }
  }

  const withdraw = (r) =>
    run('w' + r.listingId, async () => {
      await api('/escrow/withdraw', {
        method: 'POST',
        body: { consumer: wallet.address, listingId: r.listingId },
      })
      pushLog('已取回余额 ' + fmtUsd(r.balanceRaw))
    })

  const refund = (r) =>
    run('r' + r.listingId, async () => {
      await api('/escrow/refund', {
        method: 'POST',
        body: { consumer: wallet.address, listingId: r.listingId },
      })
      pushLog('超时退款完成,余额回到 FUNDED')
    })

  // 立即取消:调用还在 IN_CALL(未产生回执)时,consumer 可主动释放预留资金
  const cancel = (r) =>
    run('cx' + r.listingId, async () => {
      await api('/escrow/cancel', {
        method: 'POST',
        body: { consumer: wallet.address, listingId: r.listingId },
      })
      pushLog('已取消调用,预留资金回到 FUNDED')
    })

  const dispute = (r) =>
    run('d' + r.listingId, async () => {
      await api('/escrow/dispute', {
        method: 'POST',
        body: {
          actor: 'consumer',
          consumer: wallet.address,
          listingId: r.listingId,
          reason: 'consumer-side dispute (v1 demo)',
        },
      })
      pushLog('已提交争议,余额被冻结')
    })

  // Provider-role window settlement: allowed here only when this wallet is
  // also the provider of the listing (self-hosted demo).
  const settleWindow = (r) =>
    run('sw' + r.listingId, async () => {
      const digest = await receiptDigest(r.receipt)
      const attestSigB64 = b64encode(await wallet.signMessage(digest))
      await api('/escrow/settle-window', {
        method: 'POST',
        body: { provider: wallet.address, listingId: r.listingId, attestSigB64 },
      })
      pushLog('窗口结算完成(窗口已过 60s,Provider 单签)')
    })

  // Mediator resolution: both parties sign the receipt digest. In the
  // self-hosted demo (consumer === provider) the same signature satisfies both.
  const resolve = (r) =>
    run('rs' + r.listingId, async () => {
      const digest = await receiptDigest(r.receipt)
      const sigConsumerB64 = b64encode(await wallet.signMessage(digest))
      const sigProviderB64 = sigConsumerB64 // self-hosted demo
      await api('/escrow/resolve', {
        method: 'POST',
        body: {
          consumer: wallet.address,
          listingId: r.listingId,
          refundRaw: r.dispute.frozenRaw,
          sigConsumerB64,
          sigProviderB64,
        },
      })
      pushLog('争议已解决:全额退款')
    })

  // [P1 可观测] 单行会话时间线(服务器视角:目录事件 + 数据面 dc 统计)
  const loadTimeline = async (listingId, sessionId) => {
    setTl({ listingId, sessionId, loading: true, data: null })
    try {
      const r = await getConversation(wallet.address, listingId, sessionId || null)
      setTl({ listingId, sessionId, loading: false, data: r })
    } catch (e) {
      pushLog('时间线加载失败: ' + e.message)
      setTl({ listingId, sessionId, loading: false, data: { events: [] } })
    }
  }
  useEffect(() => {
    if (!tl || !tl.listingId || tl.loading) return
    const t = setInterval(() => loadTimeline(tl.listingId, tl.sessionId), 4000)
    return () => clearInterval(t)
  }, [tl, loadTimeline])

  // [P1 可观测] 全量导出当前钱包调用日志(JSON)
  const exportCallLog = async () => {
    try {
      const r = await api('/me/calls/export')
      downloadJson('meshllm-calls-' + shortHash(wallet.address, 6) + '.json', r)
      pushLog('调用日志已导出: ' + (r.conversations ? r.conversations.length : 0) + ' 个 listing')
    } catch (e) {
      pushLog('导出失败: ' + e.message)
    }
  }

  return (
    <div>
      <h1>结算账户(托管账本)</h1>
      <p className="muted">
        每个 (consumer, listing) 一行,状态机与 Anchor 程序 mesh-escrow 一一对应;金额全部为整数 micro-USDT,由服务端按定价重算。
      </p>
      {fees && (
        <p className="muted" style={{ marginTop: -8 }}>
          平台费用账本(每笔交易 5%):维护 {fmtUsd(fees.maintenanceRaw)} · 售后保障基金 {fmtUsd(fees.guaranteeRaw)} · 推广提成 {fmtUsd(fees.promotionRaw)}
        </p>
      )}
      {err && <p style={{ color: 'var(--err)' }}>{err}</p>}

      {/* [P3 消费者仪表盘] 消费明细 / token 成本 / 历史回执(后端 GET /me/calls 已就绪) */}
      {myCalls.length > 0 && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>消费仪表盘(我的调用)</h3>
          <table>
            <thead>
              <tr>
                <th>模型</th>
                <th>状态</th>
                <th>调用 / 结算 / 退款</th>
                <th>上次回执</th>
                <th>最近事件</th>
                <th>最后结算</th>
              </tr>
            </thead>
            <tbody>
              {myCalls.map((c) => (
                <tr key={c.listingId}>
                  <td className="mono">
                    {c.model || shortHash(c.listingId, 12)}
                  </td>
                  <td>
                    <span className={'badge ' + (c.state ? 'state' : 'offline')}>
                      {c.state || '—'}
                    </span>
                  </td>
                  <td className="mono">
                    调用 {c.totalCalls || 0} · 结算 {fmtUsd(c.totalSettledRaw || 0)} ·
                    退款 {fmtUsd(c.totalRefundedRaw || 0)}
                  </td>
                  <td className="mono">
                    {c.receipt
                      ? c.receipt.tokensIn + ' 入 / ' + (c.receipt.tokensCache || 0) + ' 缓存 / ' + c.receipt.tokensOut + ' 出'
                      : '—'}
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {(c.events || []).slice(0, 2)
                      .map((e) => e.event + ' ' + ts(e.ts))
                      .join(' · ') || '—'}
                  </td>
                  <td className="mono">
                    {c.lastTx
                      ? fmtUsd(c.lastTx.amountRaw) + ' (' + shortHash(c.lastTx.txId, 10) + ')'
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
            按 (consumer, listing) 聚合:总结算/退款来自托管行,事件为最近目录调用日志(每 listing 50 条)。
            完整原始记录(含每条事件/回执签名)见「导出调用日志」。
          </p>
        </div>
      )}

      <button className="ghost" style={{ marginBottom: 8 }}>
        导出调用日志
      </button>
      {rows.length === 0 && <div className="card muted">暂无托管记录。发起一次调用后这里会出现 FUNDED / IN_CALL 等状态。</div>}
      {rows.map((r) => (
        <div
          className={'card' + (r.archived ? ' muted' : '')}
          key={r.listingId + (r.archived ? ':archived:' + (r.tx?.txId || '') : ':live')}
        >
          <div className="row">
            <span className="mono">{shortHash(r.listingId, 12)}</span>
            <span className="badge state">{STATE_LABEL[r.state] || r.state}</span>
            {r.archived && <span className="badge">已归档(历史结算)</span>}
            {r.tx && (
              <span className="mono muted" style={{ fontSize: 11 }}>
                {r.tx.kind} · {r.tx.txId}
                {r.tx.providerRaw != null &&
                  ' · 总额 ' + fmtUsd(r.tx.amountRaw ?? r.tx.payRaw) + ' → Provider ' + fmtUsd(r.tx.providerRaw) + ' + 平台费 ' + fmtUsd((r.tx.amountRaw ?? r.tx.payRaw) - r.tx.providerRaw)}
              </span>
            )}
          </div>
          <div className="mono" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.8 }}>
            余额: {fmtUsd(r.balanceRaw)} · 累计结算: {fmtUsd(r.totalSettledRaw)} · 调用次数: {r.totalCalls}
            {r.dispute && (
              <>
                <br />
                争议: 由 {r.dispute.by} 发起,冻结 {fmtUsd(r.dispute.frozenRaw)} — 「{r.dispute.reason}」
              </>
            )}
            {r.receipt && (
              <>
                <br />
                回执: {r.receipt.tokensIn} 入 / {r.receipt.tokensCache || 0} 缓存 / {r.receipt.tokensOut} 出 · {ts(r.receipt.ts)}
              </>
            )}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            {r.listingId && (
              <button className="ghost" onClick={() => loadTimeline(r.listingId, r.call?.sessionId || r.receipt?.sessionId || null)}>
                时间线
              </button>
            )}
            {r.state === 'FUNDED' && r.balanceRaw > 0 && (
              <button onClick={() => withdraw(r)} disabled={acting === 'w' + r.listingId}>
                取回全部余额
              </button>
            )}
            {r.state === 'IN_CALL' && (
              <>
                <button onClick={() => cancel(r)} disabled={acting === 'cx' + r.listingId}>
                  取消调用(立即退还预留)
                </button>
                <button onClick={() => refund(r)} disabled={acting === 'r' + r.listingId}>
                  超时退款(需等 300s)
                </button>
                <button className="danger" onClick={() => dispute(r)} disabled={acting === 'd' + r.listingId}>
                  发起争议
                </button>
              </>
            )}
            {r.state === 'SETTLE_WINDOW' && (
              <>
                <button onClick={() => settleWindow(r)} disabled={acting === 'sw' + r.listingId}>
                  窗口结算(需已过 60s 且本钱包是 Provider)
                </button>
                <button className="ghost" onClick={() => cancel(r)} disabled={acting === 'cx' + r.listingId}>
                  释放预留(放弃待结算回执,需已过 60s)
                </button>
              </>
            )}
            {r.state === 'DISPUTED' && (
              <button onClick={() => resolve(r)} disabled={acting === 'rs' + r.listingId}>
                解决争议(全额退款,双签)
              </button>
            )}
          </div>
        </div>
      ))}
       {tl && (
         <CallTimeline
           title="托管行时间线(服务器视角)"
           listingId={tl.listingId}
           sessionId={tl.sessionId}
           events={tl.data?.events || []}
           dc={tl.data?.dc}
           onClose={() => setTl(null)}
         />
       )}
    </div>
  )
}
