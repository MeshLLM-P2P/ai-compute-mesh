import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, getConversation, downloadJson, loginRemote, makeApi, xbootBase } from '../api.js'
import { startConsumerCall } from '../session.js'
import CallTimeline from '../timeline.jsx'
import { calcAmountRaw, splitFees } from '@mesh/shared/protocol'
import { fmtUsd, shortHash, ts } from '../util.js'

function priceText(p) {
  if (!p) return '—'
  return (
    fmtUsd(p.per1kInputRaw) + ' / 1k 输入 · ' + fmtUsd(p.per1kOutputRaw) + ' / 1k 输出' +
    ' · ' + fmtUsd(p.per1kCacheRaw ?? p.per1kInputRaw) + ' / 1k 缓存' +
    (p.minFeeRaw ? ' · 最低 ' + fmtUsd(p.minFeeRaw) : '')
  )
}

function fmtLatency(ms) {
  if (ms == null) return '—'
  if (ms < 1000) return Math.round(ms) + ' ms'
  return (ms / 1000).toFixed(1) + ' s'
}

// 按 listing 声明的上限估算"最坏情况"费用,保证托管永远够结算:
// 输出按 limits.maxTokens(provider 端强制 max_tokens 截断),输入按模型上下文
// 窗口,再留 20% 余量兜底后端轻微超限。旧逻辑只按 256+256 token 估算,
// 模型一旦生成上千 token(如 2224)就远超充值 → 结算 insufficient-balance。
function fundEstimate(listing) {
  const maxOut = (listing.limits && listing.limits.maxTokens) || 2000
  const maxIn = (listing.model && listing.model.context) || 4096
  return Math.ceil(calcAmountRaw(listing.pricing, maxIn, maxOut) * 1.2)
}

const SORTS = [
  { id: 'latency', label: '响应最快(默认)' },
  { id: 'tps', label: '生成最快' },
  { id: 'price', label: '价格最低' },
  { id: 'load', label: '在线人数最少' },
  { id: 'recent', label: '最近上线' },
]

// [P1 自愈] 自动重试预算:
// - 连接阶段(资金未锁 IN_CALL)失败:自动重试 MAX_CONNECT_RETRY 次
// - 中途(IN_CALL)失败且无已完成轮次:自动重连 MAX_MID_RETRY 次,
//   每次 cancel(IN_CALL→FUNDED)保持托管行与资金,新会话 beginCall 重新进入
// 新调用/手动重试拿全新预算;自动重连锁(opts.reconnect)继承剩余预算
const MAX_CONNECT_RETRY = 1
const MAX_MID_RETRY = 2

