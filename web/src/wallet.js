import nacl from 'tweetnacl'
import bs58 from 'bs58'

// Wallet abstraction: Phantom (if installed) or an in-browser demo wallet
// (Ed25519 keypair persisted in localStorage — byte-compatible with Solana).

export const DEMO_KEY = 'meshllm-demo-key-v1'

// 是否有真实 Solana 钱包(Phantom)可用
export function hasRealWallet() {
  const p = window.solana?.Phantom?.solana
  return !!p
}

// 连接钱包。real=true 时强制要求真实钱包(Phantom),
// 无真实钱包则抛出 NEED_REAL_WALLET 错误,不再回退 demo 钱包。
export async function connectWallet({ real = false } = {}) {
  const phantom = window.solana?.Phantom?.solana
  if (phantom) {
    const resp = await phantom.connect()
    const pub = resp.publicKey // Uint8Array (32)
    return {
      name: 'Phantom',
      address: bs58.encode(new Uint8Array(pub)),
      async signMessage(bytes) {
        const sig = await phantom.signMessage(new Uint8Array(bytes))
        return new Uint8Array(sig)
      },
    }
  }
  if (real) {
    const e = new Error('NEED_REAL_WALLET')
    e.message = '实网需先连接真实钱包。请安装 Phantom 钱包并在浏览器中连接。'
    e.code = 'NEED_REAL_WALLET'
    throw e
  }
  // demo wallet
  let raw = null
  try {
    raw = localStorage.getItem(DEMO_KEY)
  } catch {}
  if (raw) {
    const seed = Uint8Array.from(JSON.parse(raw))
    const kp = nacl.sign.keyPair.fromSecretKey(seed)
    return {
      name: 'Demo 钱包',
      address: bs58.encode(kp.publicKey),
      async signMessage(bytes) {
        return nacl.sign.detached(new Uint8Array(bytes), seed)
      },
    }
  }
  const kp = nacl.sign.keyPair()
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify([...kp.secretKey]))
  } catch {}
  return {
    name: 'Demo 钱包',
    address: bs58.encode(kp.publicKey),
    async signMessage(bytes) {
      return nacl.sign.detached(new Uint8Array(bytes), kp.secretKey)
    },
  }
}

export function shortAddr(a) {
  return a ? a.slice(0, 4) + '…' + a.slice(-4) : '—'
}
