# MeshLLM 项目规划(2025-07 重新梳理)

AI 大模型算力共享平台:用户把自己的 LLM 以 API 形式挂售,Provider 自主定价,
Consumer 按次调用,USDT 逐次结算,数据面 P2P 端到端加密。

## 1. 已锁定的技术决策(不再讨论)

| 决策 | 内容 |
|---|---|
| 结算货币 | USDT 主,USDC 备选 |
| 目录 | v1 轻量中心化目录(server REST + WS 信令),非 DHT |
| Provider Agent | 浏览器优先(无守护进程,页面开着即在线) |
| 结算粒度 | 逐次调用托管(escrow per call) |
| 链上路径 | devnet 先行;settleMode=sim(服务端模拟账本)→ devnet(Anchor 真实转账) |
| 数据面 | v1:WS 中继 `/dc`(server 转发密文,不解析)+ E2EE(P-256 kx → HKDF → AES-256-GCM 帧);传输无关的 kx 协议与 WebRTC 时代完全兼容 |
| 身份/登录 | Solana ed25519 钱包签名验证;浏览器本地 Demo 钱包或 Phantom |
| 模型 API 中转 | provider 浏览器 → server `/relay` → 用户的 LM Studio(解决 CORS/直连问题) |
| Provider 押金 | 100 USDT(上线时冻结,下线退还) |
| 测试钱包 | 新钱包首次登录自动入账 100 USDT(sim 模式) |

## 2. 架构与数据流

```
Consumer 浏览器                Provider 浏览器(可以是另一台机器)
  Market.jsx                     ProviderPanel.jsx
       │                              ▲
       │ 1) 选 listing、锁定资金       │ 4) 流式 token、签名回执
       ▼                              │
 server (Node/Express, :4011)        │
  - REST: listings/escrows/presence/relay/mock-llm
  - WS /signal: 房间转发(lst:<id>, sess:<id>)   ──► 同一 server
  - escrow 状态机(模拟账本,data.json)
       ▲
       │ 2) 信令(SDP/ICE/kx 帧)
       │ 3) 加密业务帧(prompt/tokens/receipt)◄──┘
 WebRTC DataChannel('mesh') ←────────────►
  两端 E2EE,server 只见密文
```

关键状态机:
- escrow:`EMPTY → FUNDED → IN_CALL → SETTLE_WINDOW(60s) → SETTLED`;
  取消路径 `IN_CALL→FUNDED`、`FUNDED→EMPTY`;>300s 的陈旧 IN_CALL 自动释放。
- 调用超时:信令连接 8s / 通道建立 15s / 全程 300s / 空闲 ping 15s(dc-dead)/
  provider 120s 未收到提示词自动释放。

## 3. 当前状态盘点

### 3.1 已完成(有测试/实测背书)

- **server**:escrow 状态机、listings、presence、relay、mock-llm、会话鉴权、争议决议(含 P3 全额退款自动划扣押金);测试 23/23 通过
- **P3 争议处理**:全额退款=provider 败诉:自动 slash 冻结额押金(封顶余额)+ disputesLost/refundedRaw/slash 事件记录;部分退款不 slash;09/25 修复 `resolve()` 全额退款分支陈旧读取 bug(见 3.3),回归全绿
- **E2EE**:kx 握手 + 帧加密解密;测试 2/2 通过
- **Web 应用**:三页签(Market/Provider/结算)、统一事件日志、Demo/Phantom 钱包、
  agent 自动恢复上线、pagehide/visibility 心跳防浏览器节流
- **WebRTC 健壮性**:iceServers 回退链(防 Chromium 严格校验抛错)、DC 未 open 不发帧、
  ping/pong 活性探测、卡死 disconnected 8s 判死、晚到死亡必上报、rtc 全程状态日志
- **多节点**:server/Vite 均绑 0.0.0.0;防火墙打通(.108 winfw + .174 ufw);
  .174 实测可达平台(HTTP 200/WS)、WebRTC UDP 往返 1–3ms
- **局域网节点**:.208(LM Studio,GSQ :8001 / FP8 :8000)、.174(Xeon 20 核 32GB,
  worker3 SSH,Chrome 已装,无 GPU 驱动)

### 3.2 进行中(阻塞在用户操作)

- ✅ **首次端到端结算:已达成(05:01,同机 .108)**:GSQ(.208 relay)流式输出 →
  回执校验通过(1 入 / 6 出)→「接受并结算(双签)」→ data.json 出现
  `SETTLED` 行 + `sim-26f075f372a983b3` 交易号;分账 provider 95 / 平台 5
  (维护1/售后2/推广2)已落账。P0 里程碑 1 完成。
- ✅ **首个跨机 P2P 调用:已达成(05:38)**:.174(6ijV)→ .108 provider →
  GSQ(.208 relay)流式 → 回执校验通过(1 入/4 出)→ 双签 → SETTLED
  (call 1789767483)。P0 两个里程碑全部完成。
- ⚠️ 遗留冻结行:6ijV|GSQ、6ijV|新模型、51cc07be 仍 IN_CALL(无回执),
  下次同 consumer+listing 再发起会自动释放,或结算页「取消调用」清掉。
  注意:改价/新增缓存单价 = 新 listing,旧 listing 冻结行需「取消调用」清理。
