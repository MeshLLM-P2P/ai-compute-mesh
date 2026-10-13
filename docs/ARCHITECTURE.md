# MeshLLM — AI 大模型算力共享平台 · 架构设计文档

> 版本:v0.1(设计评审稿)
> 定位:P2P 优先、以 Solana USDT 逐次结算的大模型集市。钱包即身份,提供方自定价,推理数据端到端加密。
> 项目名 `MeshLLM` 为暂用名,可改。

---

## 1. 需求与核心原则

| # | 需求 | 设计落点 |
|---|------|----------|
| R1 | 任何人可将自己的大模型以 API 形式接入平台供他人使用 | **Provider Agent**(提供方代理,§5) |
| R2 | API 提供方可为自己的 API 设置价格 | 定价随 Listing 元数据发布,握手时哈希锁定,链上锚定(§4/§6) |
| R3 | 使用 Solana USDT 结算 | `mesh-escrow` Anchor 程序,逐次微支付(§8) |
| R4 | 用户使用钱包地址登录 | Solana 钱包 pubkey 即账户 ID,登录 = 签名 nonce(§3) |
| R5 | 所有数据使用 P2P 网络,点对点加密 | 推理流量走 WebRTC DataChannel + 应用层 E2E(ECDH P-256 + AES-GCM;WebCrypto 暂不支持 X25519,故选 P-256,前向安全性质相同);目录/信令只可见元数据(§9/§7) |

**五条设计原则**

1. **P2P 优先**:推理内容(提示词、回答)只在消费者与提供方两个端点之间流动,全程加密。平台侧(目录、信令、中继)只能看到"谁和谁、在哪个模型、何时",看不到内容。
2. **钱包即身份**:Solana 钱包公钥 = 全局账户 ID。不需要邮箱/密码,登录即签名。
3. **链上结算**:每完成一次推理调用,USDT(SPL)从消费者托管账户释放给提供方;托管状态机保证双方都不能单方赖账(§8.4)。
4. **提供方隐私**:提供方的真实 API 地址与密钥只存在于其本地(Provider Agent 配置),平台与消费者永远只看到 P2P 端点。
5. **平台极薄**:中心化组件收敛为(可选)目录同步 + 无状态信令 + 链状态代理,全部可去中心化替换,不持有用户资金与数据。

---

## 2. 总体架构

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Solana 链 (L0)                                  │
│  USDT(SPL) mint ─ mesh-escrow 程序 ─ ListingAnchor ─ 信誉账户          │
│  (托管/结算/争议/保证金/价格锚)                                        │
└──────────────▲────────────────────────────────────────────────────────┘
               │ 结算交易(每次调用)
┌──────────────┴────────────────────────────────────────────────────────┐
│                        P2P 网络层 (L1)                                 │
│  WebRTC DataChannel(浏览器双方)· DTLS 1.3 · STUN/TURN                │
│  信令中继(无状态 WS,多实例)· DHT/轻量目录(元数据发现)               │
│  [v2: libp2p 无头节点,WebRTC 兼容传输]                                │
└──────────────▲────────────────────────────────────────────────────────┘
               │ 加密会话(ECDH P-256 → AES-256-GCM,每会话独立密钥)
┌──────────────┴────────────────────────────────────────────────────────┐
│                     应用协议 (L2)                                     │
│  Handshake → Prompt → TokenStream → Receipt → Settle(§6 时序)       │
└──────────────▲────────────────────────────────────────────────────────┘
               │
