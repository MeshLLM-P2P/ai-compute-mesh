# MeshLLM — AI 大模型算力共享平台

点对点优先的 LLM 算力市场:任何人把自己的模型以 API 形式接入,
按调用(逐次)定价,USDT 结算,钱包地址即身份。调用数据走
WS 数据面(`/dc`)+ 应用层端到端加密(AES-256-GCM),
平台只承担目录、信令、密文中继与托管账本,不接触提示词明文。

完整设计见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 目录结构

```
ai-compute-mesh/
├── docs/ARCHITECTURE.md      # 架构设计文档(中文,v0.1)
├── shared/                   # @mesh/shared:协议帧/规范化哈希/E2EE 密钥派生
├── server/                   # @mesh/server:目录 + 钱包登录 + WS 信令 + /dc 密文中继 + escrow 模拟账本 + mock LLM
├── web/                      # @mesh/web:React 前端(市场 / Provider 面板 / 结算账户)
├── agent/                    # @mesh/agent:无头 Node Provider 守护进程(方案 C,7×24 在线)
├── bridge/                   # @mesh/bridge:OpenAI 兼容桥(/v1/chat/completions),让外部 AI Agent 接入
└── programs/mesh-escrow/     # Anchor 托管程序源码(M2,需 Anchor 工具链构建)
```

## 快速开始

要求:Node.js ≥ 20(开发机为 Node 24),npm workspaces 开箱即用。
纯 JavaScript 项目(无原生依赖),**Windows / Linux / macOS 均可运行**。

**一键启动**(首次运行会自动 `npm install`):

```bash
# Windows:双击或命令行执行
start.bat

# Linux / macOS
sh start.sh        # 或 chmod +x start.sh && ./start.sh
```

**手动方式**(依赖由 npm workspaces 在根目录一次性自动安装,无需逐包安装):

```bash
npm install            # 根目录一条命令安装全部 workspace
npm run dev            # 同时启动 server(:4011)与 web(:5173)
```

浏览器打开 http://127.0.0.1:5173。

### 演示流程(同一台机器,两个标签页)

1. **Provider 标签页**
   1. 点击"连接钱包"(Phantom 或"开发钱包"——本地生成的 Ed25519 演示身份)。
   2. 进入"Provider 面板",填写模型名、定价(USD/1k tokens)、最大 tokens,
      选择后端(`echo` 确定性回显 / `mock` 内置流式模型 / `custom` 任意
      OpenAI 兼容端点,需该端点允许浏览器跨域)。模型名可从后端获取:点"探测后端模型"(`mock` 走内置 `GET /mock-llm/v1/models`,`custom` 走 OpenAI 兼容 `GET /v1/models`),自动填充并给出下拉选择;后端有多个模型时点"批量发布全部模型",每个模型各发布一个独立 listing。再点击"发布 listing"。一个账户可在多个后端发布多个模型(同模型不同后端 = 两个独立 listing,并存;同模型同后端改价 = 新版本替代旧版)。
   3. "我的 Listings"表格列出该账户全部 listing;对任意行点"上线 agent"——该 listing 的 Agent 开始监听 `lst:<listingId>` 房间并每 5s 发送在线心跳(多行可各自上线,互不影响)。
2. **Consumer 标签页**
   1. 连接钱包,进入"算力市场",找到该 listing(在线状态为 true)。
   2. 点击"调用"——自动为 escrow 入金(预估额 × 2),随后与 Provider 建立
      WS 数据面(`/dc`)建立数据通道并完成 E2E 密钥交换(kx)。
   3. 发送提示词,流式接收 token;收到 receipt 后页面自动本地校验
      (transcriptHash 精确匹配、token 数 5% 容差、提供方钱包签名)。
   4. 点"接受并结算"(双签快速结算,60s 结算窗内)或"发起争议"。
   5. Provider 侧:若消费者不响应,60s 后 Provider 可单边 `settleWindow` 收款。
3. **结算账户标签页**:查看 escrow 行状态(FUNDED / IN_CALL / SETTLE_WINDOW /
   DISPUTED / SETTLED)并执行 withdraw / cancel / refund / settleWindow / resolve。

> 演示注意:若两个标签页使用同一个演示钱包,同一签名同时满足双方角色,
> UI 此时只显示 `settleWindow` / `resolve` 按钮(自托管场景)。

## 市场与账户功能(v0.2)

- **测试账户自动充值**:首次登录(`/verify`)的钱包自动入账 100 USDT
  (`MESH_TEST_CREDIT_RAW` 可调),免去手工入金;市场页顶部实时显示
  余额 / 可用 / 冻结(`GET /me/balance`)。
- **限制用户数量**:Provider 面板可设置"用户数量限制(最大并发连接)",
  写入 `listing.limits.maxConcurrent`;满员时 Agent 会向等待的 Consumer
  发送 `busy` 信号,调用方快速失败并可稍后重试。