- ⚠️ tlvip listings(0538065c、36fc1529)需用户在 ProviderPanel 重新填一次
  API key 并点上线(key 现在会持久化到本机,刷新后自动恢复的 agent 也能带上)。
- ⛔ **.174 节点上线**:devnet 已切 HTTPS/WSS(自签证书),.174 侧 `curl`/`WSS`
  实测全通;剩浏览器端证书警告需用户手动信任(高级→继续访问,或键盘输入
  `thisisunsafe`),等用户重开 https 页面验证。
- ⚠️ 遗留数据:51cc07be 一行 escrow 冻结在 IN_CALL(对应已撤销的 listing),
  可在结算页「取消调用」清掉,无害但碍眼。
- ⏳ **浏览器重试(20:32 失败后)**:根因=陈旧旧协议 tab 混入会话(见 3.3
  09/20 20:32 行)。server 已加 sess 房间 2 成员上限 + dist 已重建;
  用户需**关闭所有机器上的旧 MeshLLM tab**(尤其 .174 可能还开着未重启的
  旧页面),用 `https://192.168.2.108:5173` 新开一个 tab(Ctrl+Shift+R
  强制刷新)再发起调用。

### 3.3 调用失败史(全部排查过的教训)

| 时间 | 现象 | 根因 | 状态 |
|---|---|---|---|
| 09:25 | DC 通,provider 收到空提示词 | 帧编码异步 await 缺失 | ✅ 已修 |
| 11:43 | 提示词未达,零日志 | 同 15:27 竞态(当时无诊断日志) | ✅ 已修(同下) |
| 17:41 | 通道建立后 5s `dc-not-open` | 同 15:27 竞态 | ✅ 已修(同下) |
| 22:48 | `new RTCPeerConnection` 抛错 | 我的 bug:STUN URL 丢 `stun:` 前缀 | ✅ 已修(回退链) |
| 15:27 | kx 完成后发提示词即 `dc-not-open`,DC 同秒 closed | 同 17:04(当时诊断行还没上线,只看到状态名 'open') | ✅ 已修(见 17:04) |
| 17:04 | 新诊断行实锤:等满 15s,`readyState` 一直是 'open',guard 却恒 false | **该浏览器 DataChannel.readyState 返回字符串 `'open'`,代码用数字比较 `=== 1`** → 健康通道被误判未就绪,提示词永远发不出,存活 ping 也从未发出(所有历史静默失败同根) | ✅ 已修:`webrtc.js` 新增 `dcIsOpen/dcIsClosed`(数字+字符串双形式),session.js 全部 6 处 + webrtc.js arm 3 处改用它;`sendPrompt` 保留等待逻辑;Market 保留连接阶段自动重试;诊断行保留 |

| 20:11 | 提示词已送达 provider,但 token/pong 全丢,consumer 15s 判死 | **作用域 bug**:`sendEncrypted` 定义在 per-call 的 `handleCall` 里,`handleBusiness`(agent 级函数)却引用它 → 每次发送抛 `ReferenceError: sendEncrypted is not defined`(被 `frame-decrypt-failed` 日志吞掉) | ✅ 已修:agent 级 `sendEncryptedFor(call, obj)`,5 处调用改用它。里程碑:同机(.108)与跨机(.174)提示词均首次送达 provider |

| 20:55 / 23:15 / 23:17 | 连接全部成功,backend 一律 401 `session-required` | **真凶**:provider agent 的 `runBackend` 用裸 `fetch` 调 `/relay`,**没带 `x-mesh-session` 头**,而 `auth.requireSession` 只认该头 → 我们自己的服务器把每次 relay 请求都拒了(第三方 backend 根本没被碰到;曾误诊为 tlvip 要求会话);另 provider 错误后立即 close 连接,consumer 误报 `connect-failed` | ✅ 双修:① `runBackend` relay 请求带 `x-mesh-session`(getSession);② provider 错误路径 `await` 错误帧 + 延迟 300ms 再 finish。已验证 backend `192.168.2.208:8000/8001` 当前均加载 GSQ 且补全正常。自动重试本次确认生效(20:55:49 自动发起第二次尝试) |

| 23:43 / 23:46 | **token 已流式返回**(首次!),但回执阶段 provider 崩:`Cannot access 'transcriptHash' before initialization` | 自遮蔽 TDZ:`const transcriptHash = await transcriptHash(...)` 局部 const 遮蔽了模块导入的同名函数,右端命中 TDZ | ✅ 已修:局部变量改名 `txHash`。另:tlvip 代理现在真正被打到,返回 `Invalid token`(`new_api_error`)——确认需要有效 API key,无 key 该 listing 不可用,建议删除 |

| 01:10 | token 流式+回执校验均通过,但点「接受并结算」报 `Cannot read properties of null (reading 'sessionId')` | **流程缺口**:回执经 P2P 到达并校验后,前端**从未调用 `/escrow/receipt`** 把它提交到服务端 → 托管行停在 IN_CALL 且 `receipt=null`,`settleFast` 读 null 崩溃(且该行之后永远无法双签结算) | ✅ 已修:① `settle()` 先 `POST /escrow/receipt`(IN_CALL→SETTLE_WINDOW,服务端复核 provider 签名;已在 SETTLE_WINDOW 幂等放过)再 settle-fast;② settleFast/resolve 对 null receipt 干净报错(409 `no-receipt-to-settle`),不再 500;③ 回归测试。**验证:05:01 同机 GSQ 调用完整走完 流式→回执→双签→SETTLED(sim-26f075f372a983b3),分账 95/5 落账** |

