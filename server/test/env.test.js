// server/.env 加载器:启动配置的地基,错了会静默跑偏,所以单独测。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseEnv, loadEnvFile } from '../src/env.js'

test('parseEnv:注释、空行、引号、首个等号分隔', () => {
  const out = parseEnv(
    [
      '# 这是注释',
      '',
      '   ',
      'A=1',
      'B = hello world ',
      'C="quoted value"',
      "D='single quoted'",
      'E=a=b=c',
      'F=',
      'no equals sign here',
      '1BAD=x',
      'G = spaced',
    ].join('\n')
  )
  assert.equal(out.A, '1')
  assert.equal(out.B, 'hello world', '值两侧空白应被去掉')
  assert.equal(out.C, 'quoted value', '双引号应被去掉')
  assert.equal(out.D, 'single quoted', '单引号应被去掉')
  assert.equal(out.E, 'a=b=c', '只按第一个 = 分割')
  assert.equal(out.F, '')
  assert.equal(out.G, 'spaced')
  assert.equal(out['no equals sign here'], undefined)
  assert.equal(out['1BAD'], undefined, '非法键名应忽略')
})

test('parseEnv:空输入与纯注释', () => {
  assert.deepEqual(parseEnv(''), {})
  assert.deepEqual(parseEnv('# only comment\n\n'), {})
  assert.deepEqual(parseEnv(null), {})
})

test('loadEnvFile:不覆盖已存在的环境变量(命令行优先)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-env-'))
  const file = path.join(dir, '.env')
  fs.writeFileSync(file, 'MESH_TEST_KEEP=from-file\nMESH_TEST_NEW=v1\n', 'utf8')

  process.env.MESH_TEST_KEEP = 'from-env'
  delete process.env.MESH_TEST_NEW

  try {
    const applied = loadEnvFile(file)
    assert.equal(process.env.MESH_TEST_KEEP, 'from-env', '.env 不能盖掉已有变量')
    assert.equal(process.env.MESH_TEST_NEW, 'v1')
    assert.equal(applied, 1, '只有真正补进去的键才计数')
  } finally {
    delete process.env.MESH_TEST_KEEP
    delete process.env.MESH_TEST_NEW
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('loadEnvFile:文件不存在返回 0 而不是抛错', () => {
  assert.equal(loadEnvFile(path.join(os.tmpdir(), 'mesh-env-does-not-exist-xyz', '.env')), 0)
})

test('loadEnvFile:MESH_ENV_DISABLE=1 时整体跳过', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-env-'))
  const file = path.join(dir, '.env')
  fs.writeFileSync(file, 'MESH_TEST_DISABLED=yes\n', 'utf8')
  delete process.env.MESH_TEST_DISABLED
  process.env.MESH_ENV_DISABLE = '1'
  try {
    assert.equal(loadEnvFile(file), 0)
    assert.equal(process.env.MESH_TEST_DISABLED, undefined)
  } finally {
    delete process.env.MESH_ENV_DISABLE
    delete process.env.MESH_TEST_DISABLED
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
