# mesh-escrow(Anchor 程序)

MeshLLM 的逐次结算托管账户状态机,与服务器侧模拟账本
(`server/src/escrow.js`)一一对应——模拟账本是本程序的行为参考实现,
v1 演示在 `MESH_SETTLE_MODE=sim` 下不依赖本程序即可完整运行。

## 状态机

```
EMPTY --fund--> FUNDED --beginCall--> IN_CALL --submitReceipt--> SETTLE_WINDOW
SETTLE_WINDOW --settleFast(双签) | settleWindow(provider, W=60s)--> SETTLED
IN_CALL --refund(consumer, T=300s)--> FUNDED
IN_CALL | SETTLE_WINDOW --dispute--> DISPUTED --resolve(双签)--> FUNDED | SETTLED
FUNDED --withdraw--> EMPTY
```

- 金额单位:整数 micro-USDT(1e-6 USDT),程序**永远**用指令携带的
  `Pricing` 与回执 token 数重算费用,不信任客户端金额。
- 回执/纠纷签名绑定:双方各自对
  `digest = sha256(canonical({listingId, sessionId, transcriptHash, tokensIn, tokensOut, ts}))`
  做 Ed25519 签名;链上用 Solana ed25519 verify 程序(CPI)核验签名,
  不做链上 SHA-256(该原语不在 BPF 上提供),因此 digest 作为参数传入。
- PDA:
  - escrow 状态账户:`["escrow", consumer, listingId]`
  - 托管 USDT 代币账户:escrow PDA 拥有的关联代币账户(owner = escrow PDA)
  - bond 账户:`["bond", provider, listingId]`

## 构建与部署(需要 Anchor 工具链)

本机(Windows)没有 Rust/Anchor 工具链,以下流程在 Linux/macOS/WSL 执行:

```bash
# 1. 安装 Anchor CLI 0.30 与 Rust toolchain(anchor avm / rustup)
avm install 0.30.0 && avm use 0.30.0

# 2. 在仓库根目录构建
anchor build

# 3. devnet 部署(需 devnet 钱包;USDT devnet mint 见 server/src/config.js)
anchor deploy --provider.cluster https://api.devnet.solana.com

# 4. 将得到的 program id 回填到:
#    - 本程序 src/lib.rs 的 declare_id!
#    - Anchor.toml [programs.devnet]
#    - server/src/config.js 的 MESH_PROGRAM_ID
```

## 切到 devnet 实结算

部署完成后,启动 server:

```bash
MESH_SETTLE_MODE=devnet npm run dev -w server
```

server 的 escrow 层会切换到通过 @solana/web3.js 与本程序交互
(v1 交付的是模拟账本 + 本程序源码;devnet 交互客户端为 M2 后续工作)。

## 已知限制(v1)

- `slash` 为 provider 同意的部分罚没;非共识罚没需 v2 仲裁程序。
- listing 注册仍在链下(目录服务);链上 listing 账户为 v2 工作。
- USDT mint 地址由部署者配置(devnet 需先铸造/领取 devnet USDT)。