| 05:38 | 用户发布 tlvip listing 时填了 API key,调用仍一律 401 `Invalid token` | **key 未跨页面刷新存活**:key 只存浏览器内存(form 状态),整页刷新后「自动恢复上线」用空表单重启 agent → `apiKey: null` → 中继 body 无 Authorization → tlvip 拒绝。另发现潜伏 bug:custom+**直连**(非中继)路径根本不发 Authorization 头 | ✅ 双修:① key 按 listing 持久化 `localStorage['meshllm-apikey:<id>']`(仍不写入 listing),自动恢复时回退用保存的 key,填过即存;② `runBackend` 直连请求头也带 Authorization。用户需在 ProviderPanel 重填一次 key 并点上线(旧会话的 key 已随刷新丢失,无法找回) |

| 09:12 | .174 结算完再次调用报 `begin-call-not-allowed-in-SETTLED` | **SETTLED 是终态**:`fund`/`beginCall` 只接受 EMPTY/FUNDED,结算后同一 consumer+listing 被永久锁死 | ✅ `escrow.js` 新增 `archiveSettled`:beginCall/fund 遇 SETTLED 行先归档(键 `…:archived:<txId>`,完整保留结算记录),旧行剩余余额+累计计数器结转新行;EscrowPanel 归档行加「已归档」标注、唯一 React key;回归测试 14/14 |

| 09/20 重启后 | e2e-echo 偶发 `transcript hash mismatch`(约 85 次运行中 4 次,全部集中在进程冷启动窗口;另抓到一次变体:`turn 2 reply lost history`——turn 2 回复丢失 '第 2 轮' 字样,但 provider 日志证明两轮 prompt 均正确到达) | **根因定位:接收端解密完成序竞态**。链路其余环节均被实证保序(server 中继单线程同步、provider sendChain 串行发送、WS 传输有序),唯一未加顺序保证的环节是接收端 `decodeEncrypted(key, text).then(handle)`:WebCrypto `decrypt` 是异步的,**完成序不受提交序保证**;冷启动窗口首次 crypto 操作耗时波动大,后提交帧可能先完成 → token 块被乱序拼入 reply(同批词、不同序)→ 双方 token 数精确一致但 transcript 哈希分歧,或恰好拆散 '第 2 轮' 三连块使断言失败。早先"500/500 保序"实测只在预热态成立,未覆盖冷窗口 | ✅ 已修:四处接收端全部改为**帧链串行化**(`frameChain = frameChain.then(() => decode... .then(handle).catch(...))`),处理序=到达序,与解密完成序解耦——`web/src/session.js` consumer+provider、`agent/src/agent.js`、e2e 测试 consumer。验证:agent 重启后即刻 17/17 全绿(最苛刻冷条件),kill-restart 压力循环进行中 |
| 09/20 10:3x | agent 进程反复整体消失(node+run.cmd 守护同死),手动拉起后又死;kill 节点后守护 3s 重启从未生效 | **三重根因,逐一实证**:(1) 任务 XML 默认 `<StopOnIdleEnd>true</StopOnIdleEnd>`——无头机无键鼠输入即判空闲,任务树会被强杀;(2) `timeout /t 3 /nobreak` 在无控制台环境下行为不可靠(报 "Input redirection is not supported" 瞬间失败、挂起,或杀掉父 cmd——时序实验抓到 guard 恰在 node 死 +4s 死,正是 timeout 失败点);(3) **最大根因:我用 edit/write 工具改 run.cmd 后文件变成 LF 行尾(无 CR)**——cmd.exe 需要 CRLF,LF 行尾下解析器随机并线/丢 token(实证:echo 行只建 0 字节文件、日志行丢失时间戳前缀、guard 各时点死),之前"守护死"全部由它解释 | ✅ 已修:run.cmd 重写为 **CRLF + 无 BOM + ASCII 注释**,延迟改 `ping -n 4 127.0.0.1 >nul`,并加双日志(`loop.log` 每次循环、`agent.log` node 全输出);任务 XML 经 dump→改 `StopOnIdleEnd=false`→重新导入(`schtasks /Create /XML` 只吃 schtasks 自己 dump 的基底文件,手写 XML 报 namespace 错;该构建的 TaskScheduler COM/cmdlet 均不可靠)。验证:任务环境下 agent 完整启动上线;精确 kill node → **3.06s 后自动重启并上线**(loop.log 实证) |

