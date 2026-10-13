// 生成 devnet 自签证书(server/tls/{key,cert}.pem)
// 用途:浏览器经局域网 IP(http://192.168.2.108:5173)打开页面时不是安全上下文,
// crypto.subtle(WebCrypto)不可用 → listing hash / E2EE / 回执签名全挂。
// 解决:web(server) 与 API+信令 都走 HTTPS/WSS(自签证书),恢复安全上下文。
// 重新生成:node scripts/gen-cert.mjs
import forge from 'node-forge'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))) // server/
const outDir = path.join(root, 'tls')
fs.mkdirSync(outDir, { recursive: true })

const keys = forge.pki.rsa.generateKeyPair(2048)
const cert = forge.pki.createCertificate()
cert.publicKey = keys.publicKey
cert.serialNumber = '01'
cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000)
cert.validity.notAfter = new Date(Date.now() + 825 * 24 * 3600 * 1000) // ~2.25 年

cert.setSubject([{ name: 'commonName', value: 'meshllm-devnet' }])
cert.setIssuer([{ name: 'commonName', value: 'meshllm-devnet' }])
cert.setExtensions([
  { name: 'basicConstraints', cA: false },
  {
    name: 'subjectAltName',
    altNames: [
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
      { type: 7, ip: '192.168.2.108' },
      { type: 7, ip: '192.168.2.174' },
      { type: 7, ip: '192.168.2.208' },
    ],
  },
])
cert.sign(keys.privateKey, forge.md.sha256.create())

fs.writeFileSync(path.join(outDir, 'key.pem'), forge.pki.privateKeyToPem(keys.privateKey))
fs.writeFileSync(path.join(outDir, 'cert.pem'), forge.pki.certificateToPem(cert))
console.log('[gen-cert] wrote ' + path.join(outDir, 'key.pem') + ' / cert.pem (valid ~2.25y)')
