// Broad one-shot diagnostic: attach to the threads page target, log EVERY
// console call (type + executionContextId + text) and every execution context
// created (id + name + isolated-world auxData). Runs ~20s then exits.
//
// The narrow counterpart of cdp-xmd-console.mjs: use this one when the question
// is "is the content script's isolated world even there / is anything logging at
// all", since it filters nothing.
const PORT = 9222

const argToStr = (a) => {
  if (a === undefined) return ''
  if (a.value !== undefined) return String(a.value)
  if (a.description !== undefined) return a.description
  if (a.unserializableValue !== undefined) return String(a.unserializableValue)
  return a.type ?? ''
}
const res = await fetch(`http://localhost:${PORT}/json`)
const list = await res.json()
const page = list.find(
  (t) => t.type === 'page' && /https:\/\/www\.threads\.com/.test(t.url) && t.webSocketDebuggerUrl,
)
if (!page) {
  console.log('no threads page target found')
  process.exit(1)
}
console.log('attaching to', page.url)
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const ctx = new Map()
ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' }))
  ws.send(JSON.stringify({ id: ++id, method: 'Log.enable' }))
})
ws.addEventListener('message', (ev) => {
  let msg
  try {
    const dataStr = ev.data instanceof Buffer ? ev.data.toString() : ev.data
    msg = JSON.parse(dataStr)
  } catch {
    return
  }
  if (msg.method === 'Runtime.executionContextCreated') {
    const c = msg.params.context
    ctx.set(c.id, `${c.name || '(main)'}${c.auxData ? ' aux=' + JSON.stringify(c.auxData) : ''}`)
    console.log(`CTX+ id=${c.id} ${ctx.get(c.id)}`)
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const p = msg.params
    const text = (p.args ?? []).map(argToStr).join(' ')
    const where = ctx.get(p.executionContextId) ?? `ctx${p.executionContextId}`
    console.log(`[${p.type}] {${where}} ${text.slice(0, 140)}`)
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    console.log(`EXCEPTION: ${d.exception?.description ?? d.text ?? ''}`.slice(0, 300))
  }
  if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry
    console.log(`LOG[${e.level}/${e.source}] ${(e.text ?? '').slice(0, 160)}`)
  }
})
ws.addEventListener('error', (e) => console.log('err', e?.message))
setTimeout(() => {
  console.log('=== done ===')
  process.exit(0)
}, 20000)