| 09/20 20:32 | 浏览器调用 20:32:23–43 双方持续 `frame dropped (kx not ready)` 刷屏,kx 握手 25s 未完成;consumer 15s `connect-timeout` 自动重试后二次失败;同代码 node e2e 17/17 全绿 | **陈旧页面(旧版协议 JS)混入新会话**:server 日志实锤 sess 房间有 **3 个 dc 成员**(agent+consumer+第三方),lst 房间也 3 成员——第三方是未刷新旧 tab(其日志字符串只存在于 9/16 的 dist bundle:WebRTC/SDP 时代代码,dc 先于 signal 房间 join、kx 对象可能永不建立)。第三方从 offer 广播里学到新 sessionId 后自动加入新 sess 房间,其 kx-a 与 agent 的 kx-a 交替到达 → 双方 KxSession 的 `peerEpk` 被反复"换钥重置",握手永远完不成 | ✅ 三重修:① server `/dc` 与 `/signal` 的 `sess:` 房间强制 **2 成员上限**,第三方加入被拒并记日志(`[dc] reject 3rd member …`);② `web/dist` 重建(9/16 旧 bundle 已删,防止再被加载);③ agent/web provider `finish()` 补清 `connectTimer`(bye 正常结束后的孤儿 "call ended" 日志)。验证:3 连接实测 C 被拒(1005)、e2e 复跑全绿 |

| 09/20 22:08 | 同一页面既当 provider(b923e6e4,自动恢复上线)又当 consumer、同一 G5h6 钱包自调用:双方 `frame dropped (kx not ready)` 刷屏,kx 25s 未完成;consumer 15s `connect-timeout`;用户反馈"点关闭对话还会自动打开" | **kx 协议本身无错**——新增 `server/test/selfcall-kx.test.js`(同进程 provider+consumer 同钱包,经真实 /dc 中继)213ms 握手成功,证明同钱包自调用在 node 侧完全正常。浏览器侧 server 日志显示 consumer 的 dc 加入了但 **signal sess 房间 join 缺失**(仅 provider 1 成员),指向浏览器页面跑的是**陈旧/未刷新的 JS**(与 20:32 同因:旧 tab 冻结或 Vite HMR 未生效)。另发现真实 UX bug:`closeCall` 未取消 `onError` 里挂起的自动重试 `setTimeout`,点关闭后 1.5s 内挂起的 `startCall` 会把对话重新打开 | ✅ 双修:① `Market.jsx` 加 `retryTimerRef` 跟踪自动重试定时器,`closeCall` 先 `clearTimeout` 再关会话(点关闭即真正停止,不再自动重开);② 新增同钱包自调用 kx 回归测试。待用户:关闭所有机器的旧 MeshLLM tab(尤其未重启的 .174),`https://192.168.2.108:5173` 新开 tab(Ctrl+Shift+R)重试;若仍失败,贴浏览器 DevTools Console + Network 的 WS 帧 |

| 09/22 19:38 | 浏览器 consumer 调 node agent provider(39d0ccac Qwen3.8-27B-ninfer):server 日志房间成员完全正常(lst=2、dc sess=2、无第 3 人拒绝),但双方持续 `frame dropped (kx not ready)` 刷屏,kx 25s 未完成;node 自调用/e2e 全绿,用户用其他软件直连模型正常 | **真凶:server `/dc` 中继把文本帧转成二进制帧**。`ws` 包把文本帧也交给 `Buffer`,旧代码 `peer.send(raw)`(raw 恒为 Buffer)一律按**二进制帧**转发。node 端收到二进制帧是 `Buffer`,`toText` 能解 → node 自调用测试绿;浏览器端收到二进制帧是 `Blob`,`toText` 里 `d instanceof Uint8Array` 为 false → `String(d)`=`"[object Blob]"` 不以 `kx:` 开头 → **所有 kx 帧被 consumer 丢弃**,握手永不完成。这解释了"node 绿、浏览器必挂、房间却正常"的全部矛盾 | ✅ 已修:`/dc` 中继按 `isBinary` **保真转发**——文本帧 `raw.toString('utf8')` 转回字符串再 send(保持文本帧),二进制帧原样 send Buffer。新增 `server/test/frametype.test.js` 用 `ws` 的 `isBinary` 标志验证文本/二进制帧各自保真(旧代码下文本帧 isBinary=true 会挂)。19/19 全绿。待用户:刷新浏览器 tab 重试 |

| 09/23 08:09 | 浏览器 consumer(ADWR)调 39d0ccac:多轮对话进行到第 3 轮后 `dc-dead: 数据通道已断开(连续 15 秒无任何响应)`,托管被取消(无结算);用户反馈"模型正常但报错"。另:空闲时 listing 显示"在线用户 1/2",有人调用时"2/2"(计数虚高 1) | **两个独立 bug**:(1) **provider 的 ping 被长生成阻塞**——provider 所有帧(含 ping)串行进 `frameChain`,而 `prompt` 帧 `await runBackend` 占住帧链整个生成期(实测 136s),期间到达的 ping 被排队无法及时回 pong;模型"思考"阶段(首 token 前长 prefill)无 token 流,consumer 每 5s 的 ping 看门狗连续 3 次(15s)无 pong/token → 误判 `dc-dead` 杀掉正常通话。(2) **"在线用户"虚高**——activeUsers 统计所有 IN_CALL/SETTLE_WINDOW 托管行,而 .174 钱包(6ijV)有一行 IN_CALL 孤儿卡了 **833 分钟(12h+)**(跨机崩溃残留,`beginCall` 惰性释放只在下次调用时触发,无人调用就永久卡住)→ 空闲计 1、新调用计 2 | ✅ 三修:① provider **ping 带外处理**——`onFrame` 里 ping 帧立即解密回 pong、不进串行帧链(业务帧仍走帧链保序),长生成期间也能即时回 pong;② consumer 看门狗 15s→**30s**(`pingsOut>=6`),覆盖思考阶段+后台标签页节流余量;③ activeUsers 只统计**未超协议时限**的行(IN_CALL 未超 callTimeoutSec=30min、SETTLE_WINDOW 未超结算窗口)+ server 每 60s **周期清理**释放超时孤儿 IN_CALL 行(启动即释放 11 行陈旧孤儿,含 .174 那行)。验证:39d0ccac 空闲 activeUsers=0;24/24 测试全绿。**结算核对**:中断那笔(1689be94)无结算——调用历史末两条为 cancel,ADWR 行回 EMPTY,资金释放回可用余额,无资金划转 |

