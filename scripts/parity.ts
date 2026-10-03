// Styling parity harness: proves two builds of a web UI render identically —
// every element's computed styles (default, forced :hover / :focus-visible /
// :active, light + dark, scripted interactive states) plus pixel screenshots.
//
//   bun parity.ts capture --config parity.config.json --out <dir> --serve ./dist
//   bun parity.ts capture --config parity.config.json --out <dir> --url http://localhost:5173
//   bun parity.ts capture --config parity.config.json --out <dir> --cdp 9222 (--url <base> | --serve <dir> | --ext-id <id> [--reload])
//   bun parity.ts capture --config parity.config.json --out <dir> --launch <unpacked extension dir> [--port 9444]
//   bun parity.ts compare --config parity.config.json --baseline <dir> --candidate <dir> [--report <html>]
//
// Hosts (any web UI Chrome can load — SPA, SSR, static site, Electron renderer, browser extension):
//   --serve <dir>  serves a built directory on a free localhost port (index.html fallback for SPA routes)
//                  and captures it in a headless Chrome. The simplest host: one build dir per capture.
//   --url <base>   captures an already running app (dev server, `next start`, any host) in a headless
//                  Chrome (CHROME_PATH, or the platform default).
//   --cdp <port>   attaches to a Chrome/Chromium/Electron started with --remote-debugging-port. Pages open
//                  as hidden targets (Chrome ≥ 134): rendered and screenshotted like tabs, never shown,
//                  never focused. Combine with --url or --serve for web apps; with --ext-id the scenario
//                  paths resolve inside that unpacked extension, and --reload makes Chrome re-read the
//                  extension directory first (swap the build in place, then capture).
//   --launch <dir> headless Chrome with an unpacked extension (needs a Chromium that still honours
//                  --load-extension, e.g. Chrome for Testing; branded Chrome ≥ 137 ignores it).
//
// Every page waits for `document.fonts.ready`, the optional `readyScript` (hydration hooks), the absence of
// `settledSelectors`, and a DOM-quiet window (`quietMs`) before steps run. Web mode runs the config's
// `resetScript` before each page boots. Extension mode snapshots chrome.storage before the run, clears it
// before every scenario, and restores it at the end; scenarios can hand the extension a fake active tab
// (`tabContext`). Capture writes one JSON + PNG per scenario; compare aligns the two DOM dumps node by node
// and reports every attribute / computed-style difference, then pixel-diffs.
//
// Needs `pixelmatch` and `pngjs` resolvable from the working directory (bun add -d pixelmatch pngjs).
/* eslint-disable no-await-in-loop -- scenarios and CDP calls run strictly one at a time on purpose */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
type JsonObject = { [key: string]: Json }

interface Viewport {
  readonly width: number
  readonly height: number
}

interface ScenarioConfig {
  readonly name: string
  /** Page path (joined to --url or the extension origin) or an absolute URL. */
  readonly path: string
  readonly viewport?: Viewport
  readonly schemes?: ReadonlyArray<'light' | 'dark'>
  /** Page-side JS run after load, before capture; each step is awaited. `__parity.*` helpers are available. */
  readonly steps?: ReadonlyArray<string>
  /** Extension mode: URL the page believes is the active tab (`chrome.tabs.query` is patched). */
  readonly tabContext?: string
}

interface Config {
  readonly viewport?: Viewport
  readonly schemes?: ReadonlyArray<'light' | 'dark'>
  readonly deviceScaleFactor?: number
  readonly settleMs?: number
  /** Selector for the elements that get forced :hover / :focus-visible / :active dumps. */
  readonly stateTargets?: string
  /** The page is "settled" once none of these selectors match (loading placeholders). */
  readonly settledSelectors?: ReadonlyArray<string>
  /** Page-side expression awaited before steps (hydration hook), e.g. `window.__hydrated` or a promise. */
  readonly readyScript?: string
  /** DOM-quiet window (no mutations) that must pass before a page counts as settled; 0 disables. */
  readonly quietMs?: number
  /** Attributes the migration adds on purpose (excluded from the DOM diff). */
  readonly ignoreAttributes?: ReadonlyArray<string>
  /** Regex source for custom properties that are plumbing, not design tokens. */
  readonly ignoreCustomProperties?: string
  /** Web mode: JS run before each page boots (e.g. clear localStorage). */
  readonly resetScript?: string
  /**
   * How the app switches to dark: `media` (default) emulates prefers-color-scheme only; `class` /
   * `attribute` additionally put `value` on `selector` (default `html`) for dark scenarios and remove
   * it for light ones. `window.__parityScheme` holds the scenario's scheme for `resetScript`
   * (e.g. seeding a theme key in localStorage).
   */
  readonly darkMode?: {
    readonly mode: 'media' | 'class' | 'attribute'
    readonly selector?: string
    readonly name?: string
    readonly value?: string
  }
  /**
   * Cookies set before every page boots (session fixtures, auth). Each is deleted by name first so a
   * previous run cannot leak. `url` or `domain` is required by CDP.
   */
  readonly cookies?: ReadonlyArray<{
    readonly name: string
    readonly value: string
    readonly url?: string
    readonly domain?: string
    readonly path?: string
    readonly secure?: boolean
    readonly httpOnly?: boolean
    readonly sameSite?: 'Strict' | 'Lax' | 'None'
  }>
  readonly scenarios: ReadonlyArray<ScenarioConfig>
}

interface Scenario {
  readonly name: string
  readonly path: string
  readonly scheme: 'light' | 'dark'
  readonly width: number
  readonly height: number
  readonly steps: ReadonlyArray<string>
  readonly tabContext: string | undefined
}

