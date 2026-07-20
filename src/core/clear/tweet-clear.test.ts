import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTweetClearer, type TweetClearerDeps } from './tweet-clear'
import { CLEARED_STUB_ATTR } from './clearer'

/** A sleep-only clock: resolves immediately, records each requested delay, and runs
 *  an optional per-tick hook so a test can mutate the DOM after poll N (fake time,
 *  the scroll-drain precedent). */
function makeClock() {
  const sleeps: number[] = []
  let tick: ((n: number) => void) | undefined
  const clock: TweetClearerDeps['clock'] = {
    sleep: async (ms) => {
      sleeps.push(ms)
      tick?.(sleeps.length)
    },
  }
  return {
    clock,
    sleeps,
    onTick: (fn: (n: number) => void) => {
      tick = fn
    },
  }
}

/** An `article[data-testid="tweet"]` with a `/status/{id}` permalink + the given
 *  action-bar HTML (same fixtures style as clearer.test.ts). */
function tweet(tweetId: string, inner: string): HTMLElement {
  const el = document.createElement('article')
  el.setAttribute('data-testid', 'tweet')
  el.innerHTML = `<a href="/jack/status/${tweetId}"><time></time></a>${inner}`
  return el
}

/** The leftover not-interested feedback stub X swaps in: a NON-tweet article whose
 *  buttons include the post-level dismiss. */
function feedbackStub(): HTMLElement {
  const stub = document.createElement('article')
  stub.innerHTML = `<div dir="ltr">Thanks. X will use this to make your timeline better.</div><button>Undo</button><button>This post isn’t relevant</button>`
  return stub
}