| 09/25 14:5x | 上线前自查测试红: P3 全额退款决议 provider 押金未被划扣(回归测试断言期望 100M-FUND、实际 100M)——同缺陷潜伏于线上: 全额退款争议决议中 provider 押金不扣、败诉误记 0 | 陈旧读取: `resolve()` 先 `updateEscrow` 将 `e.dispute` 原地置 null(同一对象引用),又在全额退款分支重读 `row0?.dispute?.frozenRaw || 0` → `frozen` 恒 0 → `frozen > 0` 恒 false,auto slash 永不触发;525 行注释已声明"update 前捕获 frozenRaw0"却从未使用 | ✅ 修: 全额退款分支改用 update 前捕获的 `frozenRaw0`;server 套件 23/23、shared 13/13 全绿;server 已重启加载修复,在线冒烟 14/14,agent 真实 listing 恢复 online=true;P3 全额/部分裁决回归通过 |

**不变教训**:所有静默失败路径已加日志(rtc 状态、dc close、ping 判死),
下次任何失败,事件日志会给出精确断点。

**本机运维备忘**(09/20 实测):
- `Win32_Process.CommandLine` 经 CIM 查询**时灵时不灵**(常返回 null)——
  找进程改用 `CreationDate` + `ParentProcessId` 关系,勿依赖命令行正则。
- 本机构建上 `schtasks /Create /XML` 拒绝手写 XML(namespace 错),
  TaskScheduler COM 的 `RegisterTaskDefinition`/cmdlet 均不可靠——
  改任务设置一律 **dump 基底 XML → 编辑 → 删除 → 重新导入**。
- `wevtutil sl` 可启用 TaskScheduler/Operational 日志(默认空),
  事件 200/201/129 给出 action 启动/返回码/进程 PID。
- 用 write/edit 工具写 .cmd 必须随后校验 **CRLF + 无 BOM**
  (LF 行尾会随机破坏 cmd 解析)。

### 3.4 计价与分账(09/19 晚,已实现)

按用户要求:发送/接收/缓存命中**分别计费**,每笔交易抽 5% 平台费
(维护 1% + 售后保障基金 2% + 推广提成 2%),Provider 实收 95%。

- `shared/protocol.js`:`calcAmountRaw(price, in, out, cache=0)` 缓存按
  `per1kCacheRaw` 计费(缺省=输入价);回执规范化载荷加 `tokensCache`
  (旧回执两侧都归零,digest 不变);新增 `FEE_SPLIT`/`splitFees`
  (各桶 floor,余数归 provider,吸收微-USDT 舍入)。
- `web/session.js`:SSE 请求带 `stream_options.include_usage`;
  `sseDeltas` 捕获流尾 `usage`;缓存命中取
  `prompt_tokens_details.cached_tokens`(OpenAI)或
  `cache_read_input_tokens`(Anthropic),不报 → 0;
  provider 回执上报 `tokensCache`,consumer 校验上限(≤ 本地估算输入×1+容差)。
- `server/escrow.js`:settleFast / settleWindow / resolve 全部按
  tokensCache 重算金额后 `splitFees` 分账;provider 实收 95% 入账,
  5% 累计进 `store.platform` 平台账本;call 日志记 fee 明细。
- UI:ProviderPanel 发布表单加「每 1k 缓存命中」价(留空=输入同价);
  Market 列表卡三段价、回执卡显示缓存命中+分账预览+结算后分账明细;
  EscrowPanel 回执行加缓存数、交易行加分账、头部显示平台费用账本;
  新端点 `GET /platform/fees`。
- 测试:protocol 9/9、server escrow 11/11(含缓存计费、分账断言)。
- **10/20 计费口径修正**:provider 回执的 `tokensIn/tokensOut` 改为**优先后端
  上报的真实 usage**(OpenAI `prompt_tokens/completion_tokens`,Anthropic
  `input_tokens/output_tokens`),拿不到才回退 chars/4 估算(`usageTokensOf`)。
  原因:估算对中文严重偏低(1 字≈1 token,估算按 4 字符/token,系统性少收 4~6 倍)。
  同时 consumer 侧校验从「与自身估算 ±5% 双向比对」改为**单边上限**
  (`checkMeteringBounds`,上限 = 字符数 × 2 + 每消息 16 token):
  真实用量必然落在旧容差外,不改会误杀正确回执。`transcriptHash` 仍严格校验
  (防伪造对话);token 精确值客户端无法验证,provider 可信度靠押金+信誉+争议兜底。
  回执新增 `meteringSource`(usage/estimate/mixed,不进签名摘要)供审计。