┌──────────────┴────────────────────────────────────────────────────────┐
│                     角色端 (L4)                                        │
│  消费者 WebApp(钱包登录/市场/调用/结算记录)                          │
│  Provider Agent(浏览器标签页 或 无头节点:转发本地/私有 API 或本地推理)│
└────────────────────────────────────────────────────────────────────────┘
```

**角色清单**

| 角色 | 运行形态 | 持有 |
|------|----------|------|
| 消费者 Consumer | Web 浏览器(Phantom 等钱包) | 钱包、escrow 余额、receipts |
| 提供方 Provider | Provider Agent(浏览器标签页 / v2 无头节点) | 钱包、模型后端(本地 API / 本地推理)、保证金 |
| 目录 Directory | v1 轻量 HTTP 服务(多实例);v2 纯 DHT | 仅 Listing 元数据哈希与摘要 |
| 信令 Signaling | 无状态 WebSocket 中继(多实例) | 无持久数据,只转发 SDP/ICE |
| 中继 Relay/TURN | 公共 STUN + 自建 TURN(按需) | 加密密文(对内容盲) |
| 链上程序 | `mesh-escrow`(Anchor) | 资金托管、价格锚、信誉、争议 |

---

## 3. 身份与登录

### 3.1 账户模型

- 账户 ID = Solana 钱包公钥(32 字节)。
- 无注册流程。第一次"登录"即产生身份;历史行为(调用、结算、评分)全部链上可查。
- 可选:链上 `displayName` 指令(低成本,可更新),用于市场展示。

### 3.2 登录流程

```
Consumer Browser                 Platform API (极薄)
     │  GET /nonce {wallet}            │
     │◀──────── nonce = H(domain, ts,  │
     │          wallet, chainHeight) ──│
     │  本地: wallet.signMessage(nonce)│   (Phantom 弹窗确认)
     │  POST /verify {wallet, sig}     │
     │◀──────── 短时效 session(Ed25519 签名的 JWT,~15min)│
```

- 平台只验证签名与 nonce 新鲜度,**不私钥落库**;session 仅用于调用目录/信令等只读接口。
- 一切资金操作永远链上完成,不经过平台签名。
- 钱包检测:`window.phantom?.solana` / `window.solana`(wallet-standard 兼容);无扩展时提供**本地开发钱包**(生成 Keypair,仅 devnet/本地),保证开发可跑。

### 3.3 P2P 密钥与钱包密钥的分离

钱包 Ed25519 私钥同时用作 E2E 身份密钥会扩大泄露面(私钥泄露 = 身份 + 资金)。方案:

- 从同一助记词按 HD 派生 P2P 身份密钥:路径 `m/44'/501'/0'/0'/1`(Solana SLIP-0010 风格扩展)。
- 链上 `ListingAnchor` 只记录**钱包公钥**(用于收款)与 **P2P 公钥**(用于会话认证)两个字段,二者在首次握手时绑定(提供方签名绑定证明)。
- 消费者端同理:收款/托管用钱包公钥,E2E 用派生公钥。

---

## 4. 模型上架(Listing)与定价

### 4.1 Listing 记录(元数据,公开)

```jsonc
{
  "listingId": "sha256(canonical(provider, p2pPublicKey, model, pricing, limits, metering, bond, backend, version))",
  "provider": "<钱包公钥>",
  "p2pPublicKey": "<P2P 身份公钥>",        // 会话认证用
  "model": {
    "name": "local-llama-8b",
    "family": "llama",
    "paramsB": 8,
    "contextLen": 8192,
    "capabilities": ["chat", "completion"],
    "modality": ["text"]
  },
  "pricing": {                             // 单位:USDT
    "per1kInput": 0.0005,
    "per1kOutput": 0.0015,
    "minFee": 0.00001
  },
  "limits": { "maxConcurrent": 4, "maxPromptTokens": 2048, "timeoutSec": 300 },
  "bondUsdt": 100,                         // 上架保证金(§8.6)
  "backend": { "type": "openai-compatible", "url": "https://…" }, // 参与 listing 身份:同模型不同后端 = 不同 listing
  "status": "active",                      // active | paused | banned
  "version": 7,
  "updatedAt": 1700000000,
  "listingHash": "sha256(canonical(以上字段))"
}
```

- **`listingHash` 是定价的法律锚**:消费者会话开始时双方提交该 hash,结算按锁定的 price 执行。提供方事后改价不影响已锁定会话。
- 定价单位固定 USDT(6 位小数),支持"每 1k token"与最低费用;预留按次/按时计费字段(v2)。
- **backend 参与 listing 身份**:同一账户可在多个后端发布多个模型(同模型不同后端 = 不同 listing,并存);同模型同后端改价 = 新版本(替代旧版)。

### 4.2 发布与发现

- **发布**:Provider Agent 组装 Listing → 钱包签名 → (a) 写入 DHT 记录 / 推送目录服务;(b) 提交 `registerListing` 链上指令,把 `listingHash` 锚到 `ListingAnchor` 账户(价格版本化)。
- **发现**:
  - v1:目录服务同步 Listing 摘要(多实例,任一可替换);消费者浏览器缓存 + 定时/订阅刷新。
  - v2:纯 P2P —— libp2p Kademlia DHT 存记录,gossip 订阅新 Listing;浏览器端经目录节点代理查询(浏览器不能直接跑 DHT)。
- **检索维度**:model family、能力、价格区间、信誉分、在线状态(心跳)。
- **在线状态**:Provider Agent 周期心跳写入 DHT 记录;消费者连接失败 → 本地标记离线并降权。

### 4.3 改价 / 下架

- 改价 = 新 version 的 Listing,重新签名 + 重新锚链;旧版会话继续按旧价结算。
- 下架:status=banned 需争议裁决或保证金被 slash 后自动;paused 提供方自助。

---

## 5. Provider Agent(提供方代理)

Provider Agent 是平台对"接入"的核心抽象:**它才是 P2P 端点,而不是提供方的真实 API**。

### 5.1 形态

| 形态 | 运行环境 | 适用 | 限制 |
|------|----------|------|------|
| A. 浏览器标签页 | 消费者同款 WebApp 的"提供方面板" | 本地模型(localhost:11434 Ollama、WebGPU/ONNX-Web 小模型)、远程 https API(需其 CORS) | 浏览器不能稳定长期在线;并发受限于标签页 |
| B. 无头节点(v2) | Node.js 进程,WebRTC 兼容传输(如 libdatachannel)+ 同款信令 | 高并发、远程 http API(无 CORS 问题) | 需部署 |

> v1 双方均为浏览器 WebRTC(互通性最强,零安装)。浏览器 https 页面 fetch `http://localhost` 属安全上下文,Chrome/Firefox 均放行,故形态 A 接本地推理可行。