const CHROME_CANDIDATES: Record<string, ReadonlyArray<string>> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
}

function chromeBinary(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const found = (CHROME_CANDIDATES[process.platform] ?? []).find((p) => existsSync(p))
  if (!found)
    throw new Error(
      'no Chrome found — set CHROME_PATH (Chrome for Testing: bunx @puppeteer/browsers install chrome@stable)',
    )
  return found
}
const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 900 }
const DEFAULT_STATE_TARGETS =
  'button, a[href], input, select, textarea, [role="switch"], [role="option"], [role="menuitem"], [role="tab"], [tabindex]'
// Tailwind's own custom-property plumbing (`--tw-*`, the `@theme` scale) shows up in
// Chrome's computed-style enumeration on every element; none of it is rendered.
const DEFAULT_IGNORED_CUSTOM_PROPERTY =
  '^--(tw-|text-|color-|ease-|leading-|tracking-|font-weight-|container-|spacing$|animate-|radius-(2xl|4xl|sm|lg|xl)$|default-transition|default-font-feature|default-font-variation|default-mono-font-feature|default-mono-font-variation|x-)'

function loadConfig(file: string): Config {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Config
  if (!Array.isArray(raw.scenarios) || raw.scenarios.length === 0)
    throw new Error(`${file}: "scenarios" must be a non-empty array`)
  return raw
}

function expandScenarios(config: Config): Scenario[] {
  const out: Scenario[] = []
  for (const sc of config.scenarios) {
    const viewport = sc.viewport ?? config.viewport ?? DEFAULT_VIEWPORT
    for (const scheme of sc.schemes ?? config.schemes ?? ['light', 'dark']) {
      out.push({
        name: `${sc.name}__${scheme}`,
        path: sc.path,
        scheme,
        width: viewport.width,
        height: viewport.height,
        steps: sc.steps ?? [],
        tabContext: sc.tabContext,
      })
    }
  }
  return out
}

// Class- or attribute-driven dark mode: keep the marker present (dark) or absent (light) on the
// theme root through the first seconds of boot, so a theme script reading stale storage cannot
// flip it back.
const darkModeScript = (dark: NonNullable<Config['darkMode']>, scheme: string): string => {
  const selector = JSON.stringify(dark.selector ?? 'html')
  const value = JSON.stringify(dark.value ?? 'dark')
  const name = JSON.stringify(dark.name ?? 'data-theme')
  const isClass = dark.mode === 'class'
  const wantDark = scheme === 'dark'
  return `(() => {
    const apply = () => {
      const root = document.querySelector(${selector}) || document.documentElement;
      if (!root) return;
      ${
        isClass
          ? `if (${wantDark}) root.classList.add(${value}); else root.classList.remove(${value});`
          : `if (${wantDark}) { if (root.getAttribute(${name}) !== ${value}) root.setAttribute(${name}, ${value}); } else if (root.getAttribute(${name}) === ${value}) root.removeAttribute(${name});`
      }
    };
    const start = Date.now();
    const observer = new MutationObserver(() => { apply(); if (Date.now() - start > 3000) observer.disconnect(); });
    const arm = () => { apply(); observer.observe(document.documentElement, { attributes: true, subtree: false }); setTimeout(() => observer.disconnect(), 3000); };
    if (document.documentElement) arm(); else document.addEventListener('DOMContentLoaded', arm, { once: true });
  })()`
}

// Helpers injected into every page before steps run.
const pageHelpers = (config: Config): string => `
  window.__parity = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    byText: (sel, text) => [...document.querySelectorAll(sel)].find((el) => (el.textContent || '').trim().startsWith(text)),
    click: async (sel, text) => { const el = text ? window.__parity.byText(sel, text) : document.querySelector(sel); if (!el) throw new Error('not found: ' + sel + ' ' + (text || '')); el.click(); await window.__parity.sleep(120); },
    // The clickable control for an id or selector: the element itself when it carries the role, else the
    // role=switch/checkbox element beside a hidden native input (Base UI, Radix, Headless UI render one).
    control: (idOrSel) => { const el = document.getElementById(idOrSel) || document.querySelector(idOrSel); if (!el) throw new Error('not found: ' + idOrSel); const role = el.getAttribute('role'); if (role === 'switch' || role === 'checkbox' || el.tagName === 'BUTTON') return el; const scope = el.parentElement || document; return scope.querySelector('[role="switch"], [role="checkbox"]') || el },
    switchFor: (idOrSel) => window.__parity.control(idOrSel),
    toggle: async (idOrSel) => { window.__parity.control(idOrSel).click(); await window.__parity.sleep(150); },
    // Sets the value through the prototype setter so frameworks that track inputs (React) see the change.
    type: async (sel, value) => { const input = document.querySelector(sel); if (!input) throw new Error('not found: ' + sel); const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, 'value'); if (setter && setter.set) setter.set.call(input, value); else input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); await window.__parity.sleep(150); },
    // Wall-clock-driven UI (auto-dismiss timers) must not change during the forced-state sweep.
    freezeClock: () => { const now = Date.now(); Date.now = () => now },
    // Whether a programmatic focus() counts as :focus-visible depends on the page's input
    // history; the forced-state sweep covers focus-visible deterministically, so drop live focus.
    blur: () => { const el = document.activeElement; if (el && el !== document.body) el.blur() },
    // Fonts loaded, the app's own ready hook resolved, no loading markers, and a DOM-quiet window —
    // whichever framework rendered the page (SPA, hydrating SSR, islands). Capped so a page that
    // never goes quiet (a live clock) still gets captured.
    settled: () => new Promise((resolve) => {
      const sels = ${JSON.stringify([...(config.settledSelectors ?? [])])};
      const quiet = ${config.quietMs ?? 300};
      const ready = ${JSON.stringify(config.readyScript ?? '')};
      const start = Date.now(); let last = Date.now();
      const observer = new MutationObserver(() => { last = Date.now() });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
      const hook = ready ? Promise.resolve().then(() => (0, eval)(ready)) : Promise.resolve();
      const finish = () => { observer.disconnect(); setTimeout(resolve, 100) };
      Promise.all([fonts, hook]).catch(() => null).then(() => {
        const check = () => {
          const loading = sels.some((s) => document.querySelector(s));
          if ((!loading && Date.now() - last >= quiet) || Date.now() - start > 8000) finish(); else setTimeout(check, 50)
        };
        check()
      })
    }),
  }
`