- 注意:后端不支持 `include_usage`(或 Anthropic 不回 usage)时自动回退估算;
  缓存数始终取后端真值,不报则为 0(按普通输入计费)。

### 3.5 多轮连续对话(09/19 晚,已实现)

之前每次调用只能发一条提示词、收完即出回执关连接,不能连续对话。
现改为:一次 call(一条 WebRTC 连接 + 一份托管)内可多轮追问,
点「结束对话并结算」才出**覆盖全轮累计量**的最终回执并双签结算。

- 协议零破坏:回执 schema 不变,`tokensIn/tokensOut` = 各轮**累计**、
  `transcriptHash` 覆盖整段历史,所以 escrow/结算/分账逻辑完全不用改。
- `shared/protocol.js`:新增 `turnInputEstimate(messages)` —— 第 i 轮输入估算
  = 该轮发给后端的全部历史(每条消息内容)之和(后端每轮重放整段上下文,
  真实扣费同阶)。provider 累计与 consumer 复算必须用同一函数同序列。
- `web/session.js`:
  - `runBackend({listing, messages, ...})` 改收完整历史 `messages`(echo 取末条)。
  - provider `handleBusiness`:call 增加 `history/tokensIn/tokensOut/tokensCache/
    busy/params`;每轮 prompt 追加历史、发后端、流式、累估算;
    收 `{t:'end'}` 才 `sendFinalReceipt` 后关。轮结束发 `done` 但**不**关连接。
  - consumer:`turns[]` 记每轮;`sendPrompt` 可重复(单轮 in-flight 互斥);
    新增 `endConversation()` 发 `{t:'end'}`;`verifyReceipt` 按 turns 重建历史
    并累计估算;ping 判死条件从 `reply` 改为 `turnOpen`(多轮 reply 恒非空)。
- `web/pages/Market.jsx`:会话卡按轮渲染「你/模型」;turn-done 时出现
  「结束对话并结算」+「追加托管」(多轮累计可能超初始充值);
  输入框占位符随轮数变化;回执卡显示轮次。
- `server/config.js`:`callTimeoutSec` 默认 300→**1800**(多轮调用可数分钟,
  只放宽服务端孤儿 IN_CALL 释放阈值;consumer 单轮 300s 超时仍即时)。
- 测试:protocol 13/13(新增 turnInputEstimate + 多轮回执两侧一致)、
  server escrow 14/14(含 SETTLED 归档回归)。

## 4. 路线图

### P0 —— 打通并验证(本周,当前焦点)

1. ~~**首个端到端调用(同机)**~~ ✅ **已达成(09/19 05:01)**:.108 浏览器 →
   GSQ(.208 relay)→ 流式输出 → 回执验证(1 入/6 出)→「接受并结算(双签)」→
   data.json `SETTLED` 行 + `sim-26f075f372a983b3`。分账 provider 95 / 平台 5
   (维护1/售后2/推广2)落账,平台费用账本累计 5 微-USDT。
2. ~~**首个跨机 P2P 调用**~~ ✅ **已达成(09/19 05:38)**:.174(6ijV)→ .108
   provider → GSQ(.208 relay)流式 → 回执校验(1 入/4 出)→ 双签 → SETTLED
   (call 1789767483)。真实跨机 WebRTC UDP 已验证。
3. 清理遗留 IN_CALL 冻结行(51cc07be、6ijV|GSQ、6ijV|新模型;下次再调用自动释放)。
4. ~~**tlvip listings**~~ ✅ **已达成(09/19)**:用户重填 key 后 06:47/06:48 两笔
   跨机调用成功(新 listing 3b0e297a、23edffab);11:05–11:07 又完成两笔多轮调用
   并双签结算。旧 listing 0538065c、36fc1529 余额很小,留作备用。

### P1 —— 节点实体化与健壮性(1–2 周)

1. ~~**可观测性**~~ ✅ **已实现(10/3 前端收尾,此前已落地)**:server 全局 HTTP
   请求日志(middleware:method/path/status/耗时,跳过 /health 轮询噪音) + `/relay`
   处理器内专用上游状态 + 流式字节日志;数据面 DC 帧统计(每会话持久化
   `dcEvents:<sessionId>` 环限 400 条,含 kx 帧计数 / 业务密文帧计数 + 成员级
   帧数/字节数/duration);调用时间线 UI(`Market` 会话卡 + `EscrowPanel` 托管行
   均接 `/escrows/conversation` 的 `CallTimeline`,自动轮询刷新);事件日志导出
   (`GET /me/calls/export` → JSON 下载,含全部会话 + 各自 dc 统计)。
2. **失败自愈**:dc-dead 后自动重连重试(保持 escrow 不变);
   provider 掉线自动从目录摘除(已有 presence TTL,补 UI 提示)。
3. **NAT 穿透**:coturn(TURN 服务器)接入 iceServers;
   或数据面 WS relay 模式(E2EE 保持,server 只转发密文)。
