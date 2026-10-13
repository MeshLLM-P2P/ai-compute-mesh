// 查最近几个 listing 的调用历史(ground truth):有没有 receipt/settle 事件。
import fs from 'node:fs'
import { api } from '../agent/src/http.js'

const BASE = 'https://127.0.0.1:4011'
const ca = fs.readFileSync(new URL('../tls/cert.pem', import.meta.url))

const listings = await api(BASE, '/listings', { ca })
const recent = ['39d0ccac', '40c1cc19', '5630f133', '23edffab']
for (const prefix of recent) {
  const l = (listings.listings || []).find((x) => x.id.startsWith(prefix))
  if (!l) {
    console.log(`\n== ${prefix}… 未找到 listing ==`)
    continue
  }
  console.log(`\n== ${l.id.slice(0, 14)}… model=${l.model.name} provider=${l.provider.slice(0, 10)}… ==`)
  const { calls } = await api(BASE, '/listings/' + l.id + '/calls', { ca })
  if (!calls || calls.length === 0) {
    console.log('  (无调用记录)')
    continue
  }
  for (const c of calls.slice(-15)) {
    const t = new Date(c.ts).toISOString().slice(11, 19)
    const extra =
      c.event === 'receipt'
        ? ` in=${c.tokensIn} out=${c.tokensOut} cache=${c.tokensCache || 0} latency=${c.latencyMs}ms`
        : c.by
          ? ` by=${c.by}`
          : ''
    console.log(`  ${t} ${c.event}${extra} ${c.sessionId ? c.sessionId.slice(0, 8) : ''}`)
  }
}