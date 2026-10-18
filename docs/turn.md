# TURN 部署(跨网段直连)

## 为什么需要

MeshLLM 的数据面走 WebRTC DataChannel:

- **同机 / 同网段**:STUN 打洞即可直连,数据面完全不经服务器。
- **跨网段(不同 NAT)**:STUN 能打通,但 NAT 映射保不住 —— 实测约 **5 秒**
  后 ICE consent 检查失败,连接被判死。所以没有 TURN 时,跨网段调用会自动
  降级为 `/dc` 中转(仍然 E2EE,但多一跳)。

配好 TURN 后,跨网段会自动切回「直连优先、失败才降级」。

> TURN 只中继 ICE/DTLS 流量,**端到端加密不变** —— TURN 服务器看到的只是密文。

## 两种部署方式

| 方式 | 适用 | 代价 |
|---|---|---|
| **A. 内置纯 JS TURN**(`turn/`) | 没有 Docker 的 Windows 机器、局域网联调 | 需要 Node.js;无 TLS 端点;中继端口段固定 |
| **B. coturn** | 公网 VPS、生产 | 需要 Docker 或 Linux 包管理;协议能力最全 |

---

## A. 内置纯 JS TURN(无 Docker)

仓库自带 `turn/`,基于 `turn-server`(纯 JS 实现 RFC 8489/8656),不依赖
Docker、不依赖 coturn 二进制,浏览器侧与 coturn 无差别。

### 起服务

Windows 双击或命令行:

```bat
turn\start-turn.bat
```

跨平台:

```bash
npm install --prefix turn        # 首次
npm run turn                     # 或 node turn/server.mjs
```

默认监听 **3478(UDP+TCP)**,中继端口 **49160–49200**,凭据
`meshllm / meshllm-devnet`。

### 自检

```bash
npm run turn:selftest
```

四项全过才算真的能用:

```
PASS  正确凭据能分配中继  — 192.168.2.108:49183
PASS  中继端口在配置范围内  — 实际 49183,期望 49160-49200
PASS  数据经中继往返  — 收到 "echo:meshllm-turn-selftest"
PASS  错误凭据被拒绝  — 未获分配
```

它不只是探测端口 —— 真的做了一次 ALLOCATE、真的让数据经中继往返、
也真的验证了错误凭据拿不到中继(否则中转带宽就是白送的)。

### 可调参数(环境变量)

| 变量 | 默认 | 说明 |
|---|---|---|
| `MESH_TURN_PORT` | 3478 | 监听端口(UDP+TCP 同端口) |
| `MESH_TURN_REALM` | meshllm | 认证域 |
| `MESH_TURN_USERNAME` / `MESH_TURN_CREDENTIAL` | meshllm / meshllm-devnet | 静态凭据 |
| `MESH_TURN_RELAY_MIN` / `_MAX` | 49160 / 49200 | 中继端口段(做端口映射时要对上) |
| `MESH_TURN_EXTERNAL_IP` | 空 | **在 NAT 后必填**,否则下发的中继地址是内网地址 |
| `MESH_TURN_ALLOW_PRIVATE` | 1 | 允许中继到私网 peer。**局域网联调必须开** |
| `MESH_TURN_ALLOW_LOOPBACK` | 0 | 允许中继到 127.0.0.1。默认关(CVE-2020-26262) |
| `MESH_TURN_ALLOW_TCP_RELAY` | 0 | RFC 6062 TCP 中继,一般不用 |

---

## B. coturn(Docker / 公网 VPS)

```yaml
# docker-compose.yml
services:
  coturn:
    image: coturn/coturn:latest
    network_mode: host          # 需要 UDP 端口段,host 模式最省事
    restart: unless-stopped
    command:
      - --listening-port=3478
      - --tls-listening-port=5349
      - --fingerprint
      - --lt-cred-mech
      - --user=mesh:S3CRET_CHANGE_ME
      - --realm=meshllm
      - --min-port=49160
      - --max-port=49200
      - --no-cli
      - --no-multicast-peers
      - --log-file=stdout
```

```bash
docker compose up -d
```

自检:

```bash
turnutils_uclient -u mesh -w S3CRET_CHANGE_ME turn.example.com
```

---

## 让 MeshLLM 用上它

**推荐:写进 `server/.env`**(已在 `.gitignore` 中,不进仓库,机器相关配置
不该出现在通用启动器里):

```bash
# server/.env
MESH_TURN_URLS=turn:192.168.2.108:3478?transport=udp,turn:192.168.2.108:3478?transport=tcp
MESH_TURN_USERNAME=meshllm
MESH_TURN_CREDENTIAL=meshllm-devnet
```

改完重启 server(`npm run dev` 下改动 `server/src/*` 会自动重启,但 `.env`
是启动时读的 —— 改动 `.env` 本身需要重启进程)。

也可以继续用命令行环境变量(优先级高于 `.env`,便于临时覆盖):

```bash
MESH_TURN_URLS="turn:turn.example.com:3478?transport=udp" \
MESH_TURN_USERNAME="mesh" \
MESH_TURN_CREDENTIAL="S3CRET_CHANGE_ME" npm run dev
```

可选:自建 STUN(默认用 Google 公共 STUN)

```bash
MESH_STUN_URLS="stun:turn.example.com:3478"
```

### 跨网段前提(重要)

TURN 地址必须是**对端浏览器能访问到的地址**:

- 两台机器同网段 → 填内网 IP 即可(如 `192.168.2.108`)。
- 跨网段 → 需要公网 IP + 路由器端口映射,并在 TURN 侧设
  `MESH_TURN_EXTERNAL_IP`:

| 端口 | 协议 | 用途 |
|---|---|---|
| 3478 | UDP + TCP | TURN |
| 5349 | TCP | TURN over TLS(coturn) |
| 49160–49200 | UDP | 中继端口段 |

云服务器还需在安全组里放行同样的端口。**没做映射时,内网 TURN 只对同网段
有效** —— 跨网段调用仍会自动降级为 `/dc` 中转(功能不受影响,只是多一跳)。

## 验证

1. 打开页面 →「配置中心」→ 第 6 区「ICE / TURN」
   - 显示 **TURN 已启用(跨网段直连优先)** = 生效
   - 显示 **仅 STUN** = 没读到配置(检查 `.env` / 环境变量是否传到了 server 进程)
2. 直接查接口(最可靠):

   ```bash
   curl -sk --noproxy '*' https://127.0.0.1:4011/ice
   # 匿名: {"hasTurn":false,"turnConfigured":true}
   # 带 x-mesh-session 再请求:{"hasTurn":true,"iceServers":[...,{"urls":["turn:..."],"username":"...","credential":"..."}]}
   ```

   `turnConfigured:true` + `hasTurn:false` 是**正确**的匿名表现:
   TURN 配了,但凭据只发给已登录会话。
3. 跨网段调用一次,事件日志里应是:

   ```
   offer sent (transport=rtc,relay),等待 provider accept…
   provider 支持直连,建立 WebRTC 数据通道…
   rtc: rtc connected (direct data channel)
   ```

   而不是 `跨网段调用:直接使用 /dc 中转通道`。
4. 若直连建立后又掉线,日志会打印 `rtc: pc state=disconnected/failed` 与
   `rtc: dc closed (code=…)` —— 说明 TURN 没分配成功(检查凭据/端口段/防火墙)。

## 安全提示

- `/ice` 只在**已登录会话**下下发 TURN 凭据(匿名请求只给 STUN),避免白嫖带宽。
- 内置 TURN 默认拒绝回环 peer(`MESH_TURN_ALLOW_LOOPBACK=0`),防止被当作
  访问本机服务的跳板(CVE-2020-26262);局域网联调才需要放开私网 peer。
- 生产环境建议用短期凭据(coturn `--use-auth-secret` / turn-server `auth.secret`
  的 TURN REST API 方式),当前内置服务用静态用户名/密码,devnet 够用。
