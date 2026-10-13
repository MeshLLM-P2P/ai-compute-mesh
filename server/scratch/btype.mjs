import fs from 'node:fs'
const D=JSON.parse(fs.readFileSync('data.json','utf8'))
const rows=Object.values(D.listings||{}).filter(l=>l&&l.backend)
rows.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0))
console.log('最近 8 个 listing 的后端类型:')
for(const l of rows.slice(0,8)){
  const t=new Date(l.updatedAt||0).toLocaleString('zh-CN')
  console.log('  '+t+' | type='+l.backend.type+' | url='+(l.backend.url||'(空)')+' | relay='+!!l.backend.relay+' | model='+l.model.name)
}
const byType={}
for(const l of rows) byType[l.backend.type]=(byType[l.backend.type]||0)+1
console.log('\n类型分布:', JSON.stringify(byType))
