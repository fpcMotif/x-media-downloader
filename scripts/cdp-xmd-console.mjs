// Persistent CDP console capture for the debug Chrome instance (port 9222).
// Connects ONCE to the Threads/Instagram page target(s) + the extension service
// worker, enables Runtime, and appends every [XMD] console line to a log file.
// One WebSocket per target, kept alive — never a per-command reconnect.
//
// Usage: launch Chrome with --remote-debugging-port=9222, load the unpacked
// build, open the Threads/Instagram tab, then `bun scripts/cdp-xmd-console.mjs`
// and reproduce. Output tees to stdout and to .output/xmd-live.log.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// Uses the runtime's global WebSocket (Bun / Node 22+) — no `ws` dependency.

const PORT = 9222
const LOG = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.output', 'xmd-live.log')
mkdirSync(dirname(LOG), { recursive: true })
writeFileSync(LOG, `=== XMD live capture started ${new Date().toISOString()} ===\n`)

const stamp = (src, text) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] (${src}) ${text}\n`
  appendFileSync(LOG, line)
  process.stdout.write(line)
}

const argToStr = (a) => {
  if (a === undefined) return ''
  if (a.value !== undefined) return String(a.value)
  if (a.description !== undefined) return a.description
  if (a.unserializableValue !== undefined) return String(a.unserializableValue)
  return a.type ?? ''
}

async function targets() {
  const res = await fetch(`http://localhost:${PORT}/json`)
  return res.json()
}

function attach(src, wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' }))
    ws.send(JSON.stringify({ id: ++id, method: 'Log.enable' }))
    stamp('cdp', `attached to ${src}`)
  })
  ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
    } catch {
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? []).map(argToStr).join(' ')
      if (text.includes('[XMD]')) stamp(src, `${msg.params.type}: ${text}`)
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      const text = d.exception?.description ?? d.text ?? ''
      if (text.includes('XMD') || text.includes('overlay') || text.includes('inject'))
        stamp(src, `EXCEPTION: ${text}`)
    }
  })
  ws.addEventListener('close', () => stamp('cdp', `${src} socket closed`))
  ws.addEventListener('error', (e) => stamp('cdp', `${src} socket error ${e?.message ?? 'unknown'}`))
  return ws
}

const list = await targets()
for (const t of list) {
  const isThreadsOrIg =
    t.type === 'page' && /https:\/\/www\.(threads|instagram)\.com/.test(t.url)
  const isSw = t.type === 'service_worker' && t.url.includes('background.js')
  if ((isThreadsOrIg || isSw) && t.webSocketDebuggerUrl) {
    attach(isSw ? 'sw' : 'page', t.webSocketDebuggerUrl)
  }
}

stamp('cdp', 'listener ready — reproduce the grab now')
setInterval(() => {}, 1 << 30)
