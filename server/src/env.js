// 极简 .env 加载器(仅服务端启动时用)。
//
// 为什么需要:联调机要长期带一批 MESH_* 变量(TURN / 联邦 / 结算模式),
// 每次启动手写 set 不现实,而 start.bat 是跨机器分发的通用启动器,
// 不适合塞机器相关配置。放在 server/.env 里既不进仓库,也不影响别人。
//
// 规则(刻意保守,不实现 shell 语法):
//   - 空行与 # 开头为注释
//   - KEY=VALUE,以第一个 = 分隔
//   - 值两侧的单/双引号会被去掉
//   - **已存在的环境变量优先**:命令行或系统环境变量永远赢,
//     这样临时 MESH_TURN_URLS=xxx npm start 能覆盖 .env
//   - MESH_ENV_FILE 可指定别的文件;MESH_ENV_DISABLE=1 可整体关闭
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_ENV_FILE = path.join(path.dirname(here), '.env')

export function parseEnv(text) {
  const out = {}
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let val = line.slice(eq + 1).trim()
    if (val.length >= 2 && (val[0] === '"' || val[0] === "'") && val[val.length - 1] === val[0]) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

// 返回实际加载的键数量(0 表示没有文件或文件为空)
export function loadEnvFile(file = process.env.MESH_ENV_FILE || DEFAULT_ENV_FILE) {
  if (process.env.MESH_ENV_DISABLE === '1') return 0
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return 0
  }
  const vars = parseEnv(text)
  let applied = 0
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] === undefined) {
      process.env[k] = v
      applied++
    }
  }
  return applied
}

// 作为副作用导入(import './env.js')时立即生效 —— config.js 顶部第一行导入它,
// 保证后面读 process.env 时 .env 已经合并进来。
export const LOADED_COUNT = loadEnvFile()
