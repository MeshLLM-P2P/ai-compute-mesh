import crypto from 'node:crypto'
import nacl from 'tweetnacl'
import { PublicKey } from '@solana/web3.js'
import {
  receiptDigest,
  receiptPayloadForHash,
  calcAmountRaw,
  splitFees,
  b64decode,
} from '@mesh/shared/protocol'

export class EscrowError extends Error {
  constructor(code, status = 400) {
    super(code)
    this.code = code
    this.status = status
  }
}

// Server-side simulated escrow ledger.
// Implements the exact state machine of the Anchor program (programs/mesh-escrow):
//   EMPTY --fund--> FUNDED --beginCall--> IN_CALL --submitReceipt--> SETTLE_WINDOW
//   SETTLE_WINDOW --dualSigSettle / windowElapsed+providerSig--> SETTLED
//   IN_CALL --cancel (consumer, immediate) | callTimeout+consumerSig--> FUNDED
//   IN_CALL | SETTLE_WINDOW --dispute--> DISPUTED --resolve(dual sig)--> FUNDED
// All amounts in integer micro-USDT; amounts are ALWAYS recomputed server-side
// from the listing price and receipt token counts (never trusted from clients).
export function createEscrow(store, cfg, getListing, recordCall) {
  const now = () => Date.now()
  const keyOf = (consumer, listingId) => consumer + '|' + listingId
  const all = () => store.get('escrows', {}) || {}
  const updateEscrow = (fn) => store.update('escrows', (m) => fn(m || {}), {})

  function getEscrow(consumer, listingId) {
    return all()[keyOf(consumer, listingId)] || null
  }

  // Simulated wallet balances (micro-USDT). A wallet's spendable amount is
  // balance minus everything frozen in escrows (FUNDED / IN_CALL /
  // SETTLE_WINDOW / DISPUTED rows). New wallets are credited testCreditRaw on
  // first verified login (see index.js); in 'devnet' mode this map is unused.
  const FROZEN_STATES = new Set(['FUNDED', 'IN_CALL', 'SETTLE_WINDOW', 'DISPUTED'])
  const getBal = (w) => store.get('balances', {})[w] || 0
  function frozenRaw(consumer) {
    return Object.values(all())
      .filter((e) => e.consumer === consumer && FROZEN_STATES.has(e.state))
      .reduce((s, e) => s + (e.balanceRaw || 0), 0)
  }
  function credit(wallet, deltaRaw) {
    store.update('balances', (m) => {
      const o = m || {}
      o[wallet] = Math.max(0, (o[wallet] || 0) + deltaRaw)
      return o
    })
  }

  // SETTLED 是终态:同一 consumer+listing 要再发起调用,旧结算行必须先归档。
  // 归档行完整保留(面板可见结算记录,审计不丢);旧行结算后剩余余额结转进
  // 新行(那是 consumer 的钱,不能永久锁死在终态行里)。
  function archiveSettled(m, k, consumer, listingId, e) {
    if (!e || e.state !== 'SETTLED') return e
    const carried = e.balanceRaw || 0
    m[k + ':archived:' + (e.tx?.txId || e.lastEvent)] = { ...e, balanceRaw: 0, archived: true }
    m[k] = {
      consumer,
      listingId,
      state: carried > 0 ? 'FUNDED' : 'EMPTY',
      balanceRaw: carried,
      totalCalls: e.totalCalls || 0,
      totalSettledRaw: e.totalSettledRaw || 0,
      totalRefundedRaw: e.totalRefundedRaw || 0,
      totalWithdrawnRaw: e.totalWithdrawnRaw || 0,
      windowStartedAt: 0,
      call: null,
      receipt: null,
      dispute: null,
      lastEvent: now(),
    }
    return m[k]
  }

  // Platform fee ledger: cumulative micro-USDT collected per settled
  // transaction (1% maintenance + 2% guarantee fund + 2% promotion).
  function addPlatformFees(parts) {
    store.update('platform', (p) => ({
      maintenanceRaw: (p?.maintenanceRaw || 0) + (parts.maintenance || 0),
      guaranteeRaw: (p?.guaranteeRaw || 0) + (parts.guarantee || 0),
      promotionRaw: (p?.promotionRaw || 0) + (parts.promotion || 0),
    }))
  }

  // ---- referral rewards (推荐返利) ------------------------------------------
// 数据模型:
//   referrals[consumerWallet] = { referrer, refCode, refRate, refTs }
//     记录"该消费者由谁推荐而来(绑定时间/当时费率)"。分享码默认=本人钱包地址,
//     无需预注册——任何登录过的钱包都可被分享,绑定时即把 refCode 记为该消费者
//     的 referrer。
//   rewards[referrerWallet]   = { raw, earned, cap, rate }
//     累计已付返利(微-USDT,raw)、累计应得(earned,含超 cap 部分)、上限与费率
//     (绑定时的 cfg 快照,后续 cfg 改动不影响历史绑定)。
//
// 返利额 = floor(该笔 consumer 实际付款额 * refRate%)。累计 raw 达到 cap 后,
// 该消费者继续结算不再给推荐人发钱,但超额部分仍计入 earned(用于统计"该推荐人
// 拉来的消费者累计贡献")。
//
// 绑定在 /verify 首次登录时发生(?ref= 携带分享码且本人尚无 referrer)。
// 结算点:settleFast / settleWindow / resolve(仅 payRaw>0)。

  function isWallet(s) {
    if (!s || !String(s).trim()) return false
    try {
      new PublicKey(String(s).trim())
      return true
    } catch {
      return false
    }
  }

  function getReferral(consumer) {
    return store.get('referrals', {})[consumer] || null
  }

  // 绑定推荐关系(仅供本人尚无 referrer 的 /verify 首次登录调用,见 index.js)
  // 规则:
  //   - 有效 refCode(合法钱包地址、非本人、非平台) → 绑定到该分享码
  //   - 无 refCode / refCode 无效 / 空 → 默认绑定到「平台收款钱包」
  //   - 已有绑定 → 不覆盖(already-bound)
  // 校验顺序: 已有绑定 → 格式(空/无效) → 自推 → 成功。
  // 返回 { bound, referrer, refCode, rate, capRaw, defaultPlatform }
  function recordReferral(consumer, refCode, cfg) {
    if (getReferral(consumer)) return { bound: false, error: 'already-bound' }
    const rate = Number(cfg.referralRate || 0)
    const capRaw = Number(cfg.referralCapRaw || 0)
    // 平台收款钱包(默认推荐人);允许 env 覆盖
    const platformWallet = (cfg.platformCollectionWallet || cfg.referralDefaultReferrer || '')
    const defaultPlatform = !!platformWallet
    const refCodeClean = (refCode || '').trim()
    // 若给了有效且非本人、非平台的有效分享码 → 用它;否则 → 默认平台
    let ref = ''
    let isDefault = false
    const isCodeValid = isWallet(refCodeClean)
    if (isCodeValid && refCodeClean !== consumer && refCodeClean !== platformWallet) {
      ref = refCodeClean
      // 显式有效码: 非默认平台
    } else {
      // 无码 / 无效 / 自推 / 平台码 都 → 默认平台
      ref = platformWallet
      isDefault = defaultPlatform
    }
    if (!ref) {
      // 无有效码且无平台钱包配置 → 不绑定
      return { bound: false, error: 'no-ref-code', isDefault: isDefault }
    }
    store.update('referrals', (m) => {
      m = m || {}
      m[consumer] = {
        referrer: ref,
        refCode: ref,
        refRate: rate,
        refRateCapRaw: capRaw,
        refTs: now(),
        defaultPlatform: isDefault,
      }
      return m
    })
    return { bound: true, referrer: ref, refCode: ref, rate, capRaw, defaultPlatform: isDefault }
  }

  // 获取本人推荐信息(用于 GET /referral)
  function getReferralInfo(wallet) {
    const my = getReferral(wallet)
    const rate = Number(cfg.referralRate || 0)
    const capRaw = Number(cfg.referralCapRaw || 0)
    const reward = store.get('rewards', {})[wallet] || { raw: 0, earned: 0, cap: capRaw, rate: rate }
    return {
      wallet,
      // 分享码=本人钱包地址;任何 wallet 都可分享,无需预注册
      shareCode: wallet,
      ratePct: rate,
      capRaw,
      // 本人作为推荐人的累计(已被推荐进来的消费者贡献)
      earnedRaw: reward.raw,
      earned: reward.earned,
      // 本人"作为消费者"被谁推荐
      referrer: my ? my.referrer : null,
      refRate: my ? Number(my.refRate || rate) : null,
      boundAsConsumer: !!my,
      // 是否由平台默认绑定(未填分享码)
      defaultPlatform: my ? !!my.defaultPlatform : false,
    }
  }

  // 在结算时触发推荐返利。amountRaw = consumer 本笔实际付款额。
  // 返回统一形状 { referrer, amountRaw, rewardRaw, earnedRaw, capRaw }:
  //   referrer: 推荐人钱包地址(或 null 表示无/未绑定);
  //   rewardRaw: 本笔应得(未封顶)金额;
  //   earnedRaw: 本笔实际入账(受 cap 封顶后真正给到的钱);
  //   capRaw: 本绑定时的累计上限(0=不限额)。
  function payoutReferral(consumer, amountRaw, cfg) {
    const capRaw0 = Number(cfg.referralCapRaw ?? 0)
    const ref = getReferral(consumer)
    if (!ref || !ref.referrer)
      return { referrer: null, amountRaw, rewardRaw: 0, earnedRaw: 0, capRaw: capRaw0 }
    const rate = Number(ref.refRate ?? 0)
    // 无 rate(0) 或 无实际付款额: 直接短路, 不发
    if (rate <= 0 || amountRaw <= 0)
      return { referrer: ref.referrer, amountRaw, rewardRaw: 0, earnedRaw: 0, capRaw: capRaw0 }
    // capRaw: 用绑定时的快照(refRateCapRaw); 0 表示"不限额"
    const capRaw = Number(ref.refRateCapRaw ?? cfg.referralCapRaw ?? 0)
    // 累计已付给该推荐人 + 本笔新增, 按 cap 封顶
    const before = store.get('rewards', {})[ref.referrer] || { raw: 0, earned: 0, cap: capRaw, rate }
    const candidate = Math.floor((amountRaw * rate) / 100)
    const newRaw = before.raw + candidate
    // cap>0 才封顶; cap==0(或负) 表示不限额
    const cap = capRaw > 0 ? Math.min(newRaw, capRaw) : newRaw
    const extra = cap - before.raw
    const out = {
      referrer: ref.referrer,
      amountRaw,
      rewardRaw: candidate,
      earnedRaw: extra,
      capRaw,
    }
    if (candidate > 0) {
      store.update('rewards', (m) => {
        m = m || {}
        const r = m[ref.referrer] || { raw: 0, earned: 0, cap: capRaw, rate }
        r.raw = cap
        r.earned += candidate
        m[ref.referrer] = r
        return m
      })
    }
    // 返利入账(仅 sim 账本,微-USDT)。devnet 模式:此处应改为真实
    // 链上转账(escrow 已扣除 consumer 额,返利另取平台补贴额度),
    // 当前 sim 纯记入 balances。
    if (extra > 0) credit(ref.referrer, extra)
    // [P1 可观测] 记录到最近一笔对应 listing 的 call 日志,便于审计
    const escrows = store.get('escrows', {})
    let target = null
    for (const e of Object.values(escrows)) {
      if (e.consumer === consumer && e.tx && e.tx.txId) {
        target = e.listingId
        break
      }
    }
    if (target) {
      recordCall(target, {
        ts: now(),
        event: 'referral-reward',
        consumer,
        referrer: ref.referrer,
        amountRaw,
        rewardRaw: candidate,
      })
    }
    return out
  }

  // 查询推荐人视角累计(用于 UI 展示"本人推荐的累计返利")
  function getReferralLedger(wallet) {
    return {
      ...store.get('rewards', {})[wallet] || {
        raw: 0,
        earned: 0,
        cap: cfg.referralCapRaw || 0,
        rate: cfg.referralRate || 0,
      },
    }
  }

  // ---- consumer reputation (anti-freeloading, item 2) ---------------------
  // E2EE 下 server 无法验证"交付",只能观测 escrow 状态迁移,因此用状态事件
  // 近似消费者的"结算完成率",供 provider 拒单参考:
  //   call       beginCall(调用开始)
  //   settled    settleFast / settleWindow / resolve(有付款)完成
  //   abandoned  硬白嫖信号:30min 超时释放(server 清理 / refund)、
  //              或结算窗过后 cancel(收到回执却放弃结算)
  //   cancelled  IN_CALL 期间 cancel(回执未出)——语义模糊(可能是连接失败,
  //              也可能是"收到回复后取消"),只记录、不计入结算率
  // 结算率 = settled / (settled + abandoned)。数据模型按"事件"累加,
  // 将来按轮结算(第3项)上线后同一套计数自动变为按轮粒度,无需重构。
  function noteEvent(consumer, kind) {
    store.update('consumerRep', (m) => {
      const o = m || {}
      const r = o[consumer] || { calls: 0, settled: 0, abandoned: 0, cancelled: 0, lastTs: 0 }
      if (kind === 'call') r.calls += 1
      else if (kind === 'settled') r.settled += 1
      else if (kind === 'abandoned') r.abandoned += 1
      else if (kind === 'cancelled') r.cancelled += 1
      r.lastTs = now()
      o[consumer] = r
      return o
    })
  }

  function reputation() {
    return store.get('consumerRep', {})
  }

  // ---- provider reputation (anti-freeloading, P3) -------------------------
  // Provider 侧指标:结算完成率、争议败诉数、累计退款额。
  // 供市场展示与 provider 排序;与 consumerRep 对称(事件累加,按轮结算上线后
  // 自动变为按轮粒度)。
  function noteProviderEvent(provider, kind, amountRaw = 0) {
    store.update('providerRep', (m) => {
      const o = m || {}
      const r =
        o[provider] ||
        { calls: 0, settled: 0, disputes: 0, disputesLost: 0, refundedRaw: 0, lastTs: 0 }
      if (kind === 'call') r.calls += 1
      else if (kind === 'settled') r.settled += 1
      else if (kind === 'dispute') r.disputes += 1
      else if (kind === 'disputeLost') {
        r.disputesLost += 1
        r.refundedRaw += amountRaw || 0
      }
      r.lastTs = now()
      o[provider] = r
      return o
    })
  }

  function providerReputation() {
    return store.get('providerRep', {})
  }

  function ensureWallet(pubkey, wallet) {
    if (pubkey !== wallet) throw new EscrowError('forbidden', 403)
  }

  function rawPubkey(wallet) {
    try {
      return new PublicKey(wallet).toBytes()
    } catch {
      throw new EscrowError('bad-wallet', 400)
    }
  }

  function verifySig(digestBytes, sigB64, wallet) {
    let ok = false
    try {
      ok = nacl.sign.detached.verify(digestBytes, b64decode(sigB64), rawPubkey(wallet))
    } catch {
      ok = false
    }
    if (!ok) throw new EscrowError('bad-signature', 400)
  }

  function txId() {
    return 'sim-' + crypto.randomBytes(8).toString('hex')
  }

  // ---- operations -------------------------------------------------------

  function fund({ consumer, listingId, amountRaw, wallet }) {
    ensureWallet(wallet, consumer)
    const listing = getListing(listingId)
    if (!listing || listing.status !== 'active') throw new EscrowError('listing-not-active', 404)
    if (!Number.isInteger(amountRaw) || amountRaw <= 0) throw new EscrowError('bad-amount')
    const avail = getBal(consumer) - frozenRaw(consumer)
    if (amountRaw > avail) throw new EscrowError('insufficient-balance', 402)

    updateEscrow((m) => {
      const k = keyOf(consumer, listingId)
      let e = m[k]
      if (!e) {
        e = {
          consumer,
          listingId,
          state: 'EMPTY',
          balanceRaw: 0,
          totalCalls: 0,
          totalSettledRaw: 0,
          totalRefundedRaw: 0,
          totalWithdrawnRaw: 0,
          windowStartedAt: 0,
          call: null,
          receipt: null,
          dispute: null,
          lastEvent: 0,
        }
        m[k] = e
      } else {
        // SETTLED 终态行先归档,充值进新行
        e = archiveSettled(m, k, consumer, listingId, e)
      }
      if (e.state !== 'EMPTY' && e.state !== 'FUNDED' && e.state !== 'SETTLE_WINDOW')
        throw new EscrowError('fund-not-allowed-in-' + e.state)
      e.balanceRaw += amountRaw
      if (e.state === 'EMPTY') e.state = 'FUNDED'
      e.lastEvent = now()
      m[k] = e
      return m
    })
    return getEscrow(consumer, listingId)
  }

 function beginCall({ consumer, listingId, sessionId, wallet }) {
    ensureWallet(wallet, consumer)
    if (!sessionId) throw new EscrowError('session-required')
    // 仅用于 provider 信誉计数;listing 不存在(软删除)时跳过,不改变原行为
    const listing = getListing(listingId)
    updateEscrow((m) => {
      const k = keyOf(consumer, listingId)
      let e = m[k]
      if (!e) throw new EscrowError('no-escrow', 404)
      // SETTLED 是终态:结算完再发起新调用时,先归档旧行(结转剩余余额),
      // 否则同一 consumer+listing 会被永久锁死(曾出现 begin-call-not-allowed-in-SETTLED)
      e = archiveSettled(m, k, consumer, listingId, e)
      if (e.state === 'IN_CALL') {
        // 调用已超协议上限:原调用必然已死(消费端 callTimeoutSec 同步失效于
        // 页面崩溃/刷新),先释放再重入 —— 否则这行会被孤儿 IN_CALL 永久锁死
        if (!e.call || now() - e.call.ts > cfg.callTimeoutSec * 1000) {
          e.call = null
          e.state = 'FUNDED'
        } else {
          throw new EscrowError('begin-call-not-allowed-in-IN_CALL')
        }
      } else if (e.state === 'SETTLE_WINDOW') {
        // 结算窗口(60s)已过且未双签/单签结算:回执已失效(consumer 无法单独
        // 完成双签,provider 也未单签),释放回 FUNDED(保留余额)允许重新调用。
        // 窗口未过则拒绝,避免打断进行中的结算。
        if (now() - e.windowStartedAt > cfg.settleWindowSec * 1000) {
          e.receipt = null
          e.state = 'FUNDED'
        } else {
          throw new EscrowError('begin-call-not-allowed-in-SETTLE_WINDOW')
        }
      }
      if (e.state !== 'FUNDED') throw new EscrowError('begin-call-not-allowed-in-' + e.state)
      e.state = 'IN_CALL'
      e.call = { sessionId, ts: now() }
      e.lastEvent = now()
      m[k] = e
      return m
    })
    noteEvent(consumer, 'call')
    if (listing) noteProviderEvent(listing.provider, 'call')
    // [P1 可观测] 调用开始写入 listing 调用日志 —— 每次会话时间线的起点
    recordCall(listingId, { ts: now(), event: 'begin-call', consumer, sessionId })
    return getEscrow(consumer, listingId)
  }

  async function submitReceipt({ consumer, listingId, receipt, wallet }) {
    ensureWallet(wallet, consumer)
    const listing = getListing(listingId)
    if (!listing) throw new EscrowError('listing-not-found', 404)
    if (receipt.listingId !== listingId) throw new EscrowError('receipt-listing-mismatch')
    // provider signature over the canonical receipt digest
    const digest = await receiptDigest(receipt)
    verifySig(digest, receipt.signature, listing.provider)

    const eBefore = getEscrow(consumer, listingId)
    updateEscrow((m) => {
      const e = m[keyOf(consumer, listingId)]
      if (!e) throw new EscrowError('no-escrow', 404)
      if (e.state !== 'IN_CALL') throw new EscrowError('receipt-not-allowed-in-' + e.state)
      if (e.call?.sessionId !== receipt.sessionId) throw new EscrowError('session-mismatch')
      e.receipt = receipt
      e.state = 'SETTLE_WINDOW'
      e.windowStartedAt = now()
      e.lastEvent = now()
      return m
    })
    recordCall(listingId, {
      ts: now(),
      event: 'receipt',
      consumer,
      sessionId: receipt.sessionId,
      tokensIn: receipt.tokensIn,
      tokensOut: receipt.tokensOut,
      tokensCache: receipt.tokensCache || 0,
      // latency: beginCall -> receipt (whole round trip incl. E2E setup + generation)
      latencyMs: eBefore?.call?.ts ? now() - eBefore.call.ts : undefined,
    })
    return getEscrow(consumer, listingId)
  }

  // Both parties sign: consumer accepts the receipt; provider attests.
  // The amount is recomputed server-side and must fit the funded balance.
  async function settleFast({ consumer, listingId, acceptSigB64, attestSigB64, wallet }) {
    ensureWallet(wallet, consumer)
    const listing = getListing(listingId)
    if (!listing) throw new EscrowError('listing-not-found', 404)

    // receipt may still be null (never submitted) — fail cleanly, not 500
    const row0 = store.get('escrows', {})[keyOf(consumer, listingId)]
    if (!row0) throw new EscrowError('no-escrow', 404)
    if (!row0.receipt) throw new EscrowError('no-receipt-to-settle', 409)
    const digest = await receiptDigest(row0.receipt)
    verifySig(digest, acceptSigB64, consumer)
    verifySig(digest, attestSigB64, listing.provider)

    let e
    updateEscrow((m) => {
      e = m[keyOf(consumer, listingId)]
      if (!e) throw new EscrowError('no-escrow', 404)
      if (e.state !== 'SETTLE_WINDOW') throw new EscrowError('settle-not-allowed-in-' + e.state)
      // Cache-hit tokens bill at per1kCacheRaw (fallback: input price)
      const amountRaw = calcAmountRaw(
        listing.pricing,
        e.receipt.tokensIn,
        e.receipt.tokensOut,
        e.receipt.tokensCache || 0
      )
      if (amountRaw > e.balanceRaw) throw new EscrowError('insufficient-balance')
      // 5% platform split: 1% maintenance + 2% guarantee fund + 2% promotion;
      // provider keeps the 95% remainder
      const fees = splitFees(amountRaw)
      e.balanceRaw -= amountRaw
      e.totalSettledRaw += amountRaw
      e.totalCalls += 1
      e.state = 'SETTLED'
      e.lastEvent = now()
      e.tx = {
        kind: 'settle',
        txId: txId(),
        amountRaw,
        providerRaw: fees.providerRaw,
        fees: fees.parts,
        at: now(),
      }
      return m
    })
    // Sim ledger settlement: consumer pays the full amount; provider is
    // credited 95% (remainder after the 5% platform split); the split
    // accrues to the platform fee ledger.
    credit(consumer, -e.tx.amountRaw)
    credit(listing.provider, e.tx.providerRaw)
    addPlatformFees(e.tx.fees)
    payoutReferral(consumer, e.tx.amountRaw, cfg)
    recordCall(listingId, {
      ts: now(),
      event: 'settle',
      consumer,
      sessionId: e.receipt.sessionId,
      amountRaw: e.tx.amountRaw,
      providerRaw: e.tx.providerRaw,
      fees: e.tx.fees,
      txId: e.tx.txId,
    })
    noteEvent(consumer, 'settled')
    noteProviderEvent(listing.provider, 'settled')
    return getEscrow(consumer, listingId)
  }

  // After the settle window elapses the provider may settle alone.
  async function settleWindow({ provider, listingId, attestSigB64, wallet }) {
    ensureWallet(wallet, provider)
    const listing = getListing(listingId)
    if (!listing) throw new EscrowError('listing-not-found', 404)
    if (provider !== listing.provider) throw new EscrowError('not-provider', 403)

    // Rows are keyed consumer|listingId and the provider side only knows the
 // listingId, so scan for the single matching SETTLE_WINDOW row.
    const rows = Object.values(all()).filter((r) => r.listingId === listingId && r.state === 'SETTLE_WINDOW')
    if (rows.length !== 1) throw new EscrowError('ambiguous-escrow-row', 409)
    const row = rows[0]
    if (now() - row.windowStartedAt < cfg.settleWindowSec * 1000)
      throw new EscrowError('window-not-elapsed', 409)
    const digest = await receiptDigest(row.receipt)
    verifySig(digest, attestSigB64, provider)
    // Cache-hit tokens bill at per1kCacheRaw (fallback: input price)
    const amountRaw = calcAmountRaw(
      listing.pricing,
      row.receipt.tokensIn,
      row.receipt.tokensOut,
      row.receipt.tokensCache || 0
    )
    if (amountRaw > row.balanceRaw) throw new EscrowError('insufficient-balance')
    // 5% platform split (1% maintenance + 2% guarantee + 2% promotion);
    // provider keeps the 95% remainder
    const fees = splitFees(amountRaw)

    updateEscrow((m) => {
      const e2 = m[keyOf(row.consumer, listingId)]
      e2.balanceRaw -= amountRaw
      e2.totalSettledRaw += amountRaw
      e2.totalCalls += 1
      e2.state = 'SETTLED'
      e2.lastEvent = now()
      e2.tx = {
        kind: 'settle-window',
        txId: txId(),
        amountRaw,
        providerRaw: fees.providerRaw,
        fees: fees.parts,
        at: now(),
      }
      return m
    })
    credit(row.consumer, -amountRaw)
    credit(listing.provider, fees.providerRaw)
    addPlatformFees(fees.parts)
    payoutReferral(row.consumer, amountRaw, cfg)
    recordCall(listingId, {
      ts: now(),
      event: 'settle-window',
      consumer: row.consumer,
      sessionId: row.receipt.sessionId,
      amountRaw,
      providerRaw: fees.providerRaw,
      fees: fees.parts,
      txId: store.get('escrows', {})[keyOf(row.consumer, listingId)].tx.txId,
    })
    noteEvent(row.consumer, 'settled')
    noteProviderEvent(listing.provider, 'settled')
    return getEscrow(row.consumer, listingId)
  }

  // Consumer-initiated cancel: the call is IN_CALL and no receipt has arrived
  // (state has not reached SETTLE_WINDOW), so nothing is owed to the provider.
  // Releases the earmark back to FUNDED immediately — the 300s call timeout
  // is the passive path, this is the active one (e.g. the consumer's
  // connection failed or the user abandoned the call).
  // If the call never reached IN_CALL (e.g. the connect race failed while the
  // escrow was still FUNDED), cancel releases the whole amount to EMPTY so a
  // failed pre-connect attempt no longer orphans a manual withdraw.
  function cancel({ consumer, listingId, wallet }) {
    ensureWallet(wallet, consumer)
    const eBefore = store.get('escrows', {})[keyOf(consumer, listingId)]
    if (!eBefore) throw new EscrowError('no-escrow', 404)
    updateEscrow((m) => {
      const e = m[keyOf(consumer, listingId)]
      if (!e) throw new EscrowError('no-escrow', 404)
      if (e.state === 'IN_CALL') {
        e.state = 'FUNDED'
      } else if (e.state === 'SETTLE_WINDOW') {
        // 结算窗口已过:consumer 主动放弃待结算回执,释放回 FUNDED(保留余额)
        if (now() - e.windowStartedAt < cfg.settleWindowSec * 1000)
          throw new EscrowError('cancel-too-early-in-SETTLE_WINDOW', 409)
        e.receipt = null
        e.state = 'FUNDED'
      } else if (e.state === 'FUNDED') {
        e.state = 'EMPTY'
      } else {
        throw new EscrowError('cancel-not-allowed-in-' + e.state)
      }
      e.call = null
      e.lastEvent = now()
      return m
    })
    // [P1 可观测] 补 consumer/sessionId:旧条目兼容(允许 null)
    recordCall(listingId, { ts: now(), event: 'cancel', by: 'consumer', consumer, sessionId: eBefore?.call?.sessionId || null })
    // 信誉:IN_CALL 取消(回执未出)语义模糊,只记录;结算窗过后放弃回执
    // = 收到服务却不结算,是最硬的白嫖信号
    if (eBefore.state === 'IN_CALL') noteEvent(consumer, 'cancelled')
    else if (eBefore.state === 'SETTLE_WINDOW') noteEvent(consumer, 'abandoned')
    return getEscrow(consumer, listingId)
  }

  // Call timeout: the consumer may release the earmark back to FUNDED.
  function refund({ consumer, listingId, wallet }) {
    ensureWallet(wallet, consumer)
    const eBefore = getEscrow(consumer, listingId)
    updateEscrow((m) => {
      const e = m[keyOf(consumer, listingId)]
      if (!e) throw new EscrowError('no-escrow', 404)
      if (e.state !== 'IN_CALL') throw new EscrowError('refund-not-allowed-in-' + e.state)
      if (now() - e.call.ts < cfg.callTimeoutSec * 1000) throw new EscrowError('call-not-timed-out', 409)
      e.state = 'FUNDED'
      e.call = null
      e.lastEvent = now()
      return m
    })
    // [P1 可观测] 补 consumer 冗余确认 + sessionId
    recordCall(listingId, { ts: now(), event: 'refund', consumer, sessionId: eBefore?.call?.sessionId || null })
    // 调用超时后消费者主动释放:调用烂尾,计入白嫖信号
    noteEvent(consumer, 'abandoned')
    return getEscrow(consumer, listingId)
  }

  function dispute({ actor, consumer, listingId, reason, wallet }) {
    const listing = getListing(listingId)
    if (!listing) throw new EscrowError('listing-not-found', 404)
    if (actor === 'consumer') ensureWallet(wallet, consumer)
    else if (actor === 'provider') {
      ensureWallet(wallet, listing.provider)
    } else throw new EscrowError('bad-actor')

    const eBefore = getEscrow(consumer, listingId)

    updateEscrow((m) => {
      const e = m[keyOf(consumer, listingId)]
      if (!e) throw new EscrowError('no-escrow', 404)
      if (e.state !== 'IN_CALL' && e.state !== 'SETTLE_WINDOW')
        throw new EscrowError('dispute-not-allowed-in-' + e.state)
      e.state = 'DISPUTED'
      e.dispute = { by: actor, reason: (reason || '').slice(0, 500), ts: now(), frozenRaw: e.balanceRaw }
      e.lastEvent = now()
      return m
    })
    // [P1 可观测] 争议事件补 consumer + sessionId,供会话时间线归因
    recordCall(listingId, { ts: now(), event: 'dispute', by: actor, consumer, sessionId: eBefore?.call?.sessionId || null })
    // 消费者发起的争议 = 对 provider 的指控,计入 provider 争议数
    if (actor === 'consumer') noteProviderEvent(listing.provider, 'dispute')
    return getEscrow(consumer, listingId)
  }

  // Mediator (v1: the listing host) finalizes: refundRaw goes back to the
  // consumer balance, the rest pays the provider. Both parties must sign.
  async function resolve({ consumer, listingId, refundRaw, sigConsumerB64, sigProviderB64, wallet }) {
    const listing = getListing(listingId)
    if (!listing) throw new EscrowError('listing-not-found', 404)
    if (!Number.isInteger(refundRaw) || refundRaw < 0) throw new EscrowError('bad-refund')

    const row0 = store.get('escrows', {})[keyOf(consumer, listingId)]
    const digest = row0?.receipt ? await receiptDigest(row0.receipt) : undefined
    if (digest === undefined) throw new EscrowError('no-receipt-to-resolve', 404)
    verifySig(digest, sigConsumerB64, consumer)
    verifySig(digest, sigProviderB64, listing.provider)
    // 在 updateEscrow 之前捕获冻结额:更新会把 e.dispute 置 null,
    // 之后 row0.dispute 已不可用(同一对象引用被原地修改)
    const frozenRaw0 = row0?.dispute?.frozenRaw || 0

    // 5% platform split on the paid-out portion (1% maintenance + 2% guarantee
    // + 2% promotion); provider keeps the 95% remainder
    let resolvedTx
    updateEscrow((m) => {
      const e = m[keyOf(consumer, listingId)]
      if (!e || e.state !== 'DISPUTED') throw new EscrowError('resolve-not-allowed', 409)
      if (refundRaw > e.dispute.frozenRaw) throw new EscrowError('refund-exceeds-frozen')
      const payRaw = e.dispute.frozenRaw - refundRaw
      const fees = splitFees(payRaw)
      e.balanceRaw = refundRaw
      e.totalSettledRaw += payRaw
      e.totalCalls += 1
      e.state = refundRaw > 0 ? 'FUNDED' : 'SETTLED'
      e.dispute = null
      e.lastEvent = now()
      e.tx = {
        kind: 'resolve',
        txId: txId(),
        payRaw,
        providerRaw: fees.providerRaw,
        fees: fees.parts,
        refundRaw,
        at: now(),
      }
      resolvedTx = e.tx
      return m
    })
    const eAfter = getEscrow(consumer, listingId)
    credit(consumer, -refundRaw)
    if (resolvedTx.providerRaw > 0) credit(listing.provider, resolvedTx.providerRaw)
    addPlatformFees(resolvedTx.fees)
    recordCall(listingId, {
      ts: now(),
      event: 'resolve',
      consumer,
      payRaw: eAfter.tx.payRaw,
      providerRaw: eAfter.tx.providerRaw,
      fees: eAfter.tx.fees,
      refundRaw,
      // [P1 可观测] 争议解决归属会话
      sessionId: row0?.receipt?.sessionId || eAfter?.receipt?.sessionId || null,
    })
    // 争议解决:消费者实际付款(payRaw>0)才算完成结算;全额退款
    // 通常是 provider 责任,不计入消费者白嫖
    if (resolvedTx.payRaw > 0) {
      noteEvent(consumer, 'settled')
      noteProviderEvent(listing.provider, 'settled')
      // 仅消费者实际付款(payRaw)才触发推荐返利;全额退款是
      // provider 责任,消费者未付,不该给推荐人返利
      payoutReferral(consumer, resolvedTx.payRaw, cfg)
    } else {
      // 全额退款 = provider 责任:计 provider 败诉 + 自动 slash 押金
      // (罚没额 = 冻结额,封顶押金余额;罚没部分计入平台保障基金)
      // 注意:用 updateEscrow 前捕获的 frozenRaw0 — 原行重读 row0.dispute
      // 此时已被置 null(同一对象引用原地修改),会恒为 0 导致不 slash
      const frozen = frozenRaw0
      noteProviderEvent(listing.provider, 'disputeLost', frozen)
      if (frozen > 0 && bondOf(listing.provider, listingId) > 0)
        slash({ provider: listing.provider, listingId, amountRaw: frozen, by: 'auto' })
    }
    return getEscrow(consumer, listingId)
  }

  function withdraw({ consumer, listingId, wallet }) {
    ensureWallet(wallet, consumer)
    updateEscrow((m) => {
      const e = m[keyOf(consumer, listingId)]
      if (!e) throw new EscrowError('no-escrow', 404)
      if (e.state !== 'FUNDED') throw new EscrowError('withdraw-not-allowed-in-' + e.state)
      if (e.balanceRaw <= 0) throw new EscrowError('nothing-to-withdraw')
      e.totalWithdrawnRaw += e.balanceRaw
      e.balanceRaw = 0
      e.state = 'EMPTY'
      e.lastEvent = now()
      e.tx = { kind: 'withdraw', txId: txId(), amountRaw: e.totalWithdrawnRaw, at: now() }
      return m
    })
    // 注意:这里绝不能再 credit(consumer, 提现额)。
    // fund() 只把资金冻结进 escrow(增加 balanceRaw 冻结额)、并不扣减钱包余额,
    // 钱包可用额 = 钱包余额 - 冻结额。提现只是"解除冻结"(frozen 减少),
    // 若再 credit 一笔就等于凭空造钱:可用额会多增加一倍提现额。
    // (实测 4 笔提现均导致对应钱包余额虚高,消费方余额显示 >100 USDT 初始额度即由此而来)
    return getEscrow(consumer, listingId)
  }

  // ---- bonds ------------------------------------------------------------
  function postBond({ provider, listingId, amountRaw, wallet }) {
    ensureWallet(wallet, provider)
    const listing = getListing(listingId)
    if (!listing || listing.provider !== provider) throw new EscrowError('not-provider', 403)
    if (!Number.isInteger(amountRaw) || amountRaw <= 0) throw new EscrowError('bad-amount')
    const k = 'bonds:' + provider + ':' + listingId
    store.update(k, (v) => (v || 0) + amountRaw)
    return store.get(k, 0)
  }

  function bondOf(provider, listingId) {
    return store.get('bonds:' + provider + ':' + listingId, 0)
  }

  // Slash a bond (used by dispute resolution for provider fault).
  function slash({ provider, listingId, amountRaw, by }) {
    const listing = getListing(listingId)
    if (!listing || listing.provider !== provider) throw new EscrowError('not-provider', 403)
    const k = 'bonds:' + provider + ':' + listingId
    const before = store.get(k, 0)
    const after = Math.max(0, before - Math.min(amountRaw, before))
    store.set(k, after)
    recordCall(listingId, { ts: now(), event: 'slash', by, amountRaw: before - after })
    return after
  }

  return {
    get: getEscrow,
    fund,
    beginCall,
    submitReceipt,
    settleFast,
    settleWindow,
    cancel,
    refund,
    dispute,
    resolve,
    withdraw,
    postBond,
    bondOf,
    slash,
    reputation,
    providerReputation,
    noteEvent,
    // ---- 推荐返利(外部 API 入口)
    recordReferral,
    getReferral,
    getReferralInfo,
    payoutReferral,
    getReferralLedger,
  }
}

export { receiptPayloadForHash }