// ---------------------------------------------------------------------------
// CDP client
// ---------------------------------------------------------------------------

class Cdp {
  private ws: WebSocket
  private id = 0
  private pending = new Map<
    number,
    { resolve: (v: JsonObject) => void; reject: (e: Error) => void }
  >()

  constructor(url: string) {
    this.ws = new WebSocket(url)
  }

  async open(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    this.ws.addEventListener('open', () => resolve(), { once: true })
    this.ws.addEventListener('error', () => reject(new Error(`websocket failed: ${this.ws.url}`)), {
      once: true,
    })
    this.ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data)) as {
        id?: number
        result?: JsonObject
        error?: { message: string }
      }
      if (msg.id === undefined) return
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result ?? {})
    })
    return promise
  }

  send(method: string, params: JsonObject = {}, sessionId?: string): Promise<JsonObject> {
    const id = ++this.id
    const { promise, resolve, reject } = Promise.withResolvers<JsonObject>()
    this.pending.set(id, { resolve, reject })
    this.ws.send(
      JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }),
    )
    return promise
  }

  close(): void {
    this.ws.close()
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '')

// ---------------------------------------------------------------------------
// Chrome lifecycle
// ---------------------------------------------------------------------------

async function launchChrome(
  port: number,
  extensionDir: string | null,
): Promise<{ proc: ChildProcess; profile: string }> {
  const chrome = chromeBinary()
  const profile = path.join(tmpdir(), `parity-${port}-${process.pid}`)
  rmSync(profile, { recursive: true, force: true })
  mkdirSync(profile, { recursive: true })
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      ...(extensionDir
        ? [`--load-extension=${extensionDir}`, `--disable-extensions-except=${extensionDir}`]
        : []),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-features=Translate,OptimizationHints',
      '--disable-renderer-backgrounding',
      // Deterministic rasterisation across machines: sRGB, no subpixel AA, no hinting differences.
      '--force-color-profile=srgb',
      '--disable-lcd-text',
      '--font-render-hinting=none',
      '--hide-scrollbars',
      '--window-size=1280,1000',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  )
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return { proc, profile }
    } catch {
      /* not up yet */
    }
    await sleep(200)
  }
  proc.kill('SIGKILL')
  throw new Error('Chrome did not expose the DevTools endpoint in time')
}

async function discoverExtensionId(port: number): Promise<string> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
      url?: string
      type?: string
    }>
    const sw = targets.find(
      (t) => t.type === 'service_worker' && (t.url ?? '').startsWith('chrome-extension://'),
    )
    const match = sw?.url?.match(/^chrome-extension:\/\/([a-z]{32})\//)
    if (match?.[1]) return match[1]
    await sleep(200)
  }
  throw new Error(
    'extension service worker never appeared (does this Chromium honour --load-extension?)',
  )
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

// Runs inside the page: serialises every element (document order, portals included) with its
// attributes and full computed style, plus ::before/::after when they exist. Class attributes
// are dropped (they are the thing that changes); everything else must match.
const DUMP_SCRIPT = `
(() => {
  const SKIP_ATTR = new Set(['class', 'data-style-src'])
  const props = (cs) => { const out = {}; for (let i = 0; i < cs.length; i++) { const p = cs[i]; out[p] = cs.getPropertyValue(p) } return out }
  const nodes = []
  const walk = (el, pathPrefix) => {
    const children = [...el.children]
    children.forEach((child, i) => {
      const tag = child.tagName.toLowerCase()
      const p = pathPrefix + '/' + tag + '[' + i + ']'
      const attrs = {}
      for (const a of child.attributes) if (!SKIP_ATTR.has(a.name)) attrs[a.name] = a.value
      const text = [...child.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).filter(Boolean).join(' ')
      const cs = getComputedStyle(child)
      const entry = { path: p, tag, attrs, text, styles: props(cs) }
      for (const pseudo of ['::before', '::after', '::placeholder', '::file-selector-button']) {
        const pcs = getComputedStyle(child, pseudo)
        if (pseudo === '::before' || pseudo === '::after') { if (pcs.content === 'none') continue }
        else if (!(tag === 'input')) continue
        entry[pseudo] = props(pcs)
      }
      nodes.push(entry)
      walk(child, p)
    })
  }
  walk(document.documentElement, '')
  return JSON.stringify({ html: props(getComputedStyle(document.documentElement)), nodes })
})()
`

interface Capture {
  readonly scenario: string
  readonly dom: JsonObject
  /** Forced-state dumps keyed by `<state>:<node path>`; each is the element + its descendants. */
  readonly states: JsonObject
  readonly matched: { hover: boolean; scheme: string }
}