describe.each([
  ['log on', true],
  ['log off', false],
] as const)('makeTweetClearer (%s)', (_label, withLog) => {
  let log: ((...args: unknown[]) => void) | undefined
  let escapes: string[]
  let onKey: (e: Event) => void

  beforeEach(() => {
    document.body.innerHTML = ''
    log = withLog ? vi.fn<(...args: unknown[]) => void>() : undefined
    escapes = []
    onKey = (e) => {
      if ((e as KeyboardEvent).key === 'Escape') escapes.push('esc')
    }
    document.addEventListener('keydown', onKey)
  })
  afterEach(() => document.removeEventListener('keydown', onKey))

  const make = (clock: TweetClearerDeps['clock']) => makeTweetClearer({ document, clock, log })

  it('no matching article on the page ⇒ false', async () => {
    const { clock } = makeClock()
    expect(await make(clock).clearScope('1', 'like')).toBe(false)
  })

  it('non-member but verifiably already cleared ⇒ true (no click)', async () => {
    // Not liked (the cleared 'like' control is present) → not a member, already cleared.
    document.body.append(tweet('1', '<button data-testid="like"></button>'))
    const { clock, sleeps } = makeClock()
    expect(await make(clock).clearScope('1', 'like')).toBe(true)
    expect(sleeps).toHaveLength(0) // never entered the poll — no click
  })

  it('non-member and control missing (selector rot) ⇒ false', async () => {
    // Neither the active nor the cleared control present: ambiguous → never a blind clear.
    document.body.append(tweet('1', '<span>no action bar</span>'))
    const { clock } = makeClock()
    expect(await make(clock).clearScope('1', 'like')).toBe(false)
  })

  it('member + flip confirmed on poll N ⇒ true (button control, exactly N sleeps)', async () => {
    const art = tweet('1', '<button data-testid="unlike"></button>')
    const clicks: string[] = []
    art.querySelector('[data-testid="unlike"]')!.addEventListener('click', () => clicks.push('hit'))
    document.body.append(art)
    const N = 3
    const { clock, sleeps, onTick } = makeClock()
    onTick((n) => {
      // The optimistic flip lands on poll N: the active un-control becomes the cleared one.
      if (n === N) art.querySelector('[data-testid="unlike"]')!.remove()
    })
    expect(await make(clock).clearScope('1', 'like')).toBe(true)
    expect(clicks).toEqual(['hit'])
    expect(sleeps).toHaveLength(N)
  })

  it('member but never flips ⇒ false after exactly ATTEMPTS sleeps (div control fallback)', async () => {
    // Active control is a bare div (no button ancestor) → exercises the `?? ctrl` fallback.
    document.body.append(tweet('1', '<div data-testid="unlike"></div>'))
    const { clock, sleeps } = makeClock()
    expect(await make(clock).clearScope('1', 'like')).toBe(false)
    expect(sleeps).toEqual([200, 200, 200, 200, 200, 200])
  })

  it('re-resolves the article by id before the click — a swapped-in fresh node is clicked', async () => {
    const a1 = tweet('1', '<button data-testid="unlike"></button>')
    document.body.append(a1)
    const c1 = makeClock()
    c1.onTick((n) => {
      if (n === 1) a1.querySelector('[data-testid="unlike"]')!.remove()
    })
    expect(await make(c1.clock).clearScope('1', 'like')).toBe(true)

    // X recycles the row: same tweetId, a brand-new node. The next clear must find IT.
    a1.remove()
    const a2 = tweet('1', '<button data-testid="unlike"></button>')
    const clicked: string[] = []
    a2.querySelector('[data-testid="unlike"]')!.addEventListener('click', () => clicked.push('a2'))
    document.body.append(a2)
    const c2 = makeClock()
    c2.onTick((n) => {
      if (n === 1) a2.querySelector('[data-testid="unlike"]')!.remove()
    })
    expect(await make(c2.clock).clearScope('1', 'like')).toBe(true)
    expect(clicked).toEqual(['a2'])
  })

  it('notInterested: caret → sole new menu → item → collapse → feedback stub dismissed ⇒ true', async () => {
    const cell = document.createElement('div')
    cell.setAttribute('data-testid', 'cellInnerDiv')
    const art = tweet('1', '<button data-testid="caret"></button>')
    cell.append(art)
    document.body.append(cell)

    const dismissed: string[] = []
    art.querySelector('[data-testid="caret"]')!.addEventListener('click', () => {
      const menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      menu.innerHTML = `<div role="menuitem">Not interested in this post</div>`
      document.body.append(menu)
      menu.querySelector('[role="menuitem"]')!.addEventListener('click', () => {
        art.remove() // post collapses (detaches) → notInterestedConfirmed
        const stub = feedbackStub()
        stub
          .querySelectorAll('button')[1]!
          .addEventListener('click', () => dismissed.push('relevant'))
        cell.append(stub)
      })
    })

    const { clock } = makeClock()
    expect(await make(clock).clearScope('1', 'notInterested')).toBe(true)
    expect(cell.hasAttribute(CLEARED_STUB_ATTR)).toBe(true)
    expect(dismissed).toEqual(['relevant'])
  })

  it('notInterested: no caret control ⇒ false', async () => {
    document.body.append(tweet('1', '<span>no caret</span>'))
    const { clock } = makeClock()
    expect(await make(clock).clearScope('1', 'notInterested')).toBe(false)
  })

  it('notInterested: two new menus open ⇒ bail false + Escape dispatched (div caret fallback)', async () => {
    // Div caret (no button ancestor) exercises the `?? caret` fallback.
    const art = tweet('1', '<div data-testid="caret"></div>')
    document.body.append(art)
    art.querySelector('[data-testid="caret"]')!.addEventListener('click', () => {
      const m1 = document.createElement('div')
      m1.setAttribute('role', 'menu')
      const m2 = document.createElement('div')
      m2.setAttribute('role', 'menu')
      document.body.append(m1, m2)
    })
    const { clock } = makeClock()
    expect(await make(clock).clearScope('1', 'notInterested')).toBe(false)
    expect(escapes.length).toBeGreaterThanOrEqual(1)
  })

  it('notInterested: caret opens no menu at all ⇒ dismiss + false', async () => {
    // Caret click opens nothing → the new-menu poll never finds one → own item not found.
    document.body.append(tweet('1', '<button data-testid="caret"></button>'))
    const { clock, sleeps } = makeClock()
    expect(await make(clock).clearScope('1', 'notInterested')).toBe(false)
    expect(sleeps).toHaveLength(6) // exhausted the menu-open poll
    expect(escapes.length).toBeGreaterThanOrEqual(1)
  })

  it('notInterested: menu opens but the item is never found ⇒ dismiss + false', async () => {
    const art = tweet('1', '<button data-testid="caret"></button>')
    document.body.append(art)
    art.querySelector('[data-testid="caret"]')!.addEventListener('click', () => {
      const menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      menu.innerHTML = `<div role="menuitem">Mute @jack</div><div role="menuitem">Block @jack</div>`
      document.body.append(menu)
    })
    const { clock } = makeClock()
    expect(await make(clock).clearScope('1', 'notInterested')).toBe(false)
    expect(escapes.length).toBeGreaterThanOrEqual(1)
  })

  it('notInterested: item clicked but the post never collapses ⇒ dismiss + false', async () => {
    const art = tweet('1', '<button data-testid="caret"></button>')
    document.body.append(art)
    const itemClicks: string[] = []
    art.querySelector('[data-testid="caret"]')!.addEventListener('click', () => {
      const menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      menu.innerHTML = `<div role="menuitem">Not interested in this post</div>`
      document.body.append(menu)
      // The item click does NOT collapse the post (caret stays, article stays mounted).
      menu.querySelector('[role="menuitem"]')!.addEventListener('click', () => itemClicks.push('x'))
    })
    const { clock, sleeps } = makeClock()
    expect(await make(clock).clearScope('1', 'notInterested')).toBe(false)
    expect(itemClicks).toEqual(['x'])
    expect(sleeps.length).toBeGreaterThanOrEqual(7) // menu-open poll (1) + full confirm poll (6)
    expect(escapes.length).toBeGreaterThanOrEqual(1)
  })

  it('notInterested: confirms with no wrapping cell ⇒ true (no stub work)', async () => {
    // Article not inside a cellInnerDiv → cellOf is null → the collapse/stub work is skipped.
    const art = tweet('1', '<button data-testid="caret"></button>')
    document.body.append(art)
    art.querySelector('[data-testid="caret"]')!.addEventListener('click', () => {
      const menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      menu.innerHTML = `<div role="menuitem">Not interested in this post</div>`
      document.body.append(menu)
      menu.querySelector('[role="menuitem"]')!.addEventListener('click', () => art.remove())
    })
    const { clock } = makeClock()
    expect(await make(clock).clearScope('1', 'notInterested')).toBe(true)
  })

  it('notInterested: confirms in a cell with no feedback button ⇒ true (best-effort dismiss)', async () => {
    const cell = document.createElement('div')
    cell.setAttribute('data-testid', 'cellInnerDiv')
    const art = tweet('1', '<button data-testid="caret"></button>')
    cell.append(art)
    document.body.append(cell)
    art.querySelector('[data-testid="caret"]')!.addEventListener('click', () => {
      const menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      menu.innerHTML = `<div role="menuitem">Not interested in this post</div>`
      document.body.append(menu)
      // Collapse, but X never renders the feedback stub → the dismiss poll finds nothing.
      menu.querySelector('[role="menuitem"]')!.addEventListener('click', () => art.remove())
    })
    const { clock, sleeps } = makeClock()
    expect(await make(clock).clearScope('1', 'notInterested')).toBe(true)
    expect(cell.hasAttribute(CLEARED_STUB_ATTR)).toBe(true)
    expect(sleeps.length).toBeGreaterThanOrEqual(8) // menu(1) + confirm(1) + stub poll(6)
  })
})