### 5.2 职责

1. **上架**:发布/更新 Listing,缴纳/释放保证金。
2. **在线**:维持心跳;管理 P2P 会话(并发上限、排队)。
3. **推理转发**(后端配置只存本机):
   - `backend.type = "openai-compatible"`:`{ baseUrl, apiKey, modelMap }` —— Agent 收到消费者的加密 prompt,解密后调用自己的 API(OpenAI Chat Completions 协议),把 SSE 流转发为加密 TokenStream。
   - `backend.type = "local-webgpu"`(v1.x):浏览器内 ONNX Runtime / WebGPU 推理,适合 ≤7B 量化模型。
   - `backend.type = "noop-echo"`:开发用,回显验证全链路。
4. **计量**:累计 tokensIn/tokensOut(按 tokenizer 计数;无 tokenizer 时按字符估算并在 Listing 声明计量方式),维护 `transcriptHash`(§7.4)。
5. **签 Receipt**:会话结束用钱包私钥签计量收据(§6.8)。
6. **收款**:结算指令的发起方之一;USDT 落入其钱包 ATA。

### 5.3 提供方侧数据

- 后端配置(`baseUrl/apiKey`):仅存 Provider Agent 本地(IndexedDB,可选加密),**任何协议消息、目录、链上记录均不含**。
- 会话日志:本地留存 receipts,供对账与争议举证。

---

## 6. 消费者调用全流程(端到端时序)