4. **会话体验**:登录 30 分钟过期后免密恢复(localStorage 刷新 token),
   agent 不因刷新页面而中断。
5. ~~**多轮连续对话**~~ ✅ **已实现并 .174 实测(09/19 晚)**:一次 call 多轮追问,
   「结束对话并结算」出全轮累计回执(见 3.5)。11:05–11:07 实测:2 轮 + 3 轮两次调用,
   回执校验通过(8 入/60 出、89 入/146 出),双双双签 SETTLED;第 2 次发起时自动归档
   第 1 次结算行并结转计数(calls=2)。

### P2 —— 真实链上(devnet → mainnet)

1. Anchor `mesh-escrow` 程序:devnet 部署(占位符 `MESH_E1_REPLACE_AFTER_ANCHOR_DEPLOY`),
   settleMode=devnet 走真实 USDT/USDC 转账 + 程序托管。
   - ✅ **09/25 程序代码完成 anchor 0.30 API 迁移并 `cargo check` 全绿**(MSVC 工具链):
     `associated_token::mint/authority` 命名空间约束语法、`listing_id` 改 `UncheckedAccount`
     (seeds 用 `.key().as_ref()`)、`Signer`+`#[account(mut)]` 替代不存在的 `MutSigner`、
     `token::transfer(cpi_ctx, amount)` 双参签名、`CpiContext` 显式 `token_program`、
     `init` 账户补 `system_program`/`associated_token_program` 字段、
     `get_associated_token_address(&pk, &mint)` 引用、seeds 临时量借用修复。
   - ⏳ 待办:`anchor build`(需 anchor-cli 或 `cargo build-bpf` 目标)→ devnet 部署 →
     回填真实 program id 到 `declare_id!` 与 `MESH_PROGRAM_ID`。**阻塞:无已注资 devnet
     账户(需 ~0.6 SOL 的 keypair)**。
2. 链上回执:结算凭证从模拟签名升级为链上交易引用。
3. USDC 备选结算路径、跨币手续费。

### P3 —— 产品化

1. ✅ **Provider 信誉/评分 + 违约罚没(09/25)**:`escrow.js` 新增 `noteProviderEvent`/
   `providerReputation`(store key `providerRep`,计数 call/settled/dispute/disputeLost +
   refundedRaw);`resolve()` 全额退款(payRaw=0,provider 败诉)自动 slash 冻结额押金
   (封顶余额,`by:'auto'` 记入 listing 调用日志),部分退款不 slash。
   服务端 API:`GET /providers/reputation`(settleRate/disputeLossRate)、
   `GET /me/calls`(消费者按 listing 聚合的调用史)、`GET /listings` 支持
   `q` 搜索 + `sort`(price|rating|latency|tps|calls)+ 返回 `revenueRaw`/`providerRep`。
   回归:escrow 套件 16/16(含 3 个 P3 新测试)。
2. ✅ **Consumer 仪表盘(10/3 前端接入)**:消费明细、token 成本、历史回执。`EscrowPanel.jsx`
   新增「消费仪表盘(我的调用)」表,接后端 `GET /me/calls`(按 consumer/listing 聚合),
   列模型/状态/调用数/结算/退款/上次回执(入·缓存·出)/最近事件/最后结算金额与 txId。
   后端端点此前已就绪,本次补前端。
3. ✅ **Provider 仪表盘(10/3 前端接入)**:收入、并发利用率、调用质量。`loadMine` 改拉
   `/listings?...&stats=1`(返回 `revenueRaw/totalCalls/activeUsers/providerRep`)；
   `ProviderPanel.jsx` 新增「收入与质量仪表盘」表:模型 + 结算率(优/中/差徽章,
   settleRate 分档)、累计结算(我实收 95%)、调用次数、当前在线用户(带并发上限
   `activeUsers/maxConcurrent`)、争议/败诉数(带 tooltip 明细:结算/调用/争议/败诉)。
   后端端点此前已就绪,本次补前端。
4. ✅ **目录搜索/筛选/排序前端控件(10/3 搜索框接入)**:市场页新增搜索框,经后端
   `q` 参数走服务端过滤(对模型名/后端 URL/provider 做不区分大小写子串匹配),
   `load` 依赖 `searchQ` 自动重拉目录。排序下拉(`latency|tps|price|load|recent`)
   此前已存在。⏳ 剩余子项——**模型元数据**(名称/上下文长度/实测速度)展示待接。
5. ✅ **无头 Node Provider Agent(方案 C)**:已交付并实机上线
   (`agent/` 目录,WS `/dc` 数据面,kx 协议与浏览器版同一套 shared 代码)。
   自启:`schtasks` 任务 `MeshLLM-ProviderAgent`(ONLOGON)+ `agent/run.cmd`
   崩溃自动重启循环。实测:真实 tlvip 后端流式回复 → 回执验签 → 双签 SETTLED。
   后续可选:systemd/launchd 等价物(Linux/macOS)、容器化。
6. mainnet 迁移 + 真实 USDT

## 5. 运维手册

### 端口与进程

