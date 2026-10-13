import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { api, login } from '../../agent/src/http.js'
const here=path.dirname(fileURLToPath(import.meta.url))
const ca=fs.readFileSync(path.join(here,'..','tls','cert.pem'),'utf8')
const BASE='https://127.0.0.1:4011'
const KEY='sk-Zxyn3Hm9xSm1zEvgGfy1VoB44os9Bb3du285wFvT0lT4A0H4'
const wallet={address:'probe-wallet-1',signMessage:()=>new Uint8Array(64)}
// 用真实钱包登录(签名必须可验证),所以生成一个
import nacl from 'tweetnacl'; import bs58 from 'bs58'
const kp=nacl.sign.keyPair(); const addr=bs58.encode(kp.publicKey)
const w={address:addr,signMessage:(b)=>nacl.sign.detached(new Uint8Array(b),kp.secretKey)}
const token=await login(BASE,w,ca)
const url='http://192.168.2.202:8080/v1/models'
console.log('=== 走中继 /relay (浏览器实际路径) ===')
try{
  const j=await api(BASE,'/relay',{method:'POST',body:{url,method:'GET',headers:{Authorization:'Bearer '+KEY}},token,ca})
  const arr=Array.isArray(j.data)?j.data:[]
  console.log('中继探测 OK, 模型数:', arr.length)
  console.log(arr.slice(0,5).map(m=>m.id||m).join(', '))
}catch(e){ console.log('中继探测失败:', e.message) }
console.log('\n=== 不带 key 走中继(模拟 key 为空) ===')
try{
  const j=await api(BASE,'/relay',{method:'POST',body:{url,method:'GET',headers:{}},token,ca})
  console.log('意外成功:', JSON.stringify(j).slice(0,200))
}catch(e){ console.log('失败(预期):', e.message) }