async function capturePage(
  cdp: Cdp,
  session: string,
  sc: Scenario,
  config: Config,
  foreground: () => Promise<void>,
): Promise<{ capture: Capture; png: Buffer }> {
  const settleMs = config.settleMs ?? 700
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    {
      width: sc.width,
      height: sc.height,
      deviceScaleFactor: config.deviceScaleFactor ?? 2,
      mobile: false,
    },
    session,
  )
  await cdp.send(
    'Emulation.setEmulatedMedia',
    {
      features: [
        { name: 'prefers-color-scheme', value: sc.scheme },
        { name: 'hover', value: 'hover' },
        { name: 'pointer', value: 'fine' },
      ],
    },
    session,
  )
  const evaluate = async (expression: string): Promise<Json> => {
    const res = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      session,
    )
    if (res.exceptionDetails) {
      const details = res.exceptionDetails as JsonObject
      const exception = details.exception as JsonObject | undefined
      throw new Error(`page script failed: ${str(exception?.description) || str(details.text)}`)
    }
    return ((res.result as JsonObject | undefined)?.value ?? null) as Json
  }
  await evaluate(pageHelpers(config))
  await evaluate('__parity.settled()')
  // From here the page must be rendering (foreground, or a hidden target): in a
  // backgrounded tab CSS transitions and animations never advance and every dump
  // would read the frozen start values.
  await foreground()
  for (const step of sc.steps) await evaluate(`(async () => { ${step} })()`)
  // Park the pointer in the page's bottom-right corner so a real mouse resting
  // over the window cannot leave an element in :hover.
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: sc.width - 2, y: sc.height - 2 },
    session,
  )
  await sleep(settleMs)
  const matched = {
    hover: (await evaluate(`matchMedia('(hover: hover)').matches`)) === true,
    scheme: str(
      await evaluate(`matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'`),
    ),
  }
  const dom = JSON.parse(str(await evaluate(DUMP_SCRIPT))) as JsonObject

  // Forced pseudo states on every interactive element, one at a time. Transitions and
  // animations were compared in the default dump above; here they are switched off so each
  // forced state reads its settled values instantly instead of a point on an easing curve.
  await evaluate(
    `(() => { const s = document.createElement('style'); s.id = '__parity-nomotion'; s.textContent = '*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important}'; document.head.append(s); return true })()`,
  )
  const states: JsonObject = {}
  await cdp.send('DOM.enable', {}, session)
  await cdp.send('CSS.enable', {}, session)
  const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }, session)
  const root = (doc.root as JsonObject).nodeId as number
  const found = await cdp.send(
    'DOM.querySelectorAll',
    { nodeId: root, selector: config.stateTargets ?? DEFAULT_STATE_TARGETS },
    session,
  )
  const nodeIds = (found.nodeIds as number[]) ?? []
  for (const nodeId of nodeIds) {
    const resolved = await cdp.send('DOM.resolveNode', { nodeId }, session)
    const objectId = ((resolved.object as JsonObject).objectId ?? '') as string
    if (!objectId) continue
    const pathRes = await cdp.send(
      'Runtime.callFunctionOn',
      {
        objectId,
        returnByValue: true,
        functionDeclaration: `function () {
          const parts = []
          let el = this
          while (el && el !== document.documentElement) { const parent = el.parentElement; const i = parent ? [...parent.children].indexOf(el) : 0; parts.unshift(el.tagName.toLowerCase() + '[' + i + ']'); el = parent }
          return '/' + parts.join('/')
        }`,
      },
      session,
    )
    const nodePath = str(((pathRes.result as JsonObject) ?? {}).value)
    for (const state of [['hover'], ['focus', 'focus-visible'], ['active'], ['hover', 'active']]) {
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: state }, session)
      const dumpRes = await cdp.send(
        'Runtime.callFunctionOn',
        {
          objectId,
          returnByValue: true,
          functionDeclaration: `function () {
            const props = (cs) => { const out = {}; for (let i = 0; i < cs.length; i++) { const p = cs[i]; out[p] = cs.getPropertyValue(p) } return out }
            const dump = (el) => { const e = { tag: el.tagName.toLowerCase(), styles: props(getComputedStyle(el)) }; const a = getComputedStyle(el, '::after'); if (a.content !== 'none') e['::after'] = props(a); return e }
            return JSON.stringify([dump(this), ...[...this.querySelectorAll('*')].map(dump)])
          }`,
        },
        session,
      )
      states[`${state.join('+')}:${nodePath}`] = JSON.parse(
        str(((dumpRes.result as JsonObject) ?? {}).value),
      ) as Json
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }, session)
    }
  }
  await evaluate(
    `(() => { document.getElementById('__parity-nomotion')?.remove(); return true })()`,
  )
  await sleep(settleMs)
  const shot = await cdp.send(
    'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: false },
    session,
  )
  return {
    capture: { scenario: sc.name, dom, states, matched },
    png: Buffer.from(str(shot.data), 'base64'),
  }
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

// How every page target is opened. `hidden` targets (Chrome ≥ 134) render and screenshot like
// a normal tab but never appear in the tab strip or steal focus — the silent mode for a
// browser someone is using. Headless shell does not support it, so launched runs fall back to
// plain background tabs and activate them before capturing.
type OpenTarget = { hidden: true } | { background: true }

interface Host {
  readonly cdp: Cdp
  readonly open: OpenTarget
  /** Turns a scenario path into the URL to load. */
  readonly resolve: (scenarioPath: string) => string
  readonly extension: { id: string } | null
  readonly cleanup: () => Promise<void>
}