- **我的 Listings 可删除**:"删除模型"软删除(市场不再展示,进行中的
  结算仍可完成),`DELETE /listings/:id`。
- **市场实时统计与排序**:`GET /listings?online=1&stats=1` 返回每个
  listing 的 `activeUsers`(正在通话数)与 `stats {avgLatencyMs, avgTps,
  samples}`(最近 20 次回执实测);市场页卡片显示"响应 / 生成 / 在线
  用户 x/y",并可按 响应最快(默认) / 生成最快 / 价格最低 / 在线人数最少
  / 最近上线 排序。
- **评论留言**:每个 listing 可展开评论列表并留言(≤500 字,`GET/POST
  /listings/:id/reviews`),最近 50 条。

## 接入自己的模型(外部 API)

在 Provider 面板选择后端类型 `custom`:

1. 填后端 URL,如 `https://api.tlvip.uk/v1/chat/completions`
   (填 `/v1` 或 chat 端点均可,探测时自动换算为 `/models`)。
2. 勾选"**使用平台中继**"并填 API Key(可选)。浏览器直接跨域调用第三方
   API 受 CORS 限制;勾选后调用改走平台中继 `POST /relay`:密钥只存在于
   Provider 浏览器内存与在途请求中,**不写入 listing、不入库、不进目录**。
3. 点"探测后端模型"拉取模型列表(中继模式同样需要登录会话),选择模型。
4. 填定价与用户数量限制,发布;在"我的 Listings"点"上线 agent"即可接单。

## AI Agent 如何使用平台模型

- **消费方**(当前 v1,浏览器):钱包登录 → `GET /listings?online=1` 选模型
  → `POST /escrow/fund` 入金 → 经 WS 信令(`lst:<listingId>` 房间)发起
  呼叫 → kx 密钥交换 → `/dc` 数据通道收发加密提示词/回执 →
  验签后 `settle-fast` 双签结算。参考实现:`web/src/session.js`
  `startConsumerCall`。
- **消费方 Agent**(无浏览器):目录、余额、托管全部是 HTTP API
  (`/listings`、`/me/balance`、`/escrow/*`),均可用钱包签名调用;
  数据传输层即 WS `/dc` 数据面 + kx/E2EE 协议(见
  `shared/src/protocol.js`、`shared/src/e2ee.js`,最小参考实现
  `agent/examples/live-consumer.js`)。
- **提供方 Agent**(无头 Node 守护进程,方案 C,已交付):见下节
  "Headless Node Agent"。

## WorkBuddy / AI Agent 接入桥(OpenAI 兼容,`bridge/`)

想让 **WorkBuddy 这类外部 AI Agent**(任意 OpenAI 客户端) 直接当 consumer
消费你 MeshLLM 算力市场的模型,而无需自己实现 E2EE 钱包/托管流程,用 `bridge/`
桥。它对外暴露标准 **OpenAI `/v1/chat/completions` + `/v1/models`** 接口,
内部自动完成 MeshLLM 完整 consumer 链路:钱包登录 → 在线 listing 选模型 →
`fund` 入金 → 信令 `call` → `/dc` kx 握手 + 加密推理 → 回执验签 →
`settle-fast` 双签结算。

### 启动桥

```bash
cd ai-compute-mesh
node bridge/server.js
# [bridge] listening on http://0.0.0.0:4021 (OpenAI 兼容) -> MeshLLM auto-listing
# [bridge] consumer wallet=xxxx...
```

配置 `bridge/config.json`:

```json
{
  "server": "127.0.0.1:4011",      // MeshLLM 平台服务器
  "ws": "wss://127.0.0.1:4011",    // 信令 + 数据通道
  "port": 4021,                     // 桥对外端口
  "wallet": "./wallet.json",        // 桥自己的 consumer 钱包
  "listing": "",                    // 固定 listing ID;留空则自动选第一个在线 listing
  "fundRaw": 1000000,               // 首次登录入金额(微USDT,1000000 = 10 USDT)
  "timeoutSec": 200                 // 单次调用超时(秒)
}
```

> 注意:桥是 **HTTP**(非 HTTPS),本地局域网可直连。跨网络请放在可达的内网/
> 代理后,或自行加 TLS 前置。

### 在 WorkBuddy 里添加自定义模型

WorkBuddy → **设置** → **模型** → 右上角 ** + ** → 选「**自定义 / Custom**」:

| 字段 | 值 | 说明 |
|---|---|---|
| 提供商 | **自定义 / Custom** | 不是内置提供商 |
| 接口地址 | `http://192.168.2.108:4021/v1/chat/completions` | **必须填完整地址**,以 `/v1/chat/completions` 结尾(不是根地址) |
| API Key | 任意非空占位(如 `meshllm`) | 桥当前无鉴权,填占位即可 |
| 模型名称 | 如 `Ternary-Bonsai-2-27B-ninfer-v3-8001` | 当前在线 listing 的模型 ID;以 `/v1/models` 返回为准 |

