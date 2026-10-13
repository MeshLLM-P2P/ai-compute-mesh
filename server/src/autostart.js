// 开机自启(Windows 启动文件夹)与 agent config.json 的读写。
// 设计要点:
//  - config.json 是 agent 唯一的配置文件,网页配置页只做"读 + 受控写",
//    未知字段保留(合并写),避免把用户手写的字段抹掉。
//  - 开机自启生成到 Windows 启动文件夹(shell:startup)。生成脚本里的 node
//    用当前进程的二进制绝对路径(process.execPath),不依赖 PATH。
//  - 启动文件夹在沙箱外,可能不可写:此时接口仍返回生成的脚本内容,
//    网页可以下载/复制让用户手工放置,而不是直接失败。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { HttpError } from './directory.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverRoot = path.join(here, '..')       // server/
const projectRoot = path.join(serverRoot, '..') // ai-compute-mesh/

export const AGENT_CONFIG_PATH = path.join(projectRoot, 'agent', 'config.json')
const SCRIPT_BASE = 'MeshLLM-autostart'

// agent 里 caCert / wallet 都是相对 agent/ 的路径,这里给出默认值供网页自动填充
export const AGENT_DEFAULTS = {
  server: '127.0.0.1:4011',
  tls: true,
  caCert: '../server/tls/cert.pem',
  wallet: './wallet.json',
  listings: [],
  heartbeatSec: 30,
  probeSec: 30,
  probeFailThreshold: 2,
}

const KNOWN_KEYS = [
  'server',
  'tls',
  'caCert',
  'wallet',
  'listings',
  'heartbeatSec',
  'probeSec',
  'probeFailThreshold',
]

export function readAgentConfig(target = AGENT_CONFIG_PATH) {
  try {
    if (!fs.existsSync(target)) return null
    return JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch (e) {
    if (e instanceof HttpError) throw e
    const err = new Error('config.json 解析失败: ' + e.message)
    err.status = 500
    throw err
  }
}

// target 可注入(测试用临时文件);默认写 agent/config.json
export function writeAgentConfig(patch, target = AGENT_CONFIG_PATH) {
  const existing = readAgentConfig(target) || {}
  const merged = { ...existing }
  for (const k of KNOWN_KEYS) if (patch[k] !== undefined) merged[k] = patch[k]

  if (merged.tls !== undefined) merged.tls = merged.tls === true || merged.tls === 'true'
  if (typeof merged.server !== 'string' || !merged.server.trim())
    throw new HttpError(400, 'server 不能为空(host:port)')
  if (!Array.isArray(merged.listings)) throw new HttpError(400, 'listings 必须是数组')
  for (const e of merged.listings) {
    if (!e || typeof e.listingId !== 'string' || !e.listingId.trim())
      throw new HttpError(400, 'listings 每一项都需要 listingId')
  }
  for (const k of ['heartbeatSec', 'probeSec', 'probeFailThreshold']) {
    if (merged[k] === undefined) continue
    // 网页表单传来的是字符串,这里统一归一为正整数
    const n = Number(merged[k])
    if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, k + ' 必须是正数')
    merged[k] = Math.round(n)
  }

  fs.writeFileSync(AGENT_CONFIG_PATH, JSON.stringify(merged, null, 2))
  return merged
}

function startupDir() {
  if (process.platform !== 'win32') return null
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}

