# TURN 部署(跨网段直连)

## 为什么需要

MeshLLM 的数据面走 WebRTC DataChannel:

- **同机 / 同网段**:STUN 打洞即可直连,数据面完全不经服务器。
- **跨网段(不同 NAT)**:STUN 能打通,但 NAT 映射保不住 —— 实测约 **5 秒**
  后 ICE consent 检查失败,连接被判死。所以没有 TURN 时,跨网段调用会自动
  降级为 `/dc` 中转(仍然 E2EE,但多一跳)。

配好 TURN 后,跨网段会自动切回「直连优先、失败才降级」。

> TURN 只中继 ICE/DTLS 流量,**端到端加密不变** —— TURN 服务器看到的只是密文。

## 1. 起一个 coturn

公网机器上(docker):

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

放行防火墙:

| 端口 | 协议 | 用途 |
|---|---|---|
| 3478 | UDP + TCP | TURN |
| 5349 | TCP | TURN over TLS |
| 49160–49200 | UDP | 中继端口段 |

云服务器还需在安全组里放行同样的端口。

自检(TURN 正常工作时应返回 `Relay` 候选):

```bash
turnutils_uclient -u mesh -w S3CRET_CHANGE_ME turn.example.com
```

## 2. 让 MeshLLM 用上它

在 server 启动前设置环境变量(Windows 用 `set` 或写进 `start.bat`):

```bash
MESH_TURN_URLS="turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349"
MESH_TURN_USERNAME="mesh"
MESH_TURN_CREDENTIAL="S3CRET_CHANGE_ME"
```

可选:自建 STUN(默认用 Google 公共 STUN)

```bash
MESH_STUN_URLS="stun:turn.example.com:3478"
```

重启 server 后生效。

## 3. 验证

1. 打开页面 →「配置中心」→ 第 6 区「ICE / TURN」
   - 显示 **TURN 已启用(跨网段直连优先)** = 生效
   - 显示 **仅 STUN** = 没读到配置(检查环境变量是否传到了 server 进程)
2. 跨网段调用一次,事件日志里应是:
   ```
   offer sent (transport=rtc,relay),等待 provider accept…
   provider 支持直连,建立 WebRTC 数据通道…
   rtc: rtc connected (direct data channel)
   ```
   而不是 `跨网段调用:直接使用 /dc 中转通道`。
3. 若直连建立后又掉线,日志会打印 `rtc: pc state=disconnected/failed` 与
   `rtc: dc closed (code=…)` —— 说明 TURN 没分配成功(检查凭据/端口段)。

## 4. 安全提示

- `/ice` 只在**已登录会话**下下发 TURN 凭据(匿名请求只给 STUN),避免白嫖带宽。
- 生产环境建议用 coturn 的 `--use-auth-secret` 短期凭据(每次调用临时生成),
  当前版本用静态用户名/密码,devnet 够用。