| 端口 | 服务 | 绑定 | 重启方式 |
|---|---|---|---|
| 4011 | server(REST+WSS) | 0.0.0.0(MESH_HOST 可改) | **改代码后必须手动重启** |
| 5173 | Vite dev(web) | 0.0.0.0 | 代码 HMR;vite.config 改动自动重启 |
| — | agent(方案 C 守护进程,无端口) | — | `agent/run.cmd` 循环自动重启;开机自启任务 `MeshLLM-ProviderAgent`(ONLOGON);**改 agent 代码后需 kill 旧进程**(3s 内自动拉起新版) |

**HTTPS(自签证书)**:两个端口都走 HTTPS/WSS,共用 `server/tls/{key,cert}.pem`
(由 `node server/scripts/gen-cert.mjs` 生成,有效期 ~2.25 年)。
这是硬性要求:浏览器经局域网 IP 打开明文 HTTP 页面不是安全上下文,
`crypto.subtle`(listing hash / E2EE / 回执签名依赖)不可用。
每台机器首访需在证书警告页手动"高级 → 继续访问"信任一次。
URL:本机 `https://127.0.0.1:5173` / `https://127.0.0.1:4011`;
局域网 `https://192.168.2.108:5173` / `https://192.168.2.108:4011`。

**服务启动与自启(10/3 实测,重启后打不开根因)**:
- 平台 `.108` 为**多网卡机**同时持有 `192.168.2.1` 与 `192.168.2.108`,
  故访问 `.108:5173` 是**正确**地址;重启后打不开的真正根因不是 IP 变了,
  而是 **web(:5173) 与 server(:4011) 都没起**——它们靠手动在终端跑
  `npm run dev` 拉起,终端一关或机器一重启就全消失(实测 4011/5173
  均 `ECONNREFUSED`)。只有 agent(方案 C)有 ONLOGON 计划任务自启。
- 启动方式(任一):
  - 双击 `D:\deepseek-worker\ai-compute-mesh\launch-mesh.bat`
    (已改用系统 npm 绝对路径 `C:\Program Files\nodejs\npm.cmd run dev`,
     日志写 `C:\Users\Administrator\.workbuddy-ai\memory\meshllm-launch.log`,
     带 4011 幂等保护:已在监听则跳过)
  - 或终端 `cd D:\deepseek-worker\ai-compute-mesh && npm run dev`
- 若想要"开机自动起":在**任务计划程序**新建任务 → 触发器"登录时" →
  操作"开始程序" `C:\Program Files\nodejs\npm.cmd` → 参数
  `run dev` → 起始于/工作目录 `D:\deepseek-worker\ai-compute-mesh`
  (或改为运行 `launch-mesh.bat`),用户选 Administrator,Run level 常规。

**钱包迁移**:Demo 钱包密钥存于浏览器 `localStorage['meshllm-demo-key-v1']`
(JSON 字节数组)。换机器 / 换端口协议(http→https)/ 浏览器重装后,
用登录页「导入 Demo 钱包密钥」按钮把旧值粘过来,钱包地址不变。

### 防火墙(已配置,可回滚)

- .108 Windows:4011/5173 入站,仅 192.168.2.0/24
- .174 ufw:10000:65535/udp+tcp(WebRTC)、5173/4011 tcp 自 /24

### 节点访问

| 机器 | 用途 | 访问 |
|---|---|---|
| 192.168.2.108 | 平台主机 | Windows,本工作目录 |
| 192.168.2.208 | LM Studio(GSQ :8001,FP8 :8000) | 用户机器 |
| 192.168.2.174 | 备用算力节点 | SSH worker3/worker3(Ubuntu 22.04) |

### 常用命令

```bash
# 测试(server/ 下)
node --test
# E2EE 测试(仓库根)
node --test shared/test/e2ee.test.js
# server
cd server && node src/index.js
# web
cd web && npx vite
```

### 关键参数

会话 TTL 30min;presence TTL 120s;escrow 结算窗口 60s;调用超时 300s;
押金 100 USDT;测试钱包入账 100 USDT。

### 注意事项

- HMR 不重启已运行的 agent 实例:改 agent 相关代码后,运行中的页面需**硬刷新(Ctrl+F5)**。
- 浏览器后台节流:5s 心跳 + visibilitychange 即时补心跳,120s TTL 足够;
  页面彻底关闭则 agent 离线(pagehide beacon 已处理)。
- server 数据在 `server/data.json`(勿手改 escrow 状态,用 API)。

## 6. 关键文件

| 文件 | 职责 |
|---|---|
| `server/src/index.js` | REST + 信令 WS + 挂载各模块 |
| `server/src/escrow.js` | 托管状态机(模拟账本) |
| `server/src/config.js` | 全部可配置项(MESH_* 环境变量) |
| `shared/src/e2ee.js` | P-256 kx / HKDF / AES-256-GCM 帧 |
| `web/src/webrtc.js` | PC/ICE/DataChannel + 健壮性判死 |
| `web/src/session.js` | KxSession + consumer/provider 编排器 |
| `web/src/signal.js` | 信令 WS 客户端(自动重连) |
| `web/src/wallet.js` | Phantom / Demo 钱包 |
| `web/src/api.js` | API 客户端(地址跟随页面主机) |
| `web/src/pages/*.jsx` | Market / ProviderPanel / 结算 |