// Extension mode: `chrome.tabs.query` answers with a fake active tab at the scenario's URL —
// what a popup reads to decide which site it is on. A hidden target has no window of its own.
const tabContextPatch = (contextUrl: string): string => `
  (() => {
    const fakeTab = { id: 424242, windowId: 1, index: 0, active: true, highlighted: true, url: ${JSON.stringify(contextUrl)}, title: '' };
    const patch = (ns) => {
      if (!ns || !ns.tabs || typeof ns.tabs.query !== 'function') return;
      ns.tabs.query = (query, callback) => {
        const tabs = [fakeTab];
        if (typeof callback === 'function') { callback(tabs); return undefined }
        return Promise.resolve(tabs);
      };
    };
    patch(globalThis.chrome);
    if (globalThis.browser && globalThis.browser !== globalThis.chrome) patch(globalThis.browser);
  })();
`

/** Runs `expression` in a throwaway page of the host (an extension page in extension mode). */
async function inThrowawayPage(host: Host, url: string, expression: string): Promise<Json> {
  const { cdp } = host
  const target = (await cdp.send('Target.createTarget', { url, ...host.open })).targetId as string
  const session = (await cdp.send('Target.attachToTarget', { targetId: target, flatten: true }))
    .sessionId as string
  try {
    await cdp.send('Runtime.enable', {}, session)
    await sleep(300)
    const res = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      session,
    )
    if (res.exceptionDetails) {
      const details = res.exceptionDetails as JsonObject
      throw new Error(
        `page script failed: ${str((details.exception as JsonObject | undefined)?.description) || str(details.text)}`,
      )
    }
    return ((res.result as JsonObject | undefined)?.value ?? null) as Json
  } finally {
    await cdp.send('Target.closeTarget', { targetId: target }).catch(() => {})
  }
}

const STORAGE_AREAS = ['local', 'sync'] as const
const storageSnapshotScript = `(async () => JSON.stringify({ ${STORAGE_AREAS.map((a) => `${a}: await chrome.storage.${a}.get(null)`).join(', ')} }))()`
const storageClearScript = `(async () => { ${STORAGE_AREAS.map((a) => `await chrome.storage.${a}.clear();`).join(' ')} await chrome.storage.session?.clear?.(); return true })()`
const storageRestoreScript = (snapshot: string): string =>
  `(async () => { const data = JSON.parse(${JSON.stringify(snapshot)}); ${STORAGE_AREAS.map((a) => `await chrome.storage.${a}.clear(); if (data.${a} && Object.keys(data.${a}).length) await chrome.storage.${a}.set(data.${a});`).join(' ')} return true })()`

const extensionOrigin = (id: string): string => `chrome-extension://${id}`
const joinUrl = (base: string, scenarioPath: string): string =>
  /^[a-z]+:/i.test(scenarioPath)
    ? scenarioPath
    : `${base.replace(/\/$/, '')}/${scenarioPath.replace(/^\//, '')}`

async function connect(port: number): Promise<Cdp> {
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
    webSocketDebuggerUrl: string
    Browser?: string
  }
  if (version.Browser) console.log(`attached to ${version.Browser}`)
  const cdp = new Cdp(version.webSocketDebuggerUrl)
  await cdp.open()
  return cdp
}

// Hidden targets are an experimental CDP feature (Chrome ≥ 134); older Chromium and Electron
// builds reject the parameter. Fall back to background tabs, which the capture activates briefly.
async function probeHiddenTargets(cdp: Cdp): Promise<OpenTarget> {
  try {
    const id = (await cdp.send('Target.createTarget', { url: 'about:blank', hidden: true }))
      .targetId as string
    await cdp.send('Target.closeTarget', { targetId: id }).catch(() => {})
    return { hidden: true }
  } catch {
    console.warn('hidden targets unsupported by this browser; pages will open as background tabs')
    return { background: true }
  }
}