```
Consumer(浏览器)            Signaling/目录           Provider Agent             Solana 链
     │                          │                          │                       │
 1. │─ 浏览 Listing(DHT/目录)──▶│                          │                       │
     │                          │                          │                       │
 2. │─ fund: USDT → 自己的 Escrow PDA ──────────────────────────────────────────────▶│
     │                          │                          │                       │
 3. │─ 发起连接: 向信令登记 sessionId,交换 SDP/ICE ──▶ 转发 ──▶│                     │
     │◀══════════════ WebRTC DataChannel (DTLS 1.3) ═══════════▶│                    │
 4. │◀══ ECDH(P-256) 交换 → HKDF → AES-256-GCM 会话密钥(双向,每方向独立) ══▶│        │
     │   互验 Ed25519:对方 P2P 公钥 == Listing 中绑定的公钥(防 MITM)            │
 5. │══ Handshake: { sessionId, listingHash, version, 双方nonce } ══▶│               │
     │   双方确认锁定 price = pricing(listingHash)                             │
 6. │══ Prompt(加密,含 params)══▶│  解密 → 调本地/私有 API                       │
     │◀══ TokenStream(加密,逐 chunk,含 finishReason)══                        │
 7. │══ 完成: 本地计算 transcriptHash', tokensIn', tokensOut'                  │
     │◀══ Receipt R = Sig_prov( sessionId, tokensIn, tokensOut,                  │
     │                 transcriptHash, listingHash, ts ) ══                     │
 8. │   校验: tokens 偏差 ≤5% 且 transcriptHash' == transcriptHash ?           │
     │   ── 通过: 签 Accept = Sig_cons( R )                                   │
     │   ── 不通过: 签 Dispute(reason),进入 §8.4 争议分支                       │
 9. │─ settle: { R, Accept, amount=price(tokens) } → 链上指令 ──────────────────▶│
     │                          │                          │  USDT: Escrow → Provider ATA
10. │◀─ tx hash 双方记录; 消费者本地存 receipt + 链证明                        │
    │  (可选)消费者签评分(1-5 + 延迟)→ 写入信誉账户                              │
```

**关键点**

- 第 9 步的 `amount` 由锁定 price 与 tokens 数机械算出,**双方都算得出**,无单方报数问题。
- 一次调用一笔链上结算(Solana 费用极低,~0.000005 SOL + 优先费,可接受;v1.1 可加批处理攒 N 次一笔省费)。
- 失败/超时:300s 内无完整回复 → 消费者可单方 `refund`(§8.4 超时分支)。
- 中断:任一方关闭 DataChannel,会话终止,已流出的 token 按实际计量结算(或全额退回,由 receipt 状态决定)。

---

## 7. 安全与加密设计

### 7.1 分层

| 层 | 机制 | 保证 |
|----|------|------|
| 传输 | DTLS 1.3(WebRTC 内置)/ 未来 QUIC+Noise | 信道防窃听/篡改 |
| 应用 | 每会话 ECDH(P-256) 临时密钥 → HKDF-SHA256 → AES-256-GCM(发送/接收各一组密钥) | **端到端**:中继/信令/平台只能看到密文 |
| 认证 | Ed25519 签名;公钥绑定 Listing(链上锚) | 防中间人冒充提供方 |
| 完整性 | 消息 nonce = `sessionId ‖ seq`,防重放 | 防截获重放 |
| 计量 | transcriptHash 双方独立计算比对 | 防偷换内容/少报 token |

- 会话结束:密钥擦除(内存 zeroize),临时公钥不留存。
- 前向安全:每会话独立 ECDH,历史会话不受未来泄露影响。

### 7.2 防 MITM 细节

1. Listing 链上锚定了 `p2pPublicKey`(提供方首次发布签名)。
2. Handshake 中双方出示 ECDH(P-256) 公钥 + 对密钥混合摘要的 Ed25519 签名(私钥=派生 P2P 身份私钥)。
3. 消费者核验:签名有效 **且** 公钥 == 所用 Listing 版本锚定的公钥。不符即中止。
4. 提供方改密钥 = 新 Listing 版本,消费者端自动跟随(展示"提供方更新密钥"提示,可设信任策略)。

### 7.3 隐私边界

- 目录/信令/TURN 可见:公钥对、listingId、时间戳、ICE 元数据。**不可见**:prompt、回答、tokens 明细。
- 链上可见:结算金额、时间、双方地址。transcriptHash 是单向哈希,不泄露内容(但可证明"双方交换过某段对话"——合规双刃剑,见 §14-R2)。
- v2 可选:消费者用一次性子钱包做托管充值,断开"钱包地址 ↔ 调用行为"的链上关联(成本:多一次链上派生/转账)。

