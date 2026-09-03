/**
 * Controller tests for Keyboard Navigation (issue #58): the dep-injected
 * wiring seam between the pure `core/nav` machine and the live page. Fakes
 * are the repo's hand-rolled kind (injected `schedule` clock, spy arrays) —
 * no `vi.useFakeTimers`, per the Clock Port convention.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { MediaItem } from '@/packages/schema'
import { makeDetectionStore, type DetectionStore } from '../../core/adapters/detection-store'
import { threadsAdapter } from '../../core/adapters/threads/adapter'
import { instagramAdapter } from '../../core/adapters/instagram/adapter'
import { xAdapter } from '../../core/adapters/x/adapter'
import { makeNavController, NAV_FOCUS_CLASS, type NavControllerDeps } from './nav'

const THREADS_POST = "div[data-pressable-container='true']"

const metaPhoto = (id: string, postId: string): MediaItem => ({
  id,
  platform: 'threads',
  postId,
  author: 'alice',
  type: 'photo',
  url: `https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/${id}.jpg`,
  ext: 'jpg',
  index: 0,
})

const postHtml = (code: string) =>
  `<div data-pressable-container="true"><a href="/@alice/post/${code}">2h</a></div>`

/** A Threads-style feed: one argument per column, each a list of post codes.
 *  A single column renders flat (no section wrappers — the single-feed shape). */
function threadsDom(...columns: string[][]): HTMLElement {
  const root = document.createElement('main')
  root.innerHTML =
    columns.length === 1
      ? columns[0]!.map(postHtml).join('')
      : columns.map((col) => `<section>${col.map(postHtml).join('')}</section>`).join('')
  document.body.appendChild(root)
  return root
}

const instagramDom = (inner: string): HTMLElement => {
  const root = document.createElement('main')
  root.innerHTML = `<article>${inner}</article>`
  document.body.appendChild(root)
  return root
}

interface Harness {
  deps: NavControllerDeps
  store: DetectionStore
  sent: MediaItem[][]
  logs: string[]
  scrolled: Element[]
  timers: { fn: () => void; ms: number; cancelled: boolean }[]
  /** Run one round of pending timers (rounds so recursive polls can be stepped). */
  runTimerRound: () => void
  setEnabled: (on: boolean) => void
}

function harness(adapter: NavControllerDeps['adapter']): Harness {
  const store = makeDetectionStore({
    mediaKeyFromUrl: (url) => threadsAdapter.mediaKeyFromUrl(url),
  })
  const sent: MediaItem[][] = []
  const logs: string[] = []
  const scrolled: Element[] = []
  const timers: Harness['timers'] = []
  let enabled = true
  const deps: NavControllerDeps = {
    adapter,
    store,
    sendTracked: (items) => {
      sent.push([...items])
      return Promise.resolve(true)
    },
    isEnabled: () => enabled,
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false }
      timers.push(t)
      return () => {
        t.cancelled = true
      }
    },
    scrollIntoView: (el) => scrolled.push(el),
    pathname: () => '/',
    log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    doc: document,
  }
  return {
    deps,
    store,
    sent,
    logs,
    scrolled,
    timers,
    runTimerRound: () => {
      for (const t of timers.splice(0)) if (!t.cancelled) t.fn()
    },
    setEnabled: (on) => {
      enabled = on
    },
  }
}

const key = (k: string, init: KeyboardEventInit = {}): KeyboardEvent =>
  new KeyboardEvent('keydown', { key: k, bubbles: true, ...init })

const posts = (root: ParentNode): Element[] => [...root.querySelectorAll(THREADS_POST)]
const focused = (root: ParentNode): Element | null => root.querySelector(`.${NAV_FOCUS_CLASS}`)

beforeEach(() => {
  document.body.innerHTML = ''
  document.head.innerHTML = ''
})

/** The focused post's permalink href — the fixture's post identity (anchors
 *  all share the "2h" label). */
const focusedCode = (root: ParentNode): string | null | undefined =>
  focused(root)?.querySelector('a')?.getAttribute('href')

