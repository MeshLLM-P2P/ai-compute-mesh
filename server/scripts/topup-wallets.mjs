// 一次性补值:把所有测试网钱包余额补到 100 USDT(只加不减)。
// 必须在 server 停止时运行(store 是内存+防抖落盘,运行中改文件会被覆盖)。
// 钱包集合 = balances 键 ∪ escrow consumer ∪ listing provider ∪ bond provider。
import fs from 'node:fs'

const FILE = new URL('../data.json', import.meta.url)
const TARGET = 100_000_000 // 100 USDT (micro-USDT)

const d = JSON.parse(fs.readFileSync(FILE, 'utf8'))
const wallets = new Set()

for (const w of Object.keys(d.balances || {})) wallets.add(w)
for (const e of Object.values(d.escrows || {})) if (e.consumer) wallets.add(e.consumer)
for (const l of Object.values(d.listings || {})) if (l.provider) wallets.add(l.provider)
for (const k of Object.keys(d)) {
  if (k.startsWith('bonds:')) {
    // bonds:<provider>:<listingId>
    const parts = k.split(':')
    if (parts.length >= 2) wallets.add(parts[1])
  }
}

const bal = d.balances || (d.balances = {})
let changed = 0
console.log('== 补值到 100 USDT(只加不减)==')
for (const w of [...wallets].sort()) {
  const cur = bal[w] || 0
  if (cur < TARGET) {
    const add = TARGET - cur
    bal[w] = TARGET
    changed++
    console.log(`  ${w.slice(0, 10)}…  ${(cur / 1e6).toFixed(6)} → 100.000000 USDT (+${(add / 1e6).toFixed(6)})`)
  } else {
    console.log(`  ${w.slice(0, 10)}…  ${(cur / 1e6).toFixed(6)} USDT(已 ≥100,不动)`)
  }
}
fs.writeFileSync(FILE, JSON.stringify(d, null, 2))
console.log(`\n完成:${wallets.size} 个钱包,补值 ${changed} 个,已写回 ${FILE}`)