### 7.4 transcriptHash 规范

```
canonical = sessionId || "\n" || paramsJson(canonical-ordered)
canonical += "\n" || for each msg in [system?, user, assistant...]:
                msg.role || "\u0001" || msg.content(UTF-8) || "\u0001"
transcriptHash = SHA-256(canonical)
```

- 流式回复:assistant 内容在 `finishReason` 时定型;中途取消则 hash 覆盖已输出部分。
- 偏差容忍:token 计数允许 ±5%(tokenizer 差异),hash 必须**精确相等**(双方用同一 tokenizer id 声明于 Listing;不一致即走争议,提供方承担举证)。

---

## 8. 链上设计(Solana / Anchor)

### 8.1 令牌

- USDT(SPL 代币,mint `Es9vMFrzaCERmJfrF4H2FYD4KZYGLKfBD4NThwexDBft`,6 位小数)。
- ⚠️ 需在实施前验证该 mint 的 freeze/mint 权限(若发行方保留 freeze authority,用户存在被冻资产风险)。设计层面支持**可配置 mint**,并建议 UI 提供 USDC 备选结算轨(§14-Q1)。

### 8.2 账户布局(PDA)

| 账户 | 种子 | 内容 |
|------|------|------|
| `Escrow` | `["escrow", consumer, listingId]` | consumer, listingId, 余额(指向 USDT ATA),状态机字段,最近结算 ts |
| `Escrow ATA` | 标准 ATA(PDA: escrow PDA, USDT mint) | USDT 余额 |
| `ListingAnchor` | `["listing", provider, listingId]` | listingHash, p2pPublicKey, price 快照, version, updatedAt |
| `Bond` | `["bond", provider, listingId]` | 保证金余额(USDT ATA)、状态(active/slashed) |
| `Reputation` | `["reputation", provider]` | totalCalls, disputes, disputeWins, 平均延迟(签名写入), 最后活跃 |

### 8.3 指令集

```
registerListing(provider, listingHash)          // 锚定价格版本
fund(consumer, listingId, amountUsdt)           // USDT 转入 Escrow ATA
settle(fast-path):  R + Accept(consumer 与 provider 双签) → USDT: escrow → provider ATA, 更新 reputation
settleByTimeout(provider 单签 + 结算窗已过)     // 消费者在窗口内未 dispute
refund(consumer 单签, 条件: 无 receipt 且调用超时 / 结算窗内未确认)
dispute(open, reason, evidenceHash)             // 冻结该笔金额,进入仲裁
arbitrate(arbitrator, verdict, split)           // v2: 指定仲裁者(有保证金的"仲裁人"角色)
withdraw(consumer, 余额)                        // 未使用余额取回
postBond / releaseBond / slashBond             // 保证金生命周期
score(consumer, provider, rating, latencySig)  // 信誉写入(仅成功结算后可写)
```

### 8.4 Escrow 状态机(防赖账核心)

```
                fund
   [EMPTY] ──────────▶ [FUNDED]
                          │  开始调用
                          ▼
                       [IN_CALL]  (无链上金额锁定,仅逻辑 earmark)
                          │  收到 Receipt R
                          ▼
                  [SETTLE_WINDOW]  W = 60s
                     ├── 双签 settle ───────────────▶ [SETTLED] (USDT→provider)
                     ├── 任一方 dispute ────────────▶ [DISPUTED] → 仲裁
                     └── W 到期, provider 单签 ────▶ [SETTLED]
                          │  (IN_CALL 中) 调用超时 T=300s, consumer 单签
                          └────────────────────────▶ [REFUNDED] (USDT 留 escrow/退回)
```

- **消费者赖账不可能**:成功调用后,60s 结算窗内他不签 Accept,提供方到期可单方结算。
- **提供方赖账不可能**:无 receipt 或内容不符(transcriptHash 不等)→ 消费者 refund/dispute,资金不出 escrow。
- 争议冻结金额在仲裁前双方都拿不走(仲裁 v2;v1 简化为:双签退款 + 保证金赔付兜底)。

### 8.5 费用预算(每调用)

- 1 笔 `settle` 指令 ≈ 5000 lamports 基础 + priority fee(devnet 忽略;mainnet 估算 < 0.00001 SOL)。
- 相对最低费用 0.00001 USDT 的调用,链费占比高 → 提供"批结算"开关(v1.1):攒 ≤24h 或 ≤20 笔合并一笔,escrow 状态机支持 pending 队列。

### 8.6 保证金与质量

- 上架缴纳 100 USDT(可调),`releaseBond` 要求:无未决争议 + 下架 ≥7 天。
- 仲裁败诉(内容造假、计量欺诈):slash 相应金额赔给消费者。
- 信誉账户公开可查,消费者 UI 展示:成功率、争议率、平均延迟、历史结算总额(链上可验证,不可篡改)。

---

## 9. P2P 网络设计

### 9.1 v1:双方浏览器 WebRTC

- **DataChannel**(ordered, maxRetransmits 受限的可靠模式用于控制消息;TokenStream 用不可靠有序 + 应用层 seq/ack,允许丢帧降级提示)。
- **NAT 穿越**:
  - STUN:公共 STUN + 自建 STUN(多区域)。
  - TURN:自建 coturn,按量预算(典型家庭 NAT 需要);TURN 只转发明文 SDP 握手后的**密文**,对内容盲。
- **信令**:无状态 WebSocket 房间(sessionId 房间,60s TTL,不落盘,多实例水平扩展,任一实例被撤不影响协议)。消息:`{"t":"sdp"/"ice"/"bye"}`。
- 降级链:ICE 直连 → STUN 打洞 → TURN 中继。全部路径 E2E 不变。

### 9.2 元数据发现(目录)

- v1:轻量 HTTP 服务(单进程可起多实例),接口:
  - `GET /listings?filter=...` → Listing 摘要列表(不含内容)
  - `GET /listings/{id}` → 完整 Listing(签名体)
  - `POST /listings` → Provider Agent 推送(钱包签名验证)
  - `WS /presence` → 在线心跳(15s)
  - 数据只读副本:权威 = 链上 ListingAnchor + DHT(v2);目录可任意重建。
- v2:libp2p Kademlia DHT(记录 key = `listingId`)+ gossip 订阅 `listings.updated`;浏览器端经"目录节点"(WebRTC 常驻节点)代理查询。

### 9.3 v2 无头节点

- Node.js + libdatachannel(WebRTC C 库绑定)复用**同一信令协议**,与浏览器互通。
- 职责:高并发 Provider Agent、TURN/STUN 自营、DHT 目录节点。
- 部署形态:任意 VPS / 家用机 / 边缘。

---

## 10. 节点本地数据模型

浏览器(IndexedDB)/ 节点(RocksDB),每端自维护:

```
listingsCache     { listingId → Listing, updatedAt, 来源实例 }
sessions          { sessionId, peerPubkey, listingHash, status, tsStart, tsEnd }
receipts          { sessionId, R(签名), Accept/Dispute(签名), amount, txHash?, verified }
balances          { listingId → escrow 余额(链上快照 + 本地增量) }
reputationCache   { provider → {calls, disputes, avgLatency, lastSeen} }
config            { backend 配置(仅 Provider 端), 信任策略 }
```

- 对账:每 N 分钟 / 每次余额变化,拉链上 escrow 状态校准本地;不一致以链上为准并告警。
- 迁移/换浏览器:receipts 可导出(含签名,自证),余额在链上跟人走,无锁定。

---

## 11. 平台服务面(极薄 API)

| 接口 | 用途 | 认证 |
|------|------|------|
| `GET /nonce` | 登录挑战 | 无 |
| `POST /verify` | 换 session(15min) | 钱包签名 |
| `WS /signal` | SDP/ICE 房间中继 | session |
| `GET/POST /listings` | v1 目录同步 | session(写需钱包签名) |
| `GET /chain/escrow?consumer&listing` | 链状态代理(可被钱包直读替代) | session |
| `GET /health` | 实例健康 | 无 |