/** Wraps a host so extension storage is snapshotted now and restored on cleanup. */
async function withStorageGuard(host: Host, outDir: string, reload: boolean): Promise<Host> {
  if (!host.extension) return host
  const page = host.resolve('')
  const snapshot = str(await inThrowawayPage(host, page, storageSnapshotScript))
  writeFileSync(path.join(outDir, 'storage-snapshot.json'), snapshot)
  console.log(
    `extension storage snapshotted to ${path.join(outDir, 'storage-snapshot.json')} (restored when the capture ends)`,
  )
  if (reload) {
    // The caller swapped the files under the unpacked extension's directory.
    await inThrowawayPage(
      host,
      page,
      `(async () => { setTimeout(() => chrome.runtime.reload(), 50); return true })()`,
    ).catch(() => {})
    await sleep(2500)
  }
  return {
    ...host,
    cleanup: async () => {
      await inThrowawayPage(host, page, storageRestoreScript(snapshot)).catch((error: Error) => {
        console.error(
          `could not restore extension storage automatically: ${error.message}\nrestore it from ${path.join(outDir, 'storage-snapshot.json')}`,
        )
      })
      await host.cleanup()
    },
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
}

// Serves a built directory the way a static host would: files by path, directories through their
// index.html, and any unknown path through the root index.html (client-side routing).
async function serveStatic(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const root = path.resolve(dir)
  if (!existsSync(root)) throw new Error(`--serve: ${root} does not exist`)
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://parity').pathname)
    let file = path.normalize(path.join(root, pathname))
    if (!file.startsWith(root)) {
      res.writeHead(403).end()
      return
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html')
    if (!existsSync(file)) file = path.join(root, 'index.html')
    if (!existsSync(file)) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(readFileSync(file))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

interface HostOptions {
  readonly baseUrl: string | null
  readonly serveDir: string | null
  readonly cdpPort: number | null
  readonly extensionId: string | null
  readonly launchDir: string | null
  readonly port: number
  readonly reload: boolean
  readonly firstPage: string
  readonly outDir: string
}

async function createHost(o: HostOptions): Promise<Host> {
  const served = o.serveDir ? await serveStatic(o.serveDir) : null
  const baseUrl = served ? served.url : (o.baseUrl ?? '')
  const closeServer = async (): Promise<void> => {
    if (served) await served.close()
  }
  if (o.cdpPort !== null) {
    const cdp = await connect(o.cdpPort)
    const ext = o.extensionId
    const host: Host = {
      cdp,
      open: await probeHiddenTargets(cdp),
      resolve: (p) => (ext ? joinUrl(extensionOrigin(ext), p || o.firstPage) : joinUrl(baseUrl, p)),
      extension: ext ? { id: ext } : null,
      cleanup: async () => {
        cdp.close()
        await closeServer()
      },
    }
    return withStorageGuard(host, o.outDir, o.reload)
  }
  const { proc, profile } = await launchChrome(
    o.port,
    o.launchDir ? path.resolve(o.launchDir) : null,
  )
  const ext = o.launchDir ? await discoverExtensionId(o.port) : null
  const cdp = await connect(o.port)
  const host: Host = {
    cdp,
    open: { background: true },
    resolve: (p) => (ext ? joinUrl(extensionOrigin(ext), p || o.firstPage) : joinUrl(baseUrl, p)),
    extension: ext ? { id: ext } : null,
    cleanup: async () => {
      cdp.close()
      proc.kill('SIGKILL')
      await sleep(300)
      rmSync(profile, { recursive: true, force: true })
      await closeServer()
    },
  }
  return host
}

async function captureAll(host: Host, config: Config, outDir: string): Promise<void> {
  const { cdp } = host
  try {
    for (const sc of expandScenarios(config)) {
      // Every scenario starts from pristine state — one scenario's toggles must not leak into the next.
      if (host.extension) await inThrowawayPage(host, host.resolve(''), storageClearScript)
      const target = (await cdp.send('Target.createTarget', { url: 'about:blank', ...host.open }))
        .targetId as string
      const session = (await cdp.send('Target.attachToTarget', { targetId: target, flatten: true }))
        .sessionId as string
      await cdp.send('Page.enable', {}, session)
      await cdp.send('Runtime.enable', {}, session)
      for (const cookie of config.cookies ?? []) {
        const scope: JsonObject = {}
        if (cookie.url) scope.url = cookie.url
        if (cookie.domain) scope.domain = cookie.domain
        if (cookie.path) scope.path = cookie.path
        await cdp.send('Network.enable', {}, session)
        await cdp.send('Network.deleteCookies', { name: cookie.name, ...scope }, session)
        await cdp.send('Network.setCookie', { ...cookie }, session)
      }
      if (host.extension && sc.tabContext)
        await cdp.send(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: tabContextPatch(sc.tabContext) },
          session,
        )
      await cdp.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: `window.__parityScheme = ${JSON.stringify(sc.scheme)}` },
        session,
      )
      if (!host.extension && config.resetScript)
        await cdp.send(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: `(() => { try { ${config.resetScript} } catch {} })()` },
          session,
        )
      if (config.darkMode && config.darkMode.mode !== 'media')
        await cdp.send(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: darkModeScript(config.darkMode, sc.scheme) },
          session,
        )
      await cdp.send('Page.navigate', { url: host.resolve(sc.path) }, session)
      await sleep(500)
      try {
        const { capture, png } = await capturePage(cdp, session, sc, config, async () => {
          if ('hidden' in host.open) return
          await cdp.send('Target.activateTarget', { targetId: target })
          await sleep(250)
        })
        writeFileSync(path.join(outDir, `${sc.name}.json`), JSON.stringify(capture))
        writeFileSync(path.join(outDir, `${sc.name}.png`), png)
        const count = Array.isArray(capture.dom.nodes) ? capture.dom.nodes.length : 0
        console.log(
          `captured ${sc.name}: ${count} nodes, ${Object.keys(capture.states).length} forced states`,
        )
      } catch (error) {
        console.error(
          `FAILED ${sc.name}: ${error instanceof Error ? error.message : String(error)}`,
        )
        writeFileSync(
          path.join(outDir, `${sc.name}.error.txt`),
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        )
      }
      await cdp.send('Target.closeTarget', { targetId: target }).catch(() => {})
      await sleep(150)
    }
  } finally {
    await host.cleanup()
  }
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

const ZERO_SHADOW = /^(rgba\(0, 0, 0, 0\)|transparent) 0px 0px 0px 0px( inset)?$/
const ZERO_EXTENT_SHADOW = /^(.+?) 0px 0px 0px 0px( inset)?$/
const isHeadAsset = (nodePath: string, attr: string): boolean =>
  nodePath.startsWith('/head[') && (attr === 'src' || attr === 'href')

// Values that legitimately differ between builds without any visual difference: hashed
// keyframe names, transparent/zero-size shadow layers, minifier whitespace inside custom properties.
function normalise(prop: string, value: string): string {
  if (prop.startsWith('--')) return value.replace(/\s+/g, '')
  if (prop === 'animation-name' || prop === 'animation')
    return value === 'none'
      ? value
      : value.replace(/\b[A-Za-z0-9_-]*\b/g, (m) => (m === 'none' ? m : '<name>'))
  if (prop === 'box-shadow') {
    if (value === 'none') return value
    const layers = value.split(/,(?![^(]*\))/).map((s) => s.trim())
    const kept = layers.filter((l) => !ZERO_SHADOW.test(l) && !ZERO_EXTENT_SHADOW.test(l))
    return kept.length ? kept.join(', ') : 'none'
  }
  return value
}

interface Diff {
  readonly scenario: string
  readonly kind: 'structure' | 'attr' | 'text' | 'style' | 'state' | 'missing'
  readonly path: string
  readonly detail: string
}

interface CompareRules {
  readonly ignoredAttribute: Set<string>
  readonly ignoredCustomProperty: RegExp
}