export default function Market({ wallet, pushLog }) {
  const [listings, setListings] = useState([])
  const [err, setErr] = useState(null)
  const [call, setCall] = useState(null) // { listing, session, state, chat, receipt, verified, acting }
  const [prompt, setPrompt] = useState('')
  const [balance, setBalance] = useState(null)
  const [sortKey, setSortKey] = useState('latency')
  const [openReviews, setOpenReviews] = useState(null) // listingId | null
  const [reviews, setReviews] = useState({}) // listingId -> [...]
  const [reviewText, setReviewText] = useState('')
  // [P1 可观测] 调用时间线面板数据
  const [tl, setTl] = useState(null)
  // [P3 目录搜索] 市场搜索框(后端 /listings 已支持 q 参数)
  const [searchQ, setSearchQ] = useState('')
  // [阶段1 节点发现] 全网在线节点(bootstrap 注册表视图)
  const [peers, setPeers] = useState([])
  // 连接阶段自动重试的定时器:关闭会话时必须清掉,否则挂起的 setTimeout
  // 会在 1.5s 后触发 startCall 把刚关闭的对话重新打开(22:08 用户反馈的
  // "点关闭还会自动打开"根因)
  const retryTimerRef = useRef(null)
  // [P1 自愈] 中途自动重连重试的剩余预算(仅 IN_CALL 无完成轮次失败时消耗)
  const retryBudgetRef = useRef(MAX_MID_RETRY)
  // 手动重试要重发的完整轮次队列(含进行中的最后一轮);自动重连锁继承它
  const replayQueueRef = useRef([])
  // [P1 自愈] Provider 掉线提示:目录只列在线(online=1),掉线的 listing 从网格
  // 消失 —— 与上一次轮询 diff 出消失项,事件日志提示;重新上线后清标记
  const prevOnlineRef = useRef(null) // { listingId: 模型名 }
  const offlineNoticedRef = useRef({}) // listingId -> true
  const activeListingRef = useRef(null) // 当前活跃会话的 listing id
  useEffect(() => {
    activeListingRef.current = call?.listing?.id || null
  }, [call?.listing?.id])

  const loadBalance = useCallback(async () => {
    try {
      setBalance(await api('/me/balance'))
    } catch {}
  }, [])

  // [阶段1 节点发现] 全网在线节点:任何 join 过 bootstrap 的节点都在这里
  const loadPeers = useCallback(async () => {
    try {
      const r = await api('/peers')
      setPeers(r.peers || [])
    } catch {}
  }, [])

  // [跨 bootstrap 调用] listing 对应的 API 客户端:
  // - 本地 listing(federated=false) → 本地 api()
  // - 联邦远程 listing → 连它的家 bootstrap(origin),登录换取远程 session
  //   token(缓存复用)。escrow/信令/数据通道全部必须在那一边:
  //   只有那边同时有 listing store、provider agent 的信令房间与账本。
  const clientFor = useCallback(
    async (l) => {
      if (!l || !l.federated || !l.origin) return api
      // 经本机 bootstrap 转发(xbootBase),浏览器无需信任远程自签证书
      const base = xbootBase(l.origin)
      const token = await loginRemote(base, wallet)
      return makeApi(base, token).api
    },
    [wallet]
  )

  const load = useCallback(async () => {
    try {
      const qs = ['online=1', 'stats=1']
      // [P3 目录搜索] 搜索框经 q 参数走服务端过滤(后端 /listings 已支持 q)
      if (searchQ.trim()) qs.push('q=' + encodeURIComponent(searchQ))
      const r = await api('/listings?' + qs.join('&'))
      const ls = r.listings || []
      setListings(ls)
      setErr(null)
      // [P1 自愈] Provider 掉线提示(presence TTL 已自动从目录摘除,这里补 UI 感知):
      // 上次在线、这次消失的 listing = 掉线;事件日志提示,活跃会话额外提示
      const nowMap = {}
      for (const l of ls) nowMap[l.id] = l.model?.name || l.id
      if (prevOnlineRef.current) {
        for (const id of Object.keys(prevOnlineRef.current)) {
          if (!(id in nowMap) && !offlineNoticedRef.current[id]) {
            offlineNoticedRef.current[id] = true
            pushLog('Provider 已掉线(自动从目录摘除): ' + (prevOnlineRef.current[id] || id.slice(0, 8)))
            if (activeListingRef.current === id)
              pushLog('当前会话的 Provider 已离线:数据通道断开时会自动重连重试(托管保留)')
          }
        }
        for (const id of Object.keys(offlineNoticedRef.current)) {
          if (id in nowMap) delete offlineNoticedRef.current[id]
        }
      }
      prevOnlineRef.current = nowMap
    } catch (e) {
      setErr('无法加载目录: ' + e.message)
    }
  }, [searchQ, pushLog])

  useEffect(() => {
    load()
    loadBalance()
    loadPeers()
    const t = setInterval(load, 5000)
    const tp = setInterval(loadPeers, 5000)
    return () => {
      clearInterval(t)
      clearInterval(tp)
    }
  }, [load, loadBalance, loadPeers])

  const sortList = (arr) => {
    const val = (l) => {
      if (sortKey === 'latency') return l.stats?.avgLatencyMs ?? Number.MAX_SAFE_INTEGER
      if (sortKey === 'tps') return -(l.stats?.avgTps ?? Number.MAX_SAFE_INTEGER)
      if (sortKey === 'price')
        return (l.pricing?.per1kInputRaw || 0) + (l.pricing?.per1kOutputRaw || 0)
      if (sortKey === 'load') return l.activeUsers ?? 0
      if (sortKey === 'recent') return -(l.updatedAt || 0)
      return 0
    }
    return [...arr].sort((a, b) => val(a) - val(b))
  }

  const loadReviews = async (l) => {
    try {
      const c = await clientFor(l)
      const r = await c('/listings/' + l.id + '/reviews')
      setReviews((m) => ({ ...m, [l.id]: r.reviews || [] }))
    } catch {}
  }
  const toggleReviews = (l) => {
    setOpenReviews((cur) => {
      const next = cur === l.id ? null : l.id
      if (next) loadReviews(l)
      return next
    })
  }
  const postReview = async (l) => {
    const text = reviewText.trim()
    if (!text) return
    try {
      const c = await clientFor(l)
      await c('/listings/' + l.id + '/reviews', { method: 'POST', body: { body: text } })
      setReviewText('')
      await loadReviews(l)
      pushLog('留言已提交')
    } catch (e) {
      pushLog('留言失败: ' + e.message)
    }
  }

  // 取消托管:IN_CALL 且未产生回执 → 预留资金立即释放回 FUNDED。
  // 跨 bootstrap 调用时落到远程 bootstrap 的账本上。
  const cancelEscrow = async (listing) => {
    try {
      const c = await clientFor(listing)
      const r = await c('/escrow/cancel', {
        method: 'POST',
        body: { consumer: wallet.address, listingId: listing.id },
      })
      pushLog(
        r.escrow?.state === 'EMPTY'
          ? '已取消托管,预留资金已全部释放回可用余额'
          : '已取消托管,预留资金已释放(状态回到 FUNDED)'
      )
    } catch (e) {
      if (e.message.startsWith('cancel-not-allowed-in-'))
        pushLog('托管未处于 IN_CALL,无需取消')
      else pushLog('取消托管失败: ' + e.message)
    }
  }

  const startCall = async (l, attempt = 0, opts = {}) => {
    setErr(null)
    // [P1 自愈] 新调用/手动重试拿全新重连预算;自动重连锁(opts.reconnect)继承剩余预算
    if (!opts.reconnect) retryBudgetRef.current = MAX_MID_RETRY
    replayQueueRef.current = opts.replayTurns ? [...opts.replayTurns] : []
    setCall({
      listing: opts.reconnect ? l : null,
      session: null,
      state: { status: opts.reconnect ? 'reconnecting' : 'preparing' },
      chat: '',
      receipt: null,
      verified: null,
      acting: false,
    })
    let beganCall = false
    let callFailed = false
    let readyResolve = null
    // 状态变化等待器:重放循环等 turn-done;任何状态变化(含 error/closed)都唤醒,防挂起
    let stateWaiter = null
    const tryWake = (st) => {
      if (stateWaiter) {
        const w = stateWaiter
        stateWaiter = null
        w(st)
      }
    }
    const waitTurnState = (timeoutMs) =>
      new Promise((res) => {
        const t = setTimeout(() => {
          stateWaiter = null
          res({ status: 'replay-timeout' })
        }, timeoutMs)
        stateWaiter = (st) => {
          clearTimeout(t)
          res(st)
        }
      })
    try {
      // [跨 bootstrap 调用] 联邦远程 listing(federated+origin=家 bootstrap):
      // escrow 查询/充值/锁定/结算、信令、数据通道全部连远程 bootstrap ——
      // 只有那边同时有 listing store、provider agent 信令房间与账本。
      // provider agent 零改动:offer 到达远程 lst 房间即接单。
      let apiFn = api
      let remoteBase = null
      let remoteToken = null
      if (l.federated && l.origin) {
        // 经本机 bootstrap 转发到远程:浏览器只连本机,免去信任对方自签证书
        remoteBase = xbootBase(l.origin)
        remoteToken = await loginRemote(remoteBase, wallet)
        apiFn = makeApi(remoteBase, remoteToken).api
        pushLog(
          '跨 bootstrap 调用:模型位于 ' +
            l.origin.replace(/^https?:\/\//, '') +
            '(经本机转发:托管/信令/数据通道全走对方 bootstrap)'
        )
        try {
          const rb = await apiFn('/me/balance')
          pushLog(
            '远程余额 ' +
              fmtUsd(rb.balanceRaw) +
              ' · 可用 ' +
              fmtUsd(rb.availableRaw) +
              '(测试账户首次登录自动充值 100 USDT)'
          )
        } catch {}
      }
      const detail = (await apiFn('/listings/' + l.id)).listing
      if (!detail) throw new Error('listing-not-found')
      // 远程 listing 的 federated/origin 必须带回 full:cancelEscrow/topUp/
      // dispute 全靠它决定客户端打本地还是远程
      const full = l.federated ? { ...detail, federated: true, origin: l.origin } : detail
      // 确保托管账户有余额:按 listing 上限估算最坏费用(输出 maxTokens + 输入
      // context,留 20% 余量),保证任意用量下结算都不会 insufficient-balance
      const need = fundEstimate(full)
      let esc = null
      try {
        esc = (await apiFn('/escrow?consumer=' + wallet.address + '&listingId=' + l.id)).escrow
      } catch {}
      if (!esc || esc.state === 'EMPTY' || esc.balanceRaw < need) {
        const amt = need
        await apiFn('/escrow/fund', {
          method: 'POST',
          body: { consumer: wallet.address, listingId: l.id, amountRaw: amt },
        })
        pushLog('托管充值 ' + fmtUsd(amt) + ' → ' + shortHash(l.id))
      }
      const readyP = new Promise((res) => {
        readyResolve = res
      })
      const session = await startConsumerCall({
        listing: full,
        wallet,
        // [跨 bootstrap] 远程 bootstrap:信令/数据通道/结算全走那边
        serverBase: remoteBase,
        sessionToken: remoteToken,
        log: (m) => pushLog('会话: ' + m),
        onState: (st) => {
          setCall((c) => ({ ...c, state: st, listing: c.listing || full }))
          if (st.status === 'ready') readyResolve()
          tryWake(st)
        },
        onTokens: (chunk, fullText) => {
          setCall((c) => ({ ...c, chat: fullText }))
        },
        onReceipt: async (receipt) => {
          setCall((c) => ({ ...c, receipt }))
          try {
            const verified = await session.verifyReceipt(receipt)
            setCall((c) => ({ ...c, verified }))
            pushLog('回执校验通过: ' + verified.tokensIn + ' 入 / ' + verified.tokensOut + ' 出')
          } catch (e) {
            setCall((c) => ({ ...c, verified: { error: e.message } }))
            pushLog('回执校验失败: ' + e.message)
          }
        },
        onClosed: () => {
          // 主动关闭:唤醒重放循环等待器,不留挂起
          tryWake({ status: 'closed' })
        },
        onError: (msg, snap) => {
          callFailed = true
          tryWake({ status: 'error', error: msg })
          pushLog('会话错误: ' + msg)
          // [P1 自愈] 会话快照(session.js fail 附带)决定重试策略:
          //  - 连接阶段(beganCall=false,资金未锁 IN_CALL):
          //    新调用 → 释放 FUNDED 预充再重试;重连锁 → 保持 FUNDED 不动托管
          //  - 中途失败且无已完成轮次:自动重连 —— cancel(IN_CALL→FUNDED)
          //    保留托管行与资金,新会话 beginCall 重新进入,重发进行中的提示词
          //  - 有已完成轮次:不自动重试(避免丢历史),保持托管等手动重放
          const turns = snap && Array.isArray(snap.turns) ? snap.turns : []
          const inFlightIdx = snap && snap.turnOpen ? turns.length - 1 : -1
          const completed = Math.max(0, inFlightIdx)
          const inFlightPrompt = inFlightIdx >= 0 ? turns[inFlightIdx].prompt : null
          const replayTotal = completed + (inFlightPrompt ? 1 : 0)
          if (!beganCall) {
            if (!opts.reconnect) {
              // 新调用连接阶段失败:托管仍 FUNDED(未 IN_CALL),释放后重试
              cancelEscrow(full)
            }
            if (attempt < MAX_CONNECT_RETRY) {
              pushLog('连接阶段失败,1.5 秒后自动重试…')
              retryTimerRef.current = setTimeout(() => {
                retryTimerRef.current = null
                startCall(
                  l,
                  attempt + 1,
                  opts.reconnect ? { reconnect: true, replayTurns: replayQueueRef.current } : {}
                )
              }, 1500)
            }
          } else if (completed === 0) {
            // 中途失败、零完成轮次:自动重连重试(escrow 全程保留)
            if (retryBudgetRef.current > 0) {
              retryBudgetRef.current -= 1
              const n = MAX_MID_RETRY - retryBudgetRef.current
              pushLog(
                '数据通道中断,自动重连重试(' +
                  n +
                  '/' +
                  MAX_MID_RETRY +
                  '):托管保留(IN_CALL→FUNDED),资金不退'
              )
              // 继承重放队列:若处于手动重放中途,继续发完整轮次列表
              const carry =
                replayQueueRef.current.length > 0 ? replayQueueRef.current : inFlightPrompt ? [inFlightPrompt] : []
              retryTimerRef.current = setTimeout(async () => {
                retryTimerRef.current = null
                // cancel 必须落在新会话 beginCall 之前(IN_CALL→FUNDED)
                await cancelEscrow(full)
                startCall(l, 0, { reconnect: true, replayTurns: carry })
              }, n === 1 ? 2000 : 5000)
            } else {
              cancelEscrow(full)
              pushLog('自动重连重试已用尽:托管保持 FUNDED(资金未退),可点「重试对话(重放)」或「取消并退还」')
            }
          } else {
            // 有已完成轮次:保持托管,等用户点卡片上「重试对话(重放)」
            cancelEscrow(full)
            pushLog(
              '数据通道中断(已完成 ' +
                completed +
                ' 轮):托管保留(IN_CALL→FUNDED),点下方「重试对话(重放)」继续'
            )
          }
          const replayable = beganCall && replayTotal >= 1
          setCall((c) => ({
            ...c,
            state: { status: 'error', error: msg, canReplay: replayable, replayCount: replayTotal },
            // 重放按钮数据源:旧会话全部轮次(含进行中的最后一轮,重发整条 prompt)
            replayTurns: replayable ? turns : null,
          }))
          readyResolve()
        },
      })
      if (!session) return
      setCall({
        listing: full,
        session,
        state: opts.reconnect ? { status: 'reconnecting' } : { status: 'connecting' },
        chat: '',
        receipt: null,
        verified: null,
        acting: false,
      })
      // 等 E2E 通道真正 ready 才锁资金:连接失败时托管停留在 FUNDED,
      // 重试不会撞上 begin-call-not-allowed-in-IN_CALL
      await readyP
      if (callFailed) return
      await apiFn('/escrow/begin-call', {
        method: 'POST',
        body: { consumer: wallet.address, listingId: full.id, sessionId: session.sessionId },
      })
      beganCall = true
      pushLog('已发起调用 ' + session.sessionId.slice(0, 8) + '(资金已锁定 IN_CALL)')
      // [P1 自愈] 重连重发进行中的提示词 / 手动重试重放已完成轮次:
      // 逐条串行发送并等该轮 turn-done;某轮失败由 onError 接管重试策略
      for (const p of replayQueueRef.current) {
        if (callFailed) break
        session.sendPrompt(p)
        const st = await waitTurnState(320000)
        if (st.status !== 'turn-done') break
      }
    } catch (e) {
      pushLog('发起失败: ' + e.message)
      if (e.message === 'insufficient-balance')
        pushLog('余额不足:测试账户首次登录自动充值 100 USDT,可用余额见页面上方')
      if (e.message === 'begin-call-not-allowed-in-IN_CALL')
        pushLog('上一次调用未完成,托管仍锁在 IN_CALL:点会话卡片里的「取消并退还」即可立即释放')
      if (e.message === 'begin-call-not-allowed-in-SETTLE_WINDOW')
        pushLog('上一笔调用有待结算回执且结算窗口(60s)未过:等窗口过期后重试,或到「结算账户」页点「释放预留」')
      setCall((c) => ({ ...c, state: { status: 'error', error: e.message } }))
    }
  }

  const sendPrompt = () => {
    if (!call?.session || ['streaming', 'ending'].includes(call.state.status)) return
    if (!prompt.trim()) {
      pushLog('提示词为空,请先在输入框输入内容再发送')
      return
    }
    pushLog('已发送提示词(' + prompt.trim().length + ' 字符),等待模型响应…')
    call.session.sendPrompt(prompt.trim())
    setPrompt('')
  }

  const endConversation = () => {
    if (!call?.session || call.state.status !== 'turn-done') return
    pushLog('结束对话,等待 Provider 发最终回执(含全部轮次)…')
    call.session.endConversation()
  }

  const topUp = async () => {
    if (!call?.listing) return
    setCall((c) => ({ ...c, acting: true }))
    try {
      const c = await clientFor(call.listing)
      const amt = fundEstimate(call.listing)
      await c('/escrow/fund', {
        method: 'POST',
        body: { consumer: wallet.address, listingId: call.listing.id, amountRaw: amt },
      })
      pushLog('追加托管 ' + fmtUsd(amt) + '(多轮对话累计可能超过初始充值)')
      loadBalance()
    } catch (e) {
      pushLog('追加托管失败: ' + e.message)
    } finally {
      setCall((c) => ({ ...c, acting: false }))
    }
  }

  const acceptAndSettle = async () => {
    if (!call?.session) return
    setCall((c) => ({ ...c, acting: true }))
    try {
      await call.session.settle()
      loadBalance()
    } catch (e) {
      pushLog('结算失败: ' + e.message)
      setCall((c) => ({ ...c, acting: false, state: { status: 'error', error: e.message } }))
    }
  }

  const dispute = async () => {
    if (!call?.session) return
    setCall((c) => ({ ...c, acting: true }))
    try {
      const c = await clientFor(call.listing)
      await c('/escrow/dispute', {
        method: 'POST',
        body: {
          actor: 'consumer',
          consumer: wallet.address,
          listingId: call.listing.id,
          reason: prompt.slice(0, 200),
        },
      })
      pushLog('已提交争议,冻结余额等待仲裁')
      setCall((c) => ({ ...c, state: { status: 'disputed' } }))
    } catch (e) {
      pushLog('争议失败: ' + e.message)
    } finally {
      setCall((c) => ({ ...c, acting: false }))
    }
  }

  const closeCall = () => {
    // 先取消挂起的自动重试,防止 1.5s 后 startCall 把刚关闭的对话重新打开
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
    try {
      call?.session && call.session.close()
    } catch {}
    // 未进入回执/结算阶段就关闭 → 若已锁 IN_CALL,一并取消托管释放资金
    // (streaming/turn-done/ending:提示词已发但回执未到,Provider 尚未提交任何计量数据)
    if (
      call?.listing &&
      call.state &&
      [
        'preparing',
        'reconnecting',
        'connecting',
        'ready',
        'streaming',
        'turn-done',
        'ending',
        'done',
        'error',
      ].includes(call.state.status)
    ) {
      cancelEscrow(call.listing)
    }
    setCall(null)
  }

  // [P1 可观测] 调用时间线(服务器视角:目录事件 + 数据面 dc 统计),
  // 打开时自动轮询刷新,会话进行中也能看到实时事件。
  // 跨 bootstrap 调用时时间线取远程 bootstrap 的服务器视图。
  const loadTimeline = async (listingId, sessionId) => {
    setTl({ listingId, sessionId, loading: true, data: null })
    try {
      const l = call?.listing
      const c = l && l.id === listingId ? await clientFor(l) : api
      const r = await getConversation(wallet.address, listingId, sessionId || null, c)
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

  const st = call?.state
  const turns = call?.session?.turns || []
  const canSend = st && ['ready', 'turn-done'].includes(st.status)
  const chatText =
    st?.status === 'streaming'
      ? '(等待 Provider 响应…)'
      : st?.status === 'ready'
        ? '(在下方输入提示词并发送;资金已锁定)'
        : st?.status === 'reconnecting'
          ? '(自动重连中…托管保留,资金未退)'
          : '(正在建立加密通道…)'

  return (
    <div>
      <h1>算力市场</h1>
      <p className="muted">
        在线 Provider 的签名 Listing(点击「调用」建立 P2P 加密会话)。仅显示在线(&lt; 30s 心跳)。
      </p>
      {/* [阶段1 节点发现] 全网在线节点:任何已加入 bootstrap 的节点,
          无论它发布在哪台服务器,都会出现在这里。0 节点也显示卡片,
          否则用户会以为功能不存在(而实际只是没有节点在线) */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="row" style={{ alignItems: 'center', gap: 8 }}>
          <b>网络节点</b>
          {peers.length > 0 ? (
            <span className="badge online">{peers.length} 个在线</span>
          ) : (
            <span className="badge offline">0 个在线</span>
          )}
          <span className="muted" style={{ fontSize: 11.5 }}>
            节点上线即宣告加入(无许可);120s 无心跳自动移出
          </span>
        </div>
        {peers.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            当前没有在线节点。任何已登录账户在 Provider 面板点「上线 agent」,
            该节点即自动加入网络并出现在这里。
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>节点</th>
                <th>模型</th>
                <th>endpoint</th>
              </tr>
            </thead>
            <tbody>
              {peers.map((p) => (
                <tr key={p.nodeId}>
                  <td className="mono">
                    {p.wallet.slice(0, 4)}…{p.wallet.slice(-4)}
                    <br />
                    <span style={{ fontSize: 11, opacity: 0.6 }}>{shortHash(p.nodeId, 12)}</span>
                    {p.federated && (
                      <>
                        <br />
                        <span className="badge state" style={{ fontSize: 10.5 }} title={'经 bootstrap 联邦同步,来自 ' + p.origin}>
                          via {p.origin?.replace(/^https?:\/\//, '')}
                        </span>
                      </>
                    )}
                  </td>
                  <td>
                    {p.models && p.models.length > 0
                      ? p.models.map((m, i) => <div key={i}>{m.name}</div>)
                      : <span className="muted">—</span>}
                  </td>
                  <td className="mono" style={{ fontSize: 11.5 }}>
                    {p.endpoint || <span className="muted">浏览器节点(不可直连)</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {balance && (
        <div className="pill mono" style={{ marginBottom: 10, display: 'inline-block' }}>
          账户余额 {fmtUsd(balance.balanceRaw)} · 可用 {fmtUsd(balance.availableRaw)} · 冻结{' '}
          {fmtUsd(balance.frozenRaw)}(测试账户首次登录自动充值 100 USDT)
        </div>
      )}
      {err && <p style={{ color: 'var(--err)' }}>{err}</p>}
      <div className="row" style={{ marginBottom: 10, alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="muted">搜索:</span>
        <input
          value={searchQ}
          onChange={(e) => setSearchQ(e.target.value)}
          placeholder="模型名 / 后端 URL / provider(如 qwen / 8001 / 6ijV)"
          style={{ minWidth: 200 }}
        />
        <button className="ghost" onClick={() => setSearchQ('')}>
          清除
        </button>
        <span className="muted">排序:</span>
        <select value={sortKey} onChange={(e) => setSortKey(e.target.value)}>
          {SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <button className="ghost" onClick={exportCallLog}>
          导出调用日志
        </button>
      </div>

      {call && (
        <div className="card">
          <div className="row">
            <b>{call.listing?.model?.name || '正在准备…'}</b>
            <span className={'badge state'}>
              {st?.status === 'streaming'
                ? '流式接收中'
                : st?.status === 'turn-done'
                  ? '一轮结束,可继续追问'
                  : st?.status === 'ending'
                    ? '正在收尾…'
                    : st?.status || ''}
            </span>
            {st?.status === 'error' && <span style={{ color: 'var(--err)' }}>{st.error}</span>}
            {st?.status === 'error' && call.listing && (
              <button className="ghost" onClick={() => cancelEscrow(call.listing)}>
                取消并退还
              </button>
            )}
            {st?.status === 'error' && st?.canReplay && call.listing && (
              <button
                className="ghost"
                onClick={() =>
                  startCall(call.listing, 0, {
                    replayTurns: (call.replayTurns || []).map((t) => t.prompt),
                  })
                }
              >
                重试对话(重放 {st.replayCount} 轮)
              </button>
            )}
            {st?.status === 'error' && st?.canReplay && (
              <span className="muted" style={{ fontSize: 12 }}>
                重放将整段历史重新计费;若累计费用超过当前托管,先点「追加托管」
              </span>
            )}
            <span style={{ flex: 1 }} />
            <button className="ghost" onClick={() => loadTimeline(call.listing.id, call.state?.sessionId || null)}>
              调用时间线
            </button>
            <button className="ghost" onClick={closeCall}>
              关闭会话
            </button>
          </div>
          <pre className="chat">
            {turns.length > 0
              ? turns.map((t, i) => (
                  <div key={i} style={{ marginBottom: 10 }}>
                    <div>
                      <span style={{ color: 'var(--accent)' }}>你:</span> {t.prompt}
                    </div>
                    <div>
                      <span style={{ color: 'var(--ok)' }}>模型:</span>{' '}
                      {t.reply ||
                        (st?.status === 'streaming' && i === turns.length - 1
                          ? '(等待 Provider 响应…)'
                          : '')}
                    </div>
                  </div>
                ))
              : chatText}
          </pre>
          {canSend && (
            <div className="row" style={{ marginTop: 10, flexWrap: 'wrap', gap: 8 }}>
              <input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={
                  turns.length === 0 ? '输入提示词,例如:用三句话介绍你自己' : '继续追问(将带上整段上下文)…'
                }
                onKeyDown={(e) => e.key === 'Enter' && sendPrompt()}
              />
              <button onClick={sendPrompt} disabled={!prompt.trim()}>
                {turns.length === 0 ? '发送' : '继续'}
              </button>
              {turns.length > 0 && (
                <button className="ghost" onClick={endConversation} disabled={st?.status !== 'turn-done'}>
                  结束对话并结算
                </button>
              )}
            </div>
          )}
          {st?.status === 'turn-done' && (
            <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              可继续追问(每轮按整段上下文计费);点「结束对话并结算」出最终回执并双签结算。
              预计累计费用较高时,先点下方「追加托管」。
            </p>
          )}
          {canSend && (
            <div className="row" style={{ marginTop: 8 }}>
              <button className="ghost" onClick={topUp} disabled={call?.acting}>
                追加托管
              </button>
              {call?.acting && <span className="muted">处理中…</span>}
            </div>
          )}
          {call.verified && !call.verified.error && call.receipt && (
            <div className="card" style={{ marginTop: 12, background: 'var(--panel2)' }}>
              <div className="mono" style={{ fontSize: 12, lineHeight: 1.8 }}>
                轮次: {call.verified.turns} · tokensIn: {call.verified.tokensIn} (本地 {call.verified.myTokensIn}) ·
                缓存命中: {call.verified.tokensCache} · tokensOut: {call.verified.tokensOut} (本地 {call.verified.myTokensOut})
                <br />
                应付(服务端按定价重算): <b>{fmtUsd(call.verified.amountRaw)}</b>
                <br />
                分账: Provider 实收 {fmtUsd(splitFees(call.verified.amountRaw).providerRaw)} · 平台费 5%
                (维护 1% / 售后保障 2% / 推广 2%)
                <br />
                transcriptHash: {call.receipt.transcriptHash.slice(0, 24)}…
                <br />
                回执签名: <span className="muted">已验证 ✓(Provider 钱包)</span>
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <button onClick={acceptAndSettle} disabled={call.acting}>
                  接受并结算(双签)
                </button>
                <button className="danger" onClick={dispute} disabled={call.acting}>
                  发起争议
                </button>
                {call.acting && <span className="muted">处理中…</span>}
              </div>
              {st?.status === 'settled' && st.escrow?.tx && (
                <p style={{ color: 'var(--ok)', marginTop: 8 }}>
                  已结算:总额 {fmtUsd(st.escrow.tx.amountRaw)} = Provider 实收 {fmtUsd(st.escrow.tx.providerRaw)}
                  + 平台费 {fmtUsd(st.escrow.tx.amountRaw - st.escrow.tx.providerRaw)}
                  (维护 {fmtUsd(st.escrow.tx.fees?.maintenance)} / 保障 {fmtUsd(st.escrow.tx.fees?.guarantee)} / 推广 {fmtUsd(st.escrow.tx.fees?.promotion)})
                </p>
              )}
            </div>
          )}
          {call.verified?.error && (
            <p style={{ color: 'var(--err)', marginTop: 10 }}>回执校验失败: {call.verified.error}</p>
          )}
          {tl && tl.listingId === call?.listing?.id && (
            <CallTimeline
              title="调用时间线(服务器视角)"
              listingId={tl.listingId}
              sessionId={tl.sessionId}
              events={tl.data?.events || []}
              dc={tl.data?.dc}
              onClose={() => setTl(null)}
            />
          )}
        </div>
      )}

      <div className="grid2">
        {sortList(listings).map((l) => (
          <div className="card" key={l.id}>
            <div className="row">
              <b>{l.model?.name}</b>
              <span className={'badge ' + (l.online ? 'online' : 'offline')}>
                {l.online ? '在线' : '离线'}
              </span>
              {l.status === 'superseded' && <span className="badge offline">已替代</span>}
              {l.federated && (
                <span
                  className="badge state"
                  style={{ fontSize: 10.5 }}
                  title={'经 bootstrap 联邦同步,来自 ' + l.origin + '(调用时托管/信令/数据通道全走对方 bootstrap)'}
                >
                  via {l.origin?.replace(/^https?:\/\//, '')}
                </span>
              )}
            </div>
            <p className="muted" style={{ margin: '6px 0' }}>
              {priceText(l.pricing)}
            </p>
            {l.stats && (
              <div className="mono" style={{ fontSize: 11.5, margin: '4px 0' }}>
                响应 {fmtLatency(l.stats.avgLatencyMs)} · 生成{' '}
                {l.stats.avgTps != null ? l.stats.avgTps + ' tok/s' : '—'} · 在线用户{' '}
                {l.activeUsers || 0}/{l.limits?.maxConcurrent || 1}
                {l.stats.samples > 0 ? ' (样本 ' + l.stats.samples + ')' : ' (暂无样本)'}
              </div>
            )}
            <div className="mono muted" style={{ fontSize: 11 }}>
              provider: {shortHash(l.provider, 6)} · id: {shortHash(l.id, 10)} · 更新 {ts(l.updatedAt)}
            </div>
            <button
              style={{ marginTop: 10 }}
              disabled={!l.online || !!call || l.status === 'superseded'}
              onClick={() => startCall(l)}
            >
              调用此服务
            </button>
            <button className="ghost" style={{ marginLeft: 8 }} onClick={() => toggleReviews(l)}>
              评论留言({(reviews[l.id] || []).length})
            </button>
            {openReviews === l.id && (
              <div style={{ marginTop: 10 }}>
                {(reviews[l.id] || []).length === 0 && (
                  <p className="muted" style={{ fontSize: 12 }}>
                    还没有留言
                  </p>
                )}
                {(reviews[l.id] || []).map((rv, i) => (
                  <div key={i} style={{ fontSize: 12.5, marginBottom: 6 }}>
                    <span className="mono muted">{shortHash(rv.wallet, 6)}</span>
                    <span className="muted" style={{ fontSize: 11 }}> {ts(rv.ts)}</span>
                    <br />
                    {rv.text}
                  </div>
                ))}
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <input
                    value={reviewText}
                    onChange={(e) => setReviewText(e.target.value)}
                    placeholder="写个留言(最多 500 字)"
                    maxLength={500}
                  />
                  <button onClick={() => postReview(l)} disabled={!reviewText.trim()}>
                    提交
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {listings.length === 0 && (
        <div className="card muted">
          当前没有在线 Provider。请先到「Provider 面板」发布一个 Listing 并保持该页签打开(心跳每 5 秒)。
        </div>
      )}
    </div>
  )
}