**平台不持有**:私钥、推理内容、token 明细、资金。全部接口可在 v2 由 DHT/直连替代。

---

## 12. 技术栈

| 层 | 选型 | 备注 |
|----|------|------|
| 消费者 WebApp | React + Vite + TypeScript | 单仓库 monorepo:`web/`(共享给 Provider Agent 面板) |
| 钱包 | @solana/web3.js + wallet-standard(Phantom 优先) | 开发模式本地 Keypair |
| P2P | 原生 WebRTC + `simple-peer` 级封装 | 控制消息可靠 / 流消息不可靠有序 |
| 加密 | WebCrypto(ECDH P-256、AES-GCM、HKDF、SHA-256) + tweetnacl(Ed25519,与 Solana 字节兼容) | 无重密码学依赖 |
| Provider Agent | v1 浏览器(同 web/ 代码);v2 Node + libdatachannel | |
| 推理后端对接 | OpenAI-compatible HTTP(SSE) | 覆盖 Ollama/vLLM/llama.cpp/OpenRouter 等 |
| 本地推理(v1.x) | ONNX Runtime Web / WebGPU | ≤7B INT8 |
| 链上程序 | Rust + Anchor | devnet 先行 |
| 目录(v1) | Node.js 轻量服务 + 文件/Redis 缓存 | 可多实例 |
| 信令/TURN | Node WS 中继 / coturn(Docker) | 无状态 |
| 本地存储 | IndexedDB(dexie) / RocksDB | |

---

## 13. 里程碑

| 阶段 | 周期 | 交付 | 验收标准 |
|------|------|------|----------|
| M0 | ~1 周 | 目录服务 + 钱包登录 + WebRTC echo 通道(无加密) | 两个浏览器标签页互发消息;无 Phantom 用开发钱包 |
| M1 | ~2-3 周 | E2E 加密 + Provider Agent(openai-compatible 转发,含 localhost Ollama)+ 消费者完整调用链 | 提示词端到端不可被中间实例读取;token 流式回显;计量 receipt 可生成可验签 |
| M2 | ~2-3 周 | `mesh-escrow` devnet + USDT 真实逐次结算 + receipt 链上证明 | devnet USDT(测试 mint)完成 fund→settle→withdraw 全流程;结算窗/dispute 分支可触发 |
| M3 | ~2-4 周 | 信誉、保证金、争议、TURN 冗余、多目录实例、移动端适配 | 恶意场景演练:赖账/超时/内容不符 均有正确资金走向 |
| M4 | — | mainnet:真实 USDT、仲裁人机制、无头节点(v2)、审计 | 第三方合约审计 + 小额真实交易灰度 |

---

## 14. 风险与开放问题

| # | 风险/问题 | 影响 | 缓解/决策点 |
|---|-----------|------|-------------|
| R1 | Solana USDT mint 的 freeze/mint authority 未知 | 发行方理论上可冻结用户资产 | 实施前查证 mint 账户;UI 支持 USDC 备选轨;或只收链上可验证的无冻结 mint |
| R2 | E2E 使平台无法审计内容 → 滥用(违规内容/诈骗)难以平台侧拦截 | 合规与品牌风险 | 保证金 + 仲裁 + 举报(slash 赔付);v2 可选"内容哈希承诺"指令(能证明调用存在但不能证明内容);法律层面:平台定位 = 通信/结算基础设施 |
| R3 | 家庭 NAT 导致 P2P 直连失败率 | 体验下降 | 自建 TURN(预算成本);无头节点侧多为服务器,打洞成功率单边高 |
| R4 | 逐次结算链费占比(超微额调用) | 小调用不划算 | 批结算(v1.1);minFee 兜底 |
| R5 | 浏览器 Provider Agent 不能长期在线 | 提供方 SLA 差 | Listing 声明在线时段;v2 无头节点;市场展示"在线"实时状态 |
| R6 | 提供方单点(机器故障/掉线) | 调用中断 | 超时 refund;同模型多提供方消费者端自动重试/负载均衡 |
| R7 | 钱包私钥泄露 = 资金+身份双失 | 高 | P2P 密钥 HD 派生分离;收款建议独立子钱包;UI 安全提示 |
| R8 | 定价作弊(极低引流→改价) | 用户被误导 | listingHash 锁定 + 历史价格版本链上可查(信誉可见) |
| R9 | 跨境合规(虚拟资产结算、模型数据合规、税务) | 法务 | 按目标司法区设计白名单/地区限制;文档先行 |
| R10 | 浏览器 WebRTC 并发与后台标签页节流 | Provider Agent(浏览器)吞吐受限 | 后台节流提示 + 无头节点(v2);maxConcurrent 如实声明 |

