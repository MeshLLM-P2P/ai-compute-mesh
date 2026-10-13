// 结算核对:登录钱包 → 拉全部托管行 + 余额 + 平台费 + listing 计价,逐项打印。
import fs from 'node:fs'
import nacl from 'tweetnacl'
import { b64encode, b64decode, rawToUsdt } from '@mesh/shared/protocol'
import { api, login } from '../agent/src/http.js'

const BASE = 'https://127.0.0.1:4011'
const ca = fs.readFileSync(new URL('../tls/cert.pem', import.meta.url))

const raw = JSON.parse(fs.readFileSync(new URL('../../agent/wallet.json', import.meta.url)))
const secretKey = b64decode(raw.secretKeyB64)
const wallet = {
  address: raw.address,
  signMessage: (bytes) => nacl.sign.detached(new Uint8Array(bytes), secretKey),
}

const token = await login(BASE, wallet, ca)
console.log('== 登录成功,钱包 =', wallet.address)

// 1) 全部托管行
const { rows } = await api(BASE, '/escrows?consumer=' + wallet.address, { token, ca })
console.log('\n== 托管行 (consumer=' + wallet.address + ') ==')
for (const r of rows) {
  console.log(
    `listing=${r.listingId.slice(0, 12)}… state=${r.state} ` +
      `余额=${rawToUsdt(r.balanceRaw || 0)} USDT ` +
      `累计结算=${rawToUsdt(r.totalSettledRaw || 0)} USDT 调用${r.totalCalls || 0}次 ` +
      `退款=${rawToUsdt(r.totalRefundedRaw || 0)} 提现=${rawToUsdt(r.totalWithdrawnRaw || 0)}`
  )
  if (r.tx) {
    console.log(
      `   最近tx: kind=${r.tx.kind} amount=${rawToUsdt(r.tx.amountRaw || 0)} USDT txId=${r.tx.txId} at=${new Date(r.tx.at).toISOString()}`
    )
  }
  if (r.receipt) {
    const rc = r.receipt
    console.log(
      `   receipt: tokensIn=${rc.tokensIn} tokensOut=${rc.tokensOut} tokensCache=${rc.tokensCache || 0} ` +
        `sig=${(rc.signature || '').slice(0, 12)}…`
    )
  }
}

// 2) 余额
const bal = await api(BASE, '/me/balance', { token, ca })
console.log('\n== 余额 ==')
console.log(
  `可用=${rawToUsdt(bal.availableRaw)} USDT  冻结=${rawToUsdt(bal.frozenRaw)} USDT  总账=${rawToUsdt(bal.balanceRaw)} USDT`
)

// 3) 平台费
const fees = await api(BASE, '/platform/fees', { ca })
console.log('\n== 平台费 (累计) ==')
console.log(
  `维护=${rawToUsdt(fees.fees.maintenanceRaw)}  保障=${rawToUsdt(fees.fees.guaranteeRaw)}  ` +
    `推广=${rawToUsdt(fees.fees.promotionRaw)}  合计=${rawToUsdt(fees.fees.maintenanceRaw + fees.fees.guaranteeRaw + fees.fees.promotionRaw)} USDT`
)

// 4) 该 listing 计价配置
const listings = await api(BASE, '/listings', { ca })
const target = (listings.listings || []).find((l) => l.id.startsWith('39d0ccac'))
if (target) {
  console.log('\n== listing 39d0ccac 计价 ==')
  console.log(
    `model=${target.model.name}  provider=${target.provider.slice(0, 12)}…  ` +
      `in=${rawToUsdt(target.pricing.per1kInputRaw)}/1k  out=${rawToUsdt(target.pricing.per1kOutputRaw)}/1k  ` +
      `minFee=${rawToUsdt(target.pricing.minFeeRaw)} USDT`
  )
} else {
  console.log('\n== 未找到 listing 39d0ccac(可能已删除) ==')
}