// 生成脚本内容。node 用当前进程的二进制绝对路径(自动填充,不依赖 PATH)。
// 统一先生成一份 bat(用绝对 node 路径,不依赖 PATH),再按显示方式决定:
//   - 可见窗口:直接写这份 bat
//   - 后台隐藏:写一个 VBS,隐藏窗口调用同一份 bat
// Agent 走 run.cmd(崩溃自动重启循环);server 用普通启动(开机场景不需要 --watch)。
// 路径含空格(如 "C:\Program Files\nodejs\node.exe")必须加引号,否则 cmd /c 会截断。
function q(s) {
  return '"' + String(s).replace(/"/g, '""') + '"'
}

// VBS 字符串字面量:内部双引号写成两个双引号
function vq(s) {
  return '"' + String(s).replace(/"/g, '""') + '"'
}

function buildRunner({ startServer = true, startAgent = true, nodePath }) {
  const node = nodePath || process.execPath
  const serverEntry = path.join(projectRoot, 'server', 'src', 'index.js')
  const agentEntry = path.join(projectRoot, 'agent', 'src', 'index.js')
  const lines = [
    '@echo off',
    'rem MeshLLM 开机自启(由网页配置页生成 ' + new Date().toISOString() + ')',
    'cd /d ' + q(projectRoot),
  ]
  if (startServer) lines.push('start "" /min ' + q(node) + ' ' + q(serverEntry))
  if (startAgent) {
    // 自带崩溃重启循环(等价 agent/run.cmd),但用绝对 node 路径,不依赖 PATH。
    // 日志与 run.cmd 一致落到 agent/agent.log,便于排查开机竞态。
    const logFile = path.join(projectRoot, 'agent', 'agent.log')
    lines.push(':loop')
    lines.push(q(node) + ' ' + q(agentEntry) + ' >> ' + q(logFile) + ' 2>&1')
    lines.push('ping -n 4 127.0.0.1 >nul')
    lines.push('goto loop')
  }
  return lines.join('\n')
}

export function buildScript({ startServer = true, startAgent = true, hidden = false, nodePath }) {
  const runner = buildRunner({ startServer, startAgent, nodePath })
  if (!hidden) return runner
  const runnerPath = path.join(startupDir(), SCRIPT_BASE + '.bat')
  return [
    "' MeshLLM 开机自启(由网页配置页生成 " + new Date().toISOString() + ')',
    'CreateObject("WScript.Shell").Run ' + vq(runnerPath) + ', 0, True',
  ].join('\n')
}

export function autostartStatus() {
  const dir = startupDir()
  if (!dir) return { platform: process.platform, supported: false, enabled: false, dir: null }
  const bat = path.join(dir, SCRIPT_BASE + '.bat')
  const vbs = path.join(dir, SCRIPT_BASE + '.vbs')
  // 隐藏模式 = vbs 启动器 + bat 执行体;可见模式 = 只有 bat
  const hit = fs.existsSync(vbs) ? vbs : fs.existsSync(bat) ? bat : null
  return {
    platform: process.platform,
    supported: true,
    enabled: !!hit,
    hidden: fs.existsSync(vbs),
    dir,
    file: hit,
    script: hit ? fs.readFileSync(hit, 'utf8') : null,
  }
}

export function applyAutostart({ enable, startServer, startAgent, hidden, nodePath }) {
  const dir = startupDir()
  if (!dir) return { supported: false, enabled: false, script: buildScript({ startServer, startAgent, hidden, nodePath }) }
  const bat = path.join(dir, SCRIPT_BASE + '.bat')
  const vbs = path.join(dir, SCRIPT_BASE + '.vbs')
  if (!enable) {
    for (const f of [bat, vbs]) if (fs.existsSync(f)) fs.unlinkSync(f)
    return { supported: true, enabled: false, dir }
  }
  if (!startServer && !startAgent) throw new HttpError(400, '至少要勾选一项要开机启动(服务或 Agent)')
  fs.mkdirSync(dir, { recursive: true })
  // 执行体始终是 bat(绝对 node 路径,不依赖 PATH)
  fs.writeFileSync(bat, buildScript({ startServer, startAgent, hidden: false, nodePath }))
  if (hidden) {
    fs.writeFileSync(vbs, [
      "' MeshLLM 开机自启(由网页配置页生成 " + new Date().toISOString() + ')',
      'CreateObject("WScript.Shell").Run ' + vq(bat) + ', 0, True',
    ].join('\n'))
    return { supported: true, enabled: true, hidden: true, dir, file: vbs, script: fs.readFileSync(vbs, 'utf8') }
  }
  if (fs.existsSync(vbs)) fs.unlinkSync(vbs)
  return { supported: true, enabled: true, hidden: false, dir, file: bat, script: fs.readFileSync(bat, 'utf8') }
}

export const PROJECT_ROOT = projectRoot