勾选项:只勾**工具调用**(按需);**不勾图片输入**(当前模型只支持 text);
思考模式按需。

### 保存后切换模型

**保存 ≠ 切换**。配完保存到 WorkBuddy,再到对话页点**输入框右下角的当前
模型名**,在列表里**选中**你刚加的模型(名字旁出现勾选标记才算生效),
否则会一直用旧模型。

### 连接验证

```bash
# 看可用模型
curl http://127.0.0.1:4021/v1/models

# 发一条对话(非流式)
curl -X POST http://127.0.0.1:4021/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"Ternary-Bonsai-2-27B-ninfer-v3-8001",
       "messages":[{"role":"user","content":"测试: 你好,请简短回应\"你好\""}]}'
```

返回形如:

```json
{"id":"chatcmpl-bridge-33f62340d1ec8fcb",
 "choices":[{"index":0,"message":{"role":"assistant",
    "content":"你好!很高兴见到你。..."}}],
 "usage":{"prompt_tokens":1,"completion_tokens":7,"total_tokens":8}}
```

### 结算与网络说明

- 桥用自身钱包(`bridge/wallet.json`)跟平台做 **E2EE 调用 + Solana USDT
  托管结算**。每次对话完整走完 `login → fund → E2EE → 验签 → settle`。
- 模型列表实时跟随**在线 provider 发布的 listing**。换 provider / 换 listing
  后模型 ID 会变,WorkBuddy 报 `model not found` 时去模型配置里换成
  `/v1/models` 返回的最新 ID。
- **重启后桥不会自动起**:重启后需在项目目录重新跑 `node bridge/server.js`。

## Headless Node Agent(方案 C)

无浏览器的 7×24 Provider 守护进程(`agent/`):进程在运行 ∧ 模型探测健康
即为在线,无需浏览器登录;钱包与 API Key 全在本地文件。

**接入步骤**:

1. **钱包**:从 Provider 面板"导出钱包"得到 JSON,存为
   `agent/wallet.json`(`{address, secretKeyB64}`)。
2. **配置**:`agent/config.json`

   ```json
   {
     "server": "127.0.0.1:4011",
     "tls": true,
     "caCert": "../server/tls/cert.pem",
     "wallet": "./wallet.json",
     "listings": [
       { "id": "<listingId>", "apiKey": "sk-..." }
     ],
     "heartbeatSec": 30, "probeSec": 30, "probeFailThreshold": 2
   }
   ```

   - `listings` 只列要接单的 active listing(已 superseded 的别放);
     `apiKey` 为该 listing 后端端的密钥(同后端可共用)。
   - 自签平台证书场景下 `tls:true` + `caCert`;探测**公网**后端时自动
     不用该 CA(只用系统信任库),两者互不干扰。
3. **运行**:`agent/run.cmd`(崩溃 3s 自动重启)。开机自启(Windows):

   ```bat
   schtasks /Create /TN MeshLLM-ProviderAgent ^
     /TR "D:\...\ai-compute-mesh\agent\run.cmd" /SC ONLOGON /F
   ```

4. **验证**:`GET /listings` 中该 listing `online=true`;跑
   `node agent/examples/live-consumer.js` 走一次真实调用(回执验签 +
   双签 SETTLED)。

**行为要点**:

- 上线 = 进程存活 + 模型 `GET /v1/models` 探测 2xx;连续
  `probeFailThreshold` 次失败自动下线(修好后探测恢复自动上线)。
- 数据面:`/dc` 加入 `sess:<sessionId>` 房间,kx 握手(与浏览器版同一套
  `shared/src/channel.js` KxSession,传输无关);后端流式响应按序转发
  (每 call 一条串行发送链,保证 token 顺序与回执 transcriptHash 一致)。
- 同 session 去重:consumer 握手期间重发的 offer 只会被第一个 call 接受,
  避免两边 kx 临时公钥交叉导致验签失败。
- 并发受 `listing.limits.maxConcurrent` 约束;满载时回 `busy` 信号。
- 多轮对话:一次 call(一份托管)内可连续多轮追问,回执对全历史签名。

## 测试

```bash
npm test -w shared               # 协议 + E2EE 单元
npm test -w server               # escrow 单元 + /dc 中继 + 全链路 e2e(echo 后端,
                                 #   进程内起一个 node agent;server 在 :4011 时自动附加冒烟)
node test/smoke.js               # 单独跑端到端冒烟(需要 server 在 :4011 运行)
node agent/examples/live-consumer.js   # 真实链路参考实现(需 agent 守护进程 + 真实后端在运行;
                                 #   不属于 npm test)
```

