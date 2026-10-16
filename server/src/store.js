import fs from 'node:fs'
import path from 'node:path'

// Tiny JSON-file store with debounced atomic writes.
export function createStore(file) {
  let data = {}
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      data = {}
    }
  }

  let timer = null
  const persist = () => {
    const tmp = file + '.tmp'
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
  }
  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      try {
        persist()
      } catch (e) {
        console.error('[store] persist failed:', e.message)
      }
    }, 150)
    timer.unref?.()
  }

  return {
    // NOTE: a key can be present but hold null. Older builds wrote null for
    // empty maps, and a half-copied data.json can too. Callers that pass a
    // default obviously want the default in that case: returning null made
    // Object.values(null) blow up with "Cannot convert undefined or null to
    // object" and took down /listings with a 500.
    get: (k, d = null) => (k in data && data[k] !== null ? data[k] : d),
    set: (k, v) => {
      data[k] = v
      schedule()
    },
    update: (k, fn, d = null) => {
      const next = fn(k in data ? data[k] : d)
      data[k] = next
      schedule()
      return next
    },
    flush: persist,
  }
}