function diffStyles(
  rules: CompareRules,
  scenario: string,
  kind: Diff['kind'],
  pathKey: string,
  a: JsonObject,
  b: JsonObject,
  out: Diff[],
): void {
  // With no outline drawn, outline-width only reflects the UA's :focus-visible default (1px)
  // versus `medium` (3px) — a focus artefact, not a style.
  const outlineHidden = str(a['outline-style']) === 'none' && str(b['outline-style']) === 'none'
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (rules.ignoredCustomProperty.test(k)) continue
    if (k === 'outline-width' && outlineHidden) continue
    // A property one Chrome build does not enumerate at all (different binary) is not a style change.
    if (!(k in a) || !(k in b)) continue
    const av = normalise(k, str(a[k]))
    const bv = normalise(k, str(b[k]))
    if (av !== bv) out.push({ scenario, kind, path: pathKey, detail: `${k}: "${av}" → "${bv}"` })
  }
}

function compareScenario(
  rules: CompareRules,
  name: string,
  baseDir: string,
  candDir: string,
): Diff[] {
  const out: Diff[] = []
  const bp = path.join(baseDir, `${name}.json`)
  const cp = path.join(candDir, `${name}.json`)
  if (!existsSync(bp) || !existsSync(cp)) {
    out.push({
      scenario: name,
      kind: 'missing',
      path: '',
      detail: `${existsSync(bp) ? '' : 'baseline '}${existsSync(cp) ? '' : 'candidate '}capture missing`,
    })
    return out
  }
  const base = JSON.parse(readFileSync(bp, 'utf8')) as Capture
  const cand = JSON.parse(readFileSync(cp, 'utf8')) as Capture
  const bn = (base.dom.nodes ?? []) as JsonObject[]
  const cn = (cand.dom.nodes ?? []) as JsonObject[]
  diffStyles(
    rules,
    name,
    'style',
    '/html',
    (base.dom.html ?? {}) as JsonObject,
    (cand.dom.html ?? {}) as JsonObject,
    out,
  )
  if (bn.length !== cn.length)
    out.push({
      scenario: name,
      kind: 'structure',
      path: '',
      detail: `node count ${bn.length} → ${cn.length}`,
    })
  const n = Math.min(bn.length, cn.length)
  for (let i = 0; i < n; i++) {
    const a = bn[i] as JsonObject
    const b = cn[i] as JsonObject
    const p = str(a.path)
    if (a.tag !== b.tag || a.path !== b.path) {
      out.push({
        scenario: name,
        kind: 'structure',
        path: p,
        detail: `${str(a.path)} <${str(a.tag)}> → ${str(b.path)} <${str(b.tag)}>`,
      })
      break
    }
    const aa = (a.attrs ?? {}) as JsonObject
    const ba = (b.attrs ?? {}) as JsonObject
    for (const k of new Set([...Object.keys(aa), ...Object.keys(ba)])) {
      if (rules.ignoredAttribute.has(k) || isHeadAsset(p, k)) continue
      if (str(aa[k]) !== str(ba[k]))
        out.push({
          scenario: name,
          kind: 'attr',
          path: p,
          detail: `${k}: "${str(aa[k])}" → "${str(ba[k])}"`,
        })
    }
    if (str(a.text) !== str(b.text))
      out.push({
        scenario: name,
        kind: 'text',
        path: p,
        detail: `"${str(a.text)}" → "${str(b.text)}"`,
      })
    diffStyles(
      rules,
      name,
      'style',
      p,
      (a.styles ?? {}) as JsonObject,
      (b.styles ?? {}) as JsonObject,
      out,
    )
    for (const pseudo of ['::before', '::after', '::placeholder', '::file-selector-button']) {
      const ap = a[pseudo] as JsonObject | undefined
      const bpv = b[pseudo] as JsonObject | undefined
      if (!ap && !bpv) continue
      if (!ap || !bpv) {
        out.push({
          scenario: name,
          kind: 'style',
          path: `${p}${pseudo}`,
          detail: ap ? 'pseudo-element removed' : 'pseudo-element added',
        })
        continue
      }
      diffStyles(rules, name, 'style', `${p}${pseudo}`, ap, bpv, out)
    }
  }
  const bs = (base.states ?? {}) as JsonObject
  const cs = (cand.states ?? {}) as JsonObject
  for (const key of new Set([...Object.keys(bs), ...Object.keys(cs)])) {
    const av = bs[key] as JsonObject[] | undefined
    const bv = cs[key] as JsonObject[] | undefined
    if (!av || !bv) {
      out.push({
        scenario: name,
        kind: 'state',
        path: key,
        detail: av ? 'state dump missing in candidate' : 'state dump missing in baseline',
      })
      continue
    }
    if (av.length !== bv.length)
      out.push({
        scenario: name,
        kind: 'state',
        path: key,
        detail: `subtree size ${av.length} → ${bv.length}`,
      })
    for (let i = 0; i < Math.min(av.length, bv.length); i++) {
      const ae = av[i] as JsonObject
      const be = bv[i] as JsonObject
      diffStyles(
        rules,
        name,
        'state',
        `${key} #${i}<${str(ae.tag)}>`,
        (ae.styles ?? {}) as JsonObject,
        (be.styles ?? {}) as JsonObject,
        out,
      )
      const aAfter = ae['::after'] as JsonObject | undefined
      const bAfter = be['::after'] as JsonObject | undefined
      if (aAfter && bAfter)
        diffStyles(rules, name, 'state', `${key} #${i}<${str(ae.tag)}>::after`, aAfter, bAfter, out)
      else if (aAfter || bAfter)
        out.push({
          scenario: name,
          kind: 'state',
          path: `${key} #${i}`,
          detail: '::after presence differs',
        })
    }
  }
  return out
}