## API 摘要(server :4011)

| 方法/路径 | 说明 |
|-----------|------|
| `GET /health` `GET /config` | 健康检查 / 运行配置 |
| `GET /nonce?wallet=` + `POST /verify` | 钱包登录(签名 nonce 换 session) |
| `GET /listings` / `GET /listings/:id` | 目录(可 `?online=1&provider=&model=&stats=1`) |
| `POST /listings` / `DELETE /listings/:id` | 发布(签名) / 删除(提供方本人) |
| `POST /presence` | 在线心跳(TTL 120s) |
| `POST /presence/offline` | 显式下线:立即清除在线状态(不等 TTL),并短暂抑制在途心跳 |
| `GET /me/balance` | 余额 / 可用 / 冻结(需会话) |
| `GET/POST /listings/:id/reviews` | 评论留言(POST body 字段为 `body`) |
| `POST /relay` | 平台中继:转发任意 http(s) 请求(含 SSE 流),密钥不落盘(需会话) |
| `GET /escrow?consumer=&listingId=` / `POST /escrow/{fund,begin-call,cancel,receipt,settle-fast,settle-window,refund,dispute,resolve,withdraw}` | 托管账本操作(fund 超可用余额返回 402 `insufficient-balance`;cancel 让 consumer 立即把 IN_CALL 释放回 FUNDED,无需等 300s) |
| `GET/POST /bonds` | 保证金 |
| `POST /mock-llm/v1/chat/completions` | 内置 OpenAI 兼容 SSE 流(演示后端) |
| `WS /signal` | 无状态信令:房间 `lst:<listingId>`、`sess:<sessionId>` |
| `WS /dc` | 数据面:首帧须为 `{t:'join',room:'sess:<sessionId>'}` → `{t:'joined'}`;此后该会话房间的原始帧在成员间逐字节转发(server 不解密) |

## 关键安全性质

- **E2E**:会话密钥 = HKDF(ECDH-P-256 临时公钥, salt=双公钥字典序拼接,
  info=`meshllm-v1-key1/-key2`);字典序较小的临时公钥方使用 key1 发送。
  信令/目录服务端看不到提示词与响应。
- **防 MITM**:kx 握手帧携带双方钱包 Ed25519 签名,绑定
  `(ephemeralP256, peerEphemeral, sessionId)`,临时公钥与钱包身份绑定。
- **金额不可伪造**:结算金额永远由托管层用 listing 定价 × receipt token 数
  重算;receipt 由提供方钱包对规范化 payload 摘要签名,消费者验签后双签结算。
- **listing 不可篡改重放**:`listingId = sha256(规范化 payload)`,
  提供方签名绑定 id;改价即新版本即新 id,旧版标记 superseded。

## 浏览器约束(须知)

- `custom` 后端直连时必须允许当前浏览器跨域(CORS);若端点不支持
  CORS,勾选"使用平台中继"即可(密钥不落盘,见上文"接入自己的模型")。
- 后台标签页会被浏览器节流定时器,心跳会断:presence TTL 为 120s,且
  Provider 面板在页签重新可见时立即补一次心跳;"下线"会显式通知服务端
  立即清除在线状态,不用等 TTL 衰减;即便如此,
  浏览器 Agent 仍不适合 7×24,长期运行请用无头 Node 守护进程
  (见下文"Headless Node Agent",同一套 shared 协议代码)。
- 页面刷新/关闭时通过 `navigator.sendBeacon` 立即上报下线(session 走
  query 参数,因 sendBeacon 无法携带自定义 header),在线状态不留 TTL 残影。
- 刷新后自动恢复之前手动上线过的 agent(localStorage 记录);恢复逻辑只认
  "本页启动过"的本地集合,不信任服务端 presence(重载后 120s 内可能仍是
  旧的"在线"),因此刷新+登录后约 2s 内 agent 自动回来。
- 数据面为 WS `/dc`(经平台中继密文),不再依赖公网 STUN/TURN 打洞;
  跨网调用只需能访问平台 :4011(WSS)。

## 链上结算(M2)

- 当前 `MESH_SETTLE_MODE=sim`:server 内模拟账本实现完整状态机
  (与 Anchor 程序 1:1),演示与开发不依赖链。
- `programs/mesh-escrow` 为完整 Anchor 源码:PDA 布局、USDT 代币流转、
  双签结算、结算窗、超时退款、争议冻结/解除、保证金。构建部署步骤见
  [`programs/mesh-escrow/README.md`](programs/mesh-escrow/README.md)
  (需要 Linux/macOS/WSL 上的 Anchor 0.30 工具链)。
- 部署后把 program id 回填 `server/src/config.js` 即可切换
  `MESH_SETTLE_MODE=devnet`(devnet 交互客户端为后续工作)。

## 许可证

MIT(待补充 LICENSE 文件)。
