import nacl from 'tweetnacl'
import bs58 from 'bs58'

// Wallet abstraction: Phantom (if installed) or an in-browser demo wallet
// (Ed25519 keypair persisted in localStorage — byte-compatible with Solana).

export const DEMO_KEY = 'meshllm-demo-key-v1'

export async function connectWallet() {
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
