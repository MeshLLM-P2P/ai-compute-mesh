// 查 39d0ccac 的 activeUsers(空闲时应=0)
import fs from 'node:fs'
import { api } from '../agent/src/http.js'
const BASE = 'https://127.0.0.1:4011'
const ca = fs.readFileSync(new URL('../tls/cert.pem', import.meta.url))
const j = await api(BASE, '/listings?stats=1', { ca })
const l = (j.listings || []).find((x) => x.id.startsWith('39d0ccac'))
if (l) console.log('39d0ccac: activeUsers=' + l.activeUsers + ' online=' + l.online + ' stats=' + JSON.stringify(l.stats))
else console.log('39d0ccac 未找到')
// 顺带看 23edffab(GSQ)
const g = (j.listings || []).find((x) => x.id.startsWith('23edffab'))
if (g) console.log('23edffab: activeUsers=' + g.activeUsers + ' online=' + g.online)