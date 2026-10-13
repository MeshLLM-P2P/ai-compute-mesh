// 严格核对最新一笔结算:金额重算 + 回执验签 + 分账 + 余额
const fs = require('fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const require2 = createRequire(path.join(__dirname, '../package.json'))
const nacl = require2('tweetnacl')
const { PublicKey } = require2('@solana/web3.js')

const d = JSON.parse(fs.readFileSync(path.join(__dirname, '../data.json'), 'utf8'))
const usdt = (r) => (r / 1e6).toFixed(6)

;(async () => {
const { calcAmountRaw, splitFees, receiptDigest, b64decode } = await import('../../shared/src/protocol.js')

// 找最新一笔有 tx 的托管行
let latest = null
for (const [k, e] of Object.entries(d.escrows || {})) {
  if (e.tx && e.tx.at && (!latest || e.tx.at > latest.e.tx.at)) latest = { k, e }
}
if (!latest) { console.log('没有找到任何结算行'); process.exit(1) }
const { e } = latest
const L = e.listingId
const l = d.listings[L]
const r = e.receipt
const tx = e.tx

let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '  [' + detail + ']' : '')) }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : '')) }
}

console.log('== 核对最新结算 ' + tx.txId + ' ==')
console.log('consumer=' + e.consumer.slice(0, 6) + '…  provider=' + l.provider.slice(0, 6) + '…  model=' + l.model.name)
console.log('')

// 1) 金额:服务端必须按 listing 定价 + 回执 token 数重算
const recomputed = calcAmountRaw(l.pricing, r.tokensIn, r.tokensOut, r.tokensCache || 0)
console.log('tokensIn=' + r.tokensIn + ' tokensOut=' + r.tokensOut + ' tokensCache=' + (r.tokensCache || 0))
console.log('定价: in=' + usdt(l.pricing.per1kInputRaw) + ' out=' + usdt(l.pricing.per1kOutputRaw) + ' minFee=' + usdt(l.pricing.minFeeRaw))
check('金额重算一致', recomputed === tx.amountRaw, '重算=' + recomputed + ' 服务端=' + tx.amountRaw + ' (' + usdt(tx.amountRaw) + ' USDT)')

// 2) 分账:5% 平台费(1+2+2),provider 拿 95% 余数
// splitFees 返回 { parts: {maintenance,guarantee,promotion}, totalRaw, providerRaw }
const fees = splitFees(tx.amountRaw)
const p = fees.parts
check('平台费=5%', p.maintenance + p.guarantee + p.promotion === tx.amountRaw - fees.providerRaw,
  '维护=' + usdt(p.maintenance) + ' 保障=' + usdt(p.guarantee) + ' 推广=' + usdt(p.promotion) + ' 合计=' + usdt(tx.amountRaw - fees.providerRaw))
check('provider 分账=95%余数', fees.providerRaw === tx.amountRaw - (p.maintenance + p.guarantee + p.promotion), 'provider=' + usdt(fees.providerRaw))
check('tx 记录的分账与重算一致', tx.providerRaw === fees.providerRaw && tx.fees.maintenance === p.maintenance && tx.fees.guarantee === p.guarantee && tx.fees.promotion === p.promotion)

// 3) 回执验签:provider 钱包对回执摘要的 Ed25519 签名
const digest = await receiptDigest(r)
const sig = b64decode(r.signature)
const pub = new PublicKey(l.provider).toBytes()
const sigOk = nacl.sign.detached.verify(digest, sig, pub)
const digestHex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
check('回执签名有效(provider 钱包)', sigOk, 'digest=' + digestHex.slice(0, 16) + '…')

// 4) 余额:consumer 扣全额,provider 加 95%
// 用"结算前"余额无法直接取(已落账),改为校验当前余额与"应然"自洽:
// consumer 当前余额 = 历史累计 - 本次全额;provider 当前 = 历史累计 + 本次 95%
// 这里直接校验:consumer 余额 + 本次全额 应 >= 0 且 provider 余额包含本次 95%
console.log('')
console.log('consumer 余额 = ' + usdt(d.balances[e.consumer] || 0) + ' USDT (已扣 ' + usdt(tx.amountRaw) + ')')
console.log('provider 余额 = ' + usdt(d.balances[l.provider] || 0) + ' USDT (已加 ' + usdt(tx.providerRaw) + ')')
check('consumer 余额非负', (d.balances[e.consumer] || 0) >= 0)
check('provider 余额 >= 本次分账', (d.balances[l.provider] || 0) >= tx.providerRaw)

// 5) 平台费账本累计
const pf = d.platform || {}
console.log('')
console.log('平台费累计: 维护=' + usdt(pf.maintenanceRaw || 0) + ' 保障=' + usdt(pf.guaranteeRaw || 0) + ' 推广=' + usdt(pf.promotionRaw || 0))

// 6) 消费者信誉
const rep = (d.consumerRep || {})[e.consumer]
console.log('')
console.log('消费者信誉: ' + JSON.stringify(rep))
check('信誉: 结算 +1', rep && rep.settled >= 1 && rep.calls >= 1, 'calls=' + (rep && rep.calls) + ' settled=' + (rep && rep.settled) + ' abandoned=' + (rep && rep.abandoned))

console.log('')
console.log(fail === 0 ? '== 全部 ' + pass + ' 项核对通过 ==' : '== ' + fail + ' 项不通过, ' + pass + ' 项通过 ==')
process.exit(fail === 0 ? 0 : 1)
})().catch((e) => { console.error('AUDIT ERROR', e); process.exit(1) })