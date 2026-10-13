import test from 'node:test'
import assert from 'node:assert/strict'
import {
  genEcdh,
  ecdhPubRaw,
  deriveSessionKeys,
  encryptFrame,
  decryptFrame,
  kxBindingDigest,
  ed25519KeyPair,
  ed25519Sign,
  ed25519Verify,
} from '../src/e2ee.js'
import { utf8, b64encode, b64decode } from '../src/protocol.js'

test('full E2E session round-trip (two independent parties)', async () => {
  const session = utf8('test-session-1')
  // party A
  const ka = await genEcdh()
  const kb = await genEcdh()
  const pubA = await ecdhPubRaw(ka)
  const pubB = await ecdhPubRaw(kb)

  // kx-b binding signatures (identity keys)
  const idA = ed25519KeyPair()
  const idB = ed25519KeyPair()
  const m = await kxBindingDigest(pubA, pubB, session)
  const mRev = await kxBindingDigest(pubB, pubA, session)
  assert.equal(b64encode(m), b64encode(mRev))
  const sigA = ed25519Sign(idA.secret, m)
  const sigB = ed25519Sign(idB.secret, m)
  assert.ok(ed25519Verify(idA.public, sigA, m))
  assert.ok(ed25519Verify(idB.public, sigB, m))
  // swapped verification fails
  assert.equal(ed25519Verify(idB.public, sigA, m), false)

  // derive keys on both sides
  const aKeys = await deriveSessionKeys(ka, pubB, pubA, session)
  const bKeys = await deriveSessionKeys(kb, pubA, pubB, session)

  // A → B frame
  const msg = { t: 'prompt', id: 'r1', prompt: 'hello 世界', n: 42 }
  const frame = await encryptFrame(aKeys.sendKey, msg)
  const decoded = await decryptFrame(bKeys.recvKey, frame)
  assert.deepEqual(decoded, msg)

  // B → A frame
  const reply = { t: 'token', id: 'r1', seq: 0, delta: 'hi' }
  const frame2 = await encryptFrame(bKeys.sendKey, reply)
  const decoded2 = await decryptFrame(aKeys.recvKey, frame2)
  assert.deepEqual(decoded2, reply)

  // wrong key must fail
  await assert.rejects(() => decryptFrame(aKeys.sendKey, frame2))
})

test('b64 round-trip', () => {
  const data = new Uint8Array([0, 1, 2, 250, 255])
  assert.deepEqual(b64decode(b64encode(data)), data)
})