function comparePixels(
  name: string,
  baseDir: string,
  candDir: string,
  diffDir: string,
): { pixels: number; ratio: number } | null {
  const bp = path.join(baseDir, `${name}.png`)
  const cp = path.join(candDir, `${name}.png`)
  if (!existsSync(bp) || !existsSync(cp)) return null
  const a = PNG.sync.read(readFileSync(bp))
  const b = PNG.sync.read(readFileSync(cp))
  if (a.width !== b.width || a.height !== b.height) return { pixels: -1, ratio: 1 }
  const diff = new PNG({ width: a.width, height: a.height })
  const pixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    threshold: 0,
    diffColor: [253, 141, 104],
  })
  if (pixels > 0) writeFileSync(path.join(diffDir, `${name}.png`), PNG.sync.write(diff))
  return { pixels, ratio: pixels / (a.width * a.height) }
}

function compareAll(
  config: Config,
  baseDir: string,
  candDir: string,
  reportPath: string | undefined,
): number {
  const rules: CompareRules = {
    ignoredAttribute: new Set(config.ignoreAttributes ?? []),
    ignoredCustomProperty: new RegExp(
      config.ignoreCustomProperties ?? DEFAULT_IGNORED_CUSTOM_PROPERTY,
    ),
  }
  const scenarios = expandScenarios(config)
  const diffDir = path.join(candDir, 'diff')
  mkdirSync(diffDir, { recursive: true })
  const all: Diff[] = []
  const rows: string[] = []
  for (const sc of scenarios) {
    const diffs = compareScenario(rules, sc.name, baseDir, candDir)
    const px = comparePixels(sc.name, baseDir, candDir, diffDir)
    all.push(...diffs)
    const pxText =
      px === null
        ? 'no screenshot'
        : px.pixels < 0
          ? 'size differs'
          : `${px.pixels} px (${(px.ratio * 100).toFixed(3)}%)`
    console.log(
      `${sc.name.padEnd(42)} ${String(diffs.length).padStart(5)} style/DOM diffs   pixels: ${pxText}`,
    )
    rows.push(`<tr><td>${sc.name}</td><td>${diffs.length}</td><td>${pxText}</td></tr>`)
  }
  const grouped = new Map<string, Diff[]>()
  for (const d of all) grouped.set(d.scenario, [...(grouped.get(d.scenario) ?? []), d])
  for (const [scenarioName, diffs] of grouped) {
    console.log(`\n=== ${scenarioName} (${diffs.length}) ===`)
    for (const d of diffs.slice(0, 80)) console.log(`  [${d.kind}] ${d.path}: ${d.detail}`)
    if (diffs.length > 80) console.log(`  … ${diffs.length - 80} more`)
  }
  writeFileSync(path.join(candDir, 'diffs.json'), JSON.stringify(all, null, 2))
  if (reportPath) {
    const html = `<!doctype html><meta charset="utf-8"><title>Parity report</title>
<style>body{font:13px/1.4 ui-sans-serif,system-ui;margin:24px;color:#111}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px;text-align:left}pre{font-size:12px;white-space:pre-wrap}</style>
<h1>Parity report</h1><p>${all.length} differences across ${scenarios.length} scenarios.</p>
<table><tr><th>scenario</th><th>style/DOM diffs</th><th>pixels</th></tr>${rows.join('')}</table>
<pre>${all
      .map((d) => `[${d.scenario}] [${d.kind}] ${d.path}: ${d.detail}`)
      .join('\n')
      .replace(/</g, '&lt;')}</pre>`
    writeFileSync(reportPath, html)
  }
  console.log(`\nTOTAL differences: ${all.length}`)
  return all.length
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage:
  capture --config <json> --out <dir> (--serve <build dir> | --url <base> | --cdp <port> (--url <base> | --serve <dir> | --ext-id <id> [--reload]) | --launch <ext dir>) [--port N]
  compare --config <json> --baseline <dir> --candidate <dir> [--report <html>]`

function flag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  const value = i >= 0 ? process.argv[i + 1] : undefined
  return value === undefined || value.startsWith('--') ? null : value
}

function required(name: string): string {
  const value = flag(name)
  if (value === null) throw new Error(`missing --${name}\n${USAGE}`)
  return value
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  if (mode === 'capture') {
    const config = loadConfig(required('config'))
    const outDir = required('out')
    mkdirSync(outDir, { recursive: true })
    const cdpPort = flag('cdp')
    const launchDir = flag('launch')
    const baseUrl = flag('url')
    const serveDir = flag('serve')
    if (cdpPort === null && launchDir === null && baseUrl === null && serveDir === null)
      throw new Error(`one of --serve, --url, --cdp, --launch is required\n${USAGE}`)
    const host = await createHost({
      baseUrl,
      serveDir,
      cdpPort: cdpPort === null ? null : Number(cdpPort),
      extensionId: flag('ext-id'),
      launchDir,
      port: Number(flag('port') ?? '9444'),
      reload: process.argv.includes('--reload'),
      firstPage: config.scenarios[0]?.path ?? '',
      outDir,
    })
    await captureAll(host, config, outDir)
    return
  }
  if (mode === 'compare') {
    const config = loadConfig(required('config'))
    const total = compareAll(
      config,
      required('baseline'),
      required('candidate'),
      flag('report') ?? undefined,
    )
    process.exit(total === 0 ? 0 : 2)
  }
  console.error(USAGE)
  process.exit(1)
}

main().catch((error: Error) => {
  console.error(error.stack ?? error.message)
  process.exit(1)
})
