// Live repro for x-media-downloader#92 — Threads Quick Grab on cloaked media.
//
// Drives the debug Chrome (CDP :9222) through the exact gesture the issue
// diagnosed: open a Threads permalink, hold Option+Cmd over a photo (CDP-injected
// trusted mousemoves), wait out the 500 ms dwell, and classify the outcome from
// the page's own [XMD] quickgrab console stages:
//
//   green  — `quickgrab armed` followed by `quickgrab queued` (the dwell fired;
//            on the diagnosed post the whole-post variant reads "4 started")
//   red    — `quickgrab grab-target-stale` (the pre-fix signature), or no arm
//            within the budget
//
// Requires the unpacked DEV build loaded (trace lines mirror to the page console
// only in dev). Never calls Page.bringToFront — run it while the tab is visible
// yourself; window-blur mid-dwell releases the grab and muddies the reading.
//
// Usage: bun scripts/cdp-threads-quickgrab-repro.mjs [postUrl] [hoverSeconds]
//   postUrl      default: the diagnosed permalink
//                https://www.threads.com/@uiuxandrii/post/DcVelsgCBu2
//   hoverSeconds default 6 — how long the Option+Cmd pointer stays on the photo

const PORT = 9222
const POST_URL = process.argv[2] ?? 'https://www.threads.com/@uiuxandrii/post/DcVelsgCBu2'
const HOVER_MS = Number(process.argv[3] ?? 6) * 1000
// Quick Grab dwell is 500 ms; give slow feeds headroom before calling it dead.
const ARM_BUDGET_MS = HOVER_MS + 8000

const stamp = (text) =>
  process.stdout.write(`[${new Date().toISOString().slice(11, 23)}] ${text}\n`)

async function targets() {
  const res = await fetch(`http://localhost:${PORT}/json`)
  if (!res.ok) throw new Error(`debug Chrome /json → ${res.status}`)
  return res.json()
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const listeners = []
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data))
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve: done, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else done(msg.result)
    } else if (msg.method) {
      for (const fn of listeners) fn(msg)
    }
  })
  const send = (method, params = {}) =>
    new Promise((done, reject) => {
      const mid = ++id
      pending.set(mid, { resolve: done, reject })
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  const onEvent = (fn) => listeners.push(fn)
  const ready = new Promise((done, reject) => {
    ws.addEventListener('open', async () => {
      await send('Runtime.enable')
      done()
    })
    ws.addEventListener('error', () => reject(new Error(`ws connect failed: ${wsUrl}`)))
  })
  return { send, onEvent, ready }
}

/** Center of the largest photo-like img currently mounted (Threads renders its
 *  carousel <img> pointer-events:none, exactly the #92 shape — it will NOT be
 *  in elementsFromPoint at that point, which is the point). */
async function photoCenter(cdp) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const imgs = [...document.querySelectorAll('img')]
      let best = null
      for (const el of imgs) {
        const r = el.getBoundingClientRect()
        if (r.width > 150 && r.height > 150 && (!best || r.width * r.height > best.area))
          best = { area: r.width * r.height, x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }
      return best ? JSON.stringify(best) : 'null'
    })()`,
    returnByValue: true,
  })
  return result.value === 'null' ? null : JSON.parse(result.value)
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const stages = []
const saw = (...names) => stages.some((s) => names.some((n) => s.includes(`quickgrab ${n}`)))

async function main() {
  const all = await targets()
  let tab = all.find(
    (t) => t.type === 'page' && t.url.includes('threads.com') && !t.url.startsWith('devtools'),
  )
  if (!tab) {
    const made = await fetch(`http://localhost:${PORT}/json/new?${encodeURIComponent(POST_URL)}`, {
      method: 'PUT',
    }).then((r) => r.json())
    tab = made
    stamp(`opened ${POST_URL} in a new tab`)
  }
  const cdp = connect(tab.webSocketDebuggerUrl)
  await cdp.ready

  cdp.onEvent((msg) => {
    if (msg.method !== 'Runtime.consoleAPICalled') return
    const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
    if (text.includes('[XMD]')) {
      stamp(text)
      stages.push(text)
    }
  })

  if (!tab.url.includes('threads.com/')) {
    await cdp.send('Page.enable')
    await cdp.send('Page.navigate', { url: POST_URL })
    await sleep(6000) // feed hydration; no Page.loadEventFired guarantee on SPA
  }

  const center = await photoCenter(cdp)
  if (!center) {
    stamp('RED · no photo-sized <img> found on the page')
    process.exit(1)
  }
  stamp(`hovering (${Math.round(center.x)}, ${Math.round(center.y)}) with alt+meta held…`)

  // Trusted Option+Cmd hover: alt|meta = 1|4. Re-issue small moves so every
  // overlay sample sees live pointer flags for the whole dwell.
  const deadline = Date.now() + HOVER_MS
  let jitter = 0
  while (Date.now() < deadline) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: center.x + (jitter % 3),
      y: center.y + ((jitter >> 1) % 3),
      modifiers: 5,
      buttons: 0,
    })
    jitter++
    await sleep(200)
  }

  const verdictDeadline = Date.now() + ARM_BUDGET_MS - HOVER_MS
  while (Date.now() < verdictDeadline) {
    if (saw('queued', 'started', 'saved')) {
      stamp(
        saw('whole-post')
          ? 'GREEN · whole-post grab queued/started (#92 fixed)'
          : 'GREEN · grab queued/started (#92 fixed)',
      )
      process.exit(0)
    }
    if (saw('grab-target-stale')) {
      stamp('RED · dwell died as grab-target-stale (the #92 bug)')
      process.exit(1)
    }
    await sleep(250)
  }
  stamp(
    saw('armed')
      ? 'RED · armed but never fired within budget'
      : 'RED · never armed (modifier flags or hover target missed)',
  )
  process.exit(1)
}

main().catch((err) => {
  stamp(`ERROR · ${err.message} · is the debug Chrome up on localhost:${PORT}?`)
  process.exit(1)
})
