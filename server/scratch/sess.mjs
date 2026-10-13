import fs from 'node:fs'
const D=JSON.parse(fs.readFileSync('data.json','utf8'))
const s=D.sessions||{}
const now=Date.now()
console.log('当前会话数:', Object.keys(s).length)
for(const [tok,w] of Object.entries(s)){
  const created=typeof w==='object'?w.created||w.ts||w.createdAt:null
  const ageMin=created?((now-created)/60000).toFixed(1):'未知'
  console.log('  wallet='+(w&&w.wallet?String(w.wallet).slice(0,12):String(w).slice(0,12))+' 已存在 '+ageMin+' 分钟 (TTL 30 分钟)')
}
