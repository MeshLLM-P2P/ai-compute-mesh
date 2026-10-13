// 查 listing 的 limits / pricing / backend 完整配置
import fs from 'node:fs'
import { api } from '../agent/src/http.js'
const BASE = 'https://127.0.0.1:4011'
const ca = fs.readFileSync(new URL('../tls/cert.pem', import.meta.url))
const listings = await api(BASE, '/listings', { ca })
for (const l of listings.listings || []) {
  if (!l.id.startsWith('39d0ccac')) continue
  console.log('id      =', l.id)
  console.log('model   =', JSON.stringify(l.model))
  console.log('pricing =', JSON.stringify(l.pricing))
  console.log('limits  =', JSON.stringify(l.limits))
  console.log('metering=', JSON.stringify(l.metering))
  console.log('backend =', JSON.stringify(l.backend))
  console.log('provider=', l.provider)
}