import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export const CONFIG = {
  port: Number(process.env.MESH_PORT || 4011),
  // devnet 默认监听所有网卡(局域网节点如 192.168.2.174 需要接入);
  // 只信任回环时设 MESH_HOST=127.0.0.1
  host: process.env.MESH_HOST || '0.0.0.0',
  dataFile: process.env.MESH_DATA_FILE || path.join(root, 'data.json'),
  // devnet TLS:存在自签证书(server/tls/*,由 scripts/gen-cert.mjs 生成)时启用 HTTPS/WSS。
  // 浏览器经局域网 IP 打开页面需要安全上下文才能用 crypto.subtle(E2EE/签名依赖)。
  tlsKeyPath: process.env.MESH_TLS_KEY || path.join(root, 'tls/key.pem'),
  tlsCertPath: process.env.MESH_TLS_CERT || path.join(root, 'tls/cert.pem'),

  // Chain configuration (devnet-first). settleMode:
  //   'sim'    — escrow state machine runs on the server-side simulated ledger
  //              (identical transitions to the Anchor program)
  //   'devnet' — real USDT transfers + mesh-escrow program on devnet
  //              (requires the Anchor program deployed; see programs/mesh-escrow)
  rpcUrl: process.env.MESH_RPC_URL || 'https://api.devnet.solana.com',
  usdtMint: process.env.MESH_USDT_MINT || 'Es9vMFrzaCERmJfrF4H2FYD4KZYGLKfBD4NThwexDBft',
  usdcMint: process.env.MESH_USDC_MINT || 'EPjFWdd5AufqSShM2i3MNyJvV9Qe54qV4qEtM8yvMqeM',
  programId: process.env.MESH_PROGRAM_ID || 'MESH_E1_REPLACE_AFTER_ANCHOR_DEPLOY',
  settleMode: process.env.MESH_SETTLE_MODE || 'sim',

  settleWindowSec: Number(process.env.MESH_SETTLE_WINDOW_SEC || 60),
  // 多轮对话一次调用可持续数分钟:孤儿 IN_CALL 行的释放阈值放宽到 30 分钟
  // (consumer 端单轮 300s 超时仍即时生效,这里只影响服务端孤儿判定)
  callTimeoutSec: Number(process.env.MESH_CALL_TIMEOUT_SEC || 1800),
  // Browsers throttle hidden tabs: after 5 min in the background, a 5s
  // heartbeat timer fires at most once per minute. 120s keeps a provider
  // "online" through that throttling (the immediate visibilitychange beat
  // restores freshness as soon as the tab is visible again).
  presenceTtlSec: Number(process.env.MESH_PRESENCE_TTL_SEC || 120),
  defaultBondRaw: 100_000_000, // 100 USDT in micro-USDT
  // Test accounts (sim ledger): wallets that never had a balance get this credit
  // on first verified login. Only meaningful in settleMode 'sim'.
  testCreditRaw: Number(process.env.MESH_TEST_CREDIT_RAW || 100_000_000), // 100 USDT

  // ---- 推荐返利 (referral reward) -----------------------------------------
  // referralRate: 每笔结算按消费者实际付款额返给推荐人的百分比(整数),默认 5%。
  // referralCapRaw: 0 = 无上限。默认 0(不限额)。
  // platformCollectionWallet: 默认推荐人 = 平台收款钱包。用户首次登录未填分享码
  //   时,消费者默认绑定到该钱包作"推荐人"(平台从organic用户赚 5%)。
  referralRate: Number(process.env.MESH_REFERRAL_RATE || 5),
  referralCapRaw: Number(process.env.MESH_REFERRAL_CAP_RAW || 0),
  platformCollectionWallet:
    process.env.MESH_PLATFORM_COLLECTION_WALLET || '9BSx7r2Vo6XVXU5Ew4TFopZsKCEo9L3MszKRGwmZ7FPu',
}
