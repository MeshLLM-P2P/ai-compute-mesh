// Node 端钱包:加载/生成 JSON 钱包文件(格式与 web「导出钱包」一致)。
// 文件: { "address": "bs58...", "secretKeyB64": "<64字节 tweetnacl secretKey 的 b64>" }
// secretKeyB64 里的 64 字节 = 32 字节 seed + 32 字节公钥(tweetnacl keypair.secretKey)。
import fs from 'node:fs'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { b64encode, b64decode } from '@mesh/shared/protocol'

function makeWallet(address, secretKey) {
  return {
    address,
    secretKey, // Uint8Array(64)
    get publicKey() {
      return new Uint8Array(secretKey.subarray(32))
    },
    // 签原始字节,返回签名字节(与 web wallet.signMessage 同口径)
    signMessage: (bytes) => nacl.sign.detached(new Uint8Array(bytes), secretKey),
  }
}

export function loadWallet(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (typeof raw.address !== 'string' || typeof raw.secretKeyB64 !== 'string')
    throw new Error('钱包文件格式错误:需要 address 与 secretKeyB64 字段')
  const secretKey = b64decode(raw.secretKeyB64)
  if (secretKey.length !== 64) throw new Error('钱包文件错误:secretKey 必须是 64 字节')
  const expected = bs58.encode(secretKey.subarray(32))
  if (expected !== raw.address) throw new Error('钱包文件错误:address 与 secretKey 不匹配')
  return makeWallet(expected, secretKey)
}

export function generateWalletFile(file) {
  const kp = nacl.sign.keyPair()
  const address = bs58.encode(kp.publicKey)
  fs.writeFileSync(file, JSON.stringify({ address, secretKeyB64: b64encode(kp.secretKey) }, null, 2))
  try {
    fs.chmodSync(file, 0o600)
  } catch {}
  console.log('[agent] 已生成新钱包: ' + address + '(写入 ' + file + ')')
  return makeWallet(address, kp.secretKey)
}