describe('makeNavController — movement', () => {
  it('j focuses the first post, then walks down with a visible focus class + scroll', () => {
    const root = threadsDom(['C1', 'C2', 'C3'])
    const h = harness(threadsAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j'))
    expect(focused(root)).toBe(posts(root)[0])
    expect(h.scrolled).toEqual([posts(root)[0]])
    nav.handleKey(key('j'))
    expect(focused(root)).toBe(posts(root)[1])
    nav.handleKey(key('k'))
    expect(focused(root)).toBe(posts(root)[0])
    nav.dispose()
  })

  it('ArrowDown/ArrowUp mirror j/k', () => {
    const root = threadsDom(['C1', 'C2'])
    const h = harness(threadsAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('ArrowDown'))
    expect(focused(root)).toBe(posts(root)[0])
    nav.handleKey(key('ArrowDown'))
    expect(focused(root)).toBe(posts(root)[1])
    nav.handleKey(key('ArrowUp'))
    expect(focused(root)).toBe(posts(root)[0])
    nav.dispose()
  })

  it('k at the top is a no-op (no extra scroll)', () => {
    const root = threadsDom(['C1'])
    const h = harness(threadsAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j'))
    nav.handleKey(key('k'))
    expect(focused(root)).toBe(posts(root)[0])
    expect(h.scrolled).toHaveLength(1)
    nav.dispose()
  })

  it('gg jumps to the first post, G to the last', () => {
    const root = threadsDom(['C1', 'C2', 'C3'])
    const h = harness(threadsAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j'))
    nav.handleKey(key('j'))
    expect(focused(root)).toBe(posts(root)[1])
    nav.handleKey(key('g'))
    nav.handleKey(key('g'))
    expect(focused(root)).toBe(posts(root)[0])
    nav.handleKey(key('G', { shiftKey: true }))
    expect(focused(root)).toBe(posts(root)[2])
    nav.dispose()
  })

  it('the gg chord expires after its window', () => {
    const root = threadsDom(['C1', 'C2', 'C3'])
    const h = harness(threadsAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j'))
    nav.handleKey(key('j'))
    expect(focused(root)).toBe(posts(root)[1])
    nav.handleKey(key('g'))
    h.runTimerRound() // chord window elapses
    nav.handleKey(key('g')) // rearms, does not complete
    expect(focused(root)).toBe(posts(root)[1])
    nav.dispose()
  })
})

describe('makeNavController — guards', () => {
  it('suspends every binding while typing in an input', () => {
    const root = threadsDom(['C1', 'C2'])
    const input = document.createElement('input')
    input.type = 'text'
    root.appendChild(input)
    const h = harness(threadsAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    const e = key('j')
    input.dispatchEvent(e)
    nav.handleKey(e)
    expect(focused(root)).toBeNull()
    nav.dispose()
  })

  it('suspends every binding inside a contenteditable composer', () => {
    const root = threadsDom(['C1', 'C2'])
    const box = document.createElement('div')
    box.setAttribute('contenteditable', 'true')
    root.appendChild(box)
    const h = harness(threadsAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    const e = key('l')
    Object.defineProperty(e, 'target', { value: box })
    nav.handleKey(e)
    expect(focused(root)).toBeNull()
    nav.dispose()
  })

  it('passes modifier-held keys through untouched', () => {
    const root = threadsDom(['C1', 'C2'])
    const h = harness(threadsAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j', { ctrlKey: true }))
    nav.handleKey(key('j', { metaKey: true }))
    nav.handleKey(key('j', { altKey: true }))
    expect(focused(root)).toBeNull()
    nav.dispose()
  })

  it('is fully inert when the setting is off', () => {
    const root = threadsDom(['C1', 'C2'])
    const h = harness(threadsAdapter)
    h.setEnabled(false)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j'))
    expect(focused(root)).toBeNull()
    expect(h.scrolled).toHaveLength(0)
    nav.dispose()
  })

  it('is inert for an adapter without a nav descriptor (X)', () => {
    const root = threadsDom(['C1', 'C2'])
    const h = harness(xAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j'))
    expect(focused(root)).toBeNull()
    nav.dispose()
  })
})

describe('makeNavController — actions', () => {
  it('o clicks the focused post permalink', () => {
    const root = threadsDom(['C1', 'C2'])
    const h = harness(threadsAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j'))
    const anchor = posts(root)[0]!.querySelector('a')!
    let clicks = 0
    anchor.addEventListener('click', () => clicks++)
    nav.handleKey(key('o'))
    expect(clicks).toBe(1)
    nav.dispose()
  })

  it('d hands the focused post’s detected media to the download queue', () => {
    threadsDom(['C1', 'C2'])
    const h = harness(threadsAdapter)
    h.store.registerPostCode('pk1', 'C1')
    h.store.addDetected([metaPhoto('m1', 'pk1'), metaPhoto('m2', 'pk1')])
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j'))
    nav.handleKey(key('d'))
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.map((i) => i.id)).toEqual(['m1', 'm2'])
    nav.dispose()
  })

  it('d with nothing detected logs a note and sends nothing', () => {
    threadsDom(['C1'])
    const h = harness(threadsAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j'))
    nav.handleKey(key('d'))
    expect(h.sent).toHaveLength(0)
    expect(h.logs.some((l) => l.includes('no detected media'))).toBe(true)
    nav.dispose()
  })

  it('l clicks the like control and confirms the flip', () => {
    const root = threadsDom(['C1'])
    posts(root)[0]!.innerHTML += '<span aria-label="Like"></span>'
    const h = harness(threadsAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j'))
    const like = posts(root)[0]!.querySelector('[aria-label="Like"]')!
    let clicks = 0
    like.addEventListener('click', () => {
      clicks++
      like.setAttribute('aria-label', 'Unlike') // platform flips optimistically
    })
    nav.handleKey(key('l'))
    expect(clicks).toBe(1)
    h.runTimerRound()
    expect(h.logs.some((l) => l.includes('like confirmed'))).toBe(true)
    nav.dispose()
  })

  it('l reports when the flip never confirms (selector rot fails safe)', () => {
    const root = threadsDom(['C1'])
    posts(root)[0]!.innerHTML += '<span aria-label="Like"></span>'
    const h = harness(threadsAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j'))
    nav.handleKey(key('l'))
    for (let i = 0; i < 6; i++) h.runTimerRound()
    expect(h.logs.some((l) => l.includes('like unconfirmed'))).toBe(true)
    nav.dispose()
  })

  it('r clicks reply and confirms the composer opened', () => {
    const root = threadsDom(['C1'])
    posts(root)[0]!.innerHTML += '<span aria-label="Reply"></span>'
    const h = harness(threadsAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j'))
    const reply = posts(root)[0]!.querySelector('[aria-label="Reply"]')!
    reply.addEventListener('click', () => {
      document.body.innerHTML += '<div role="dialog"><div contenteditable="true"></div></div>'
    })
    nav.handleKey(key('r'))
    h.runTimerRound()
    expect(h.logs.some((l) => l.includes('reply confirmed'))).toBe(true)
    nav.dispose()
  })

  it('t clicks the repost control and confirms via Reposted', () => {
    const root = threadsDom(['C1'])
    posts(root)[0]!.innerHTML += '<span aria-label="Repost"></span>'
    const h = harness(threadsAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j'))
    const repost = posts(root)[0]!.querySelector('[aria-label="Repost"]')!
    repost.addEventListener('click', () => repost.setAttribute('aria-label', 'Reposted'))
    nav.handleKey(key('t'))
    h.runTimerRound()
    expect(h.logs.some((l) => l.includes('repost confirmed'))).toBe(true)
    nav.dispose()
  })

  it('actions without a focused post are no-ops', () => {
    threadsDom(['C1'])
    const h = harness(threadsAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('d'))
    nav.handleKey(key('l'))
    nav.handleKey(key('o'))
    expect(h.sent).toHaveLength(0)
    expect(h.logs).toHaveLength(0)
    nav.dispose()
  })
})

describe('makeNavController — spatial moves', () => {
  it('ArrowRight moves focus into the next column on Threads, preserving the row', () => {
    const root = threadsDom(['A1', 'A2', 'A3'], ['B1', 'B2'])
    const h = harness(threadsAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j'))
    nav.handleKey(key('j'))
    expect(focusedCode(root)).toBe('/@alice/post/A2')
    nav.handleKey(key('ArrowRight'))
    expect(focusedCode(root)).toBe('/@alice/post/B2')
    nav.handleKey(key('ArrowLeft'))
    expect(focusedCode(root)).toBe('/@alice/post/A2')
    nav.dispose()
  })

  it('ArrowRight at the last column is a no-op', () => {
    const root = threadsDom(['A1'], ['B1'])
    const h = harness(threadsAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j'))
    nav.handleKey(key('ArrowRight'))
    const first = focused(root)
    nav.handleKey(key('ArrowRight'))
    expect(focused(root)).toBe(first)
    nav.dispose()
  })

  it('ArrowRight flips an Instagram carousel instead of switching columns', () => {
    const root = instagramDom(
      '<a href="/p/IG1/">2h</a><button aria-label="Go back"></button><button aria-label="Next"></button>',
    )
    const h = harness(instagramAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j'))
    const next = root.querySelector('button[aria-label="Next"]')!
    let clicks = 0
    next.addEventListener('click', () => clicks++)
    nav.handleKey(key('ArrowRight'))
    expect(clicks).toBe(1)
    // focus stays on the post — carousel flip is not a focus move
    expect(focused(root)).toBe(root.querySelector('article'))
    nav.dispose()
  })

  it('ArrowRight on a single-photo Instagram post does nothing', () => {
    const root = instagramDom('<a href="/p/IG1/">2h</a>')
    const h = harness(instagramAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j'))
    nav.handleKey(key('ArrowRight'))
    expect(focused(root)).toBe(root.querySelector('article'))
    expect(h.scrolled).toHaveLength(1)
    nav.dispose()
  })
})

describe('makeNavController — reconciliation and lifecycle', () => {
  it('sync() after virtualization keeps focus on the same post and repaints the class', () => {
    const root = threadsDom(['C1', 'C2', 'C3'])
    const h = harness(threadsAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j'))
    nav.handleKey(key('j'))
    expect(focusedCode(root)).toBe('/@alice/post/C2')
    // Threads recycles the DOM: C1 unmounts, C2 remounts as a fresh element
    root.innerHTML = ''
    root.innerHTML = ['C2', 'C3', 'C4']
      .map((c) => `<div data-pressable-container="true"><a href="/@alice/post/${c}">2h</a></div>`)
      .join('')
    nav.sync()
    const after = focused(root)
    expect(after?.querySelector('a')?.getAttribute('href')).toBe('/@alice/post/C2')
    expect(after).toBe(posts(root)[0])
    nav.dispose()
  })

  it('sync() moves focus to the nearest survivor when the focused post vanishes', () => {
    const root = threadsDom(['C1', 'C2', 'C3'])
    const h = harness(threadsAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j'))
    nav.handleKey(key('j'))
    root.innerHTML = ''
    root.innerHTML = ['C1', 'C3']
      .map((c) => `<div data-pressable-container="true"><a href="/@alice/post/${c}">2h</a></div>`)
      .join('')
    nav.sync()
    expect(focusedCode(root)).toBe('/@alice/post/C3')
    nav.dispose()
  })

  it('dispose removes the injected style and the focus class', () => {
    const root = threadsDom(['C1'])
    const h = harness(threadsAdapter)
    const nav = makeNavController(h.deps)
    nav.sync()
    nav.handleKey(key('j'))
    expect(document.head.querySelector('style')).not.toBeNull()
    nav.dispose()
    expect(document.head.querySelector('style')).toBeNull()
    expect(focused(root)).toBeNull()
  })
})