### 已锁定决策(2025-07 确认)

| # | 决策 | 结论 |
|---|------|------|
| Q1 | 结算令牌 | USDT 为主 + USDC 备选轨,双 mint 可配置(已实现为 config 常量) |
| Q2 | v1 目录 | 轻量中心化服务(单实例 Node 服务),v2 纯 DHT |
| Q3 | Provider Agent 形态 | 浏览器优先(零安装),v2 无头 Node 节点 |
| Q4 | 结算粒度 | 逐次(per-call),批结算 v1.1 |
| Q5 | 链环境 | devnet 先行,配置可切 mainnet;v1 交付 sim 账本 + Anchor 程序源码 |
| Q6 | 项目名 | MeshLLM |

---

## 13.1 实现状态(本次交付)

- **已完成(M0+M1 主体)**:`shared/`(协议+E2EE,9 项单测)、`server/`(目录+登录+WS 信令+escrow sim 账本+mock LLM,8 项单测+12 项端到端冒烟)、`web/`(React 前端:登录/市场/Provider 面板/结算账户)。
- **M2 部分完成**:`programs/mesh-escrow` Anchor 程序源码(状态机与 sim 账本 1:1),构建/部署需 Anchor 工具链(本机为 Windows 无 Rust)。
- **未做**:devnet 实部署、批结算、信誉积分、TURN 自建、无头节点(v2)。

---

## 15. 附录

### A. 协议消息类型(DataChannel 内,全部经 E2E 加密)

| msg | 方向 | 字段 |
|-----|------|------|
| `hello` | 双向 | version, p2pPubkey, ed25519sig, nonce |
| `handshake` | 双向 | sessionId, listingId, listingHash, capabilities, nonce |
| `prompt` | C→P | prompt, params, stream?:bool |
| `token` | P→C | seq, delta, finishReason? |
| `receipt` | P→C | tokensIn, tokensOut, transcriptHash, listingHash, ts, sig |
| `accept` / `dispute` | C→P | receiptRef, reason? |
| `heartbeat` | 双向 | ts |
| `bye` | 双向 | code |

### B. 计量与价格公式

```
amountUsdt = max( minFee,
                 ceil(tokensIn  * per1kInput  / 1000 * 1e6) / 1e6
               + ceil(tokensOut * per1kOutput / 1000 * 1e6) / 1e6 )
```

(向上取整到 1 个 USDT 最小单位,防零金额;双方用同一 listingHash 的 price 独立计算,应恒等。)

### C. 目录 Listing 摘要示例(公开可见)

```json
{ "listingId": "0x8f…", "provider": "9xQ…", "model": "llama-8b",
  "per1kIn": 0.0005, "per1kOut": 0.0015, "online": true,
  "rep": { "calls": 1234, "disputeRate": 0.002, "avgLatencyMs": 850 } }
```

### D. 与替代方案对比(决策记录)

| 方案 | 结论 |
|------|------|
| 完全中心化代理推理(平台转发) | 否决:违反 R5,平台成为内容/单点/信任中心 |
| 纯 IPFS 存数据 | 否决:推理是实时流,IPFS 不适合;仅元数据可考虑 |
| Ethereum 结算 | 否决:gas 成本不支持逐次微支付 |
| 链下账本 + 定期清算 | 保留为 v1.1 批结算的内部实现,但真相锚仍在链上 |
| WebRTC vs libp2p | v1 WebRTC(浏览器互通性);v2 双轨(WebRTC 兼容节点) |
