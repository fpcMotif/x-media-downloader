import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTweetClearer, type TweetClearerDeps } from '../tweet-clear'
import { CLEAR_TESTID, CLEARED_STUB_ATTR } from '../clearer'

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
      if (e instanceof KeyboardEvent && e.key === 'Escape') escapes.push('esc')
    }
    document.addEventListener('keydown', onKey)
  })
  afterEach(() => document.removeEventListener('keydown', onKey))

  const make = (clock: TweetClearerDeps['clock']) => makeTweetClearer({ document, clock, log })

  it('no matching article on the page ⇒ false', async () => {
    const { clock } = makeClock()
    expect(await make(clock).clearScope('1', 'like', 'settle')).toBe(false)
  })

  it('"Add to Bookmarks" is already cleared ⇒ true without clicking', async () => {
    const addBookmark = document.createElement('button')
    addBookmark.dataset.testid = 'bookmark'
    addBookmark.setAttribute('aria-label', 'Add to Bookmarks')
    const click = vi.fn<() => void>()
    addBookmark.addEventListener('click', click)
    const article = tweet('1', '')
    article.append(addBookmark)
    document.body.append(article)
    const { clock, sleeps } = makeClock()

    expect(await make(clock).clearScope('1', 'bookmark', 'settle')).toBe(true)
    expect(click).not.toHaveBeenCalled()
    expect(sleeps).toHaveLength(0)
  })

  it('non-member and control missing (selector rot) ⇒ false', async () => {
    // Neither the active nor the cleared control present: ambiguous → never a blind clear.
    document.body.append(tweet('1', '<span>no action bar</span>'))
    const { clock } = makeClock()
    expect(await make(clock).clearScope('1', 'like', 'settle')).toBe(false)
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
    expect(await make(clock).clearScope('1', 'like', 'settle')).toBe(true)
    expect(clicks).toEqual(['hit'])
    expect(sleeps).toHaveLength(N)
  })

  it('member but never flips ⇒ false after exactly ATTEMPTS sleeps (div control fallback)', async () => {
    // Active control is a bare div (no button ancestor) → exercises the `?? ctrl` fallback.
    document.body.append(tweet('1', '<div data-testid="unlike"></div>'))
    const { clock, sleeps } = makeClock()
    expect(await make(clock).clearScope('1', 'like', 'settle')).toBe(false)
    expect(sleeps).toEqual([200, 200, 200, 200, 200, 200])
  })

  it('re-resolves the article by id before the click — a swapped-in fresh node is clicked', async () => {
    const a1 = tweet('1', '<button data-testid="unlike"></button>')
    document.body.append(a1)
    const c1 = makeClock()
    c1.onTick((n) => {
      if (n === 1) a1.querySelector('[data-testid="unlike"]')!.remove()
    })
    expect(await make(c1.clock).clearScope('1', 'like', 'settle')).toBe(true)

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
    expect(await make(c2.clock).clearScope('1', 'like', 'settle')).toBe(true)
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
    expect(await make(clock).clearScope('1', 'notInterested', 'settle')).toBe(true)
    expect(cell.hasAttribute(CLEARED_STUB_ATTR)).toBe(true)
    expect(dismissed).toEqual(['relevant'])
  })

  it('notInterested: no caret control ⇒ false', async () => {
    document.body.append(tweet('1', '<span>no caret</span>'))
    const { clock } = makeClock()
    expect(await make(clock).clearScope('1', 'notInterested', 'settle')).toBe(false)
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
    expect(await make(clock).clearScope('1', 'notInterested', 'settle')).toBe(false)
    expect(escapes.length).toBeGreaterThanOrEqual(1)
  })

  it('notInterested: caret opens no menu at all ⇒ dismiss + false', async () => {
    // Caret click opens nothing → the new-menu poll never finds one → own item not found.
    document.body.append(tweet('1', '<button data-testid="caret"></button>'))
    const { clock, sleeps } = makeClock()
    expect(await make(clock).clearScope('1', 'notInterested', 'settle')).toBe(false)
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
    expect(await make(clock).clearScope('1', 'notInterested', 'settle')).toBe(false)
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
    expect(await make(clock).clearScope('1', 'notInterested', 'settle')).toBe(false)
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
    expect(await make(clock).clearScope('1', 'notInterested', 'settle')).toBe(true)
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
    expect(await make(clock).clearScope('1', 'notInterested', 'settle')).toBe(true)
    expect(cell.hasAttribute(CLEARED_STUB_ATTR)).toBe(true)
    expect(sleeps.length).toBeGreaterThanOrEqual(8) // menu(1) + confirm(1) + stub poll(6)
  })
})

/**
 * The production-visible diagnostics: the `trace`/`onFlip` ports. These pin the EXACT
 * detail strings, because the whole point is that a Release failure on the Bookmarks page
 * is readable off the durable log without a debugger — four faults that used to collapse
 * into one `bookmark:fail` token must stay four distinct lines. The `describe.each` suite
 * above runs every one of these paths with both ports OMITTED, which is what covers the
 * absent-port branches; the closing test here pins that omission is behaviour-neutral.
 */
describe('makeTweetClearer diagnostics ports', () => {
  const BOOKMARKED = '<button data-testid="removeBookmark"></button>'
  const UNBOOKMARKED = '<button data-testid="bookmark"></button>'

  let trace: ReturnType<typeof vi.fn<NonNullable<TweetClearerDeps['trace']>>>
  let onFlip: ReturnType<typeof vi.fn<NonNullable<TweetClearerDeps['onFlip']>>>

  beforeEach(() => {
    document.body.innerHTML = ''
    trace = vi.fn<NonNullable<TweetClearerDeps['trace']>>()
    onFlip = vi.fn<NonNullable<TweetClearerDeps['onFlip']>>()
  })

  const make = (clock: TweetClearerDeps['clock']) =>
    makeTweetClearer({ document, clock, trace, onFlip })
  /** The one trace line these single-scope runs emit. */
  const sole = () => {
    expect(trace).toHaveBeenCalledTimes(1)
    return trace.mock.calls[0]!
  }

  it('flip in place ⇒ arm=testid, reresolved=cleared, and onFlip fired once', async () => {
    const art = tweet('1', BOOKMARKED)
    document.body.append(art)
    const { clock, onTick } = makeClock()
    onTick((n) => {
      // X's optimistic re-render: the active control becomes its cleared twin, in place.
      if (n === 2)
        art.querySelector('[data-testid="removeBookmark"]')!.setAttribute('data-testid', 'bookmark')
    })
    expect(await make(clock).clearScope('1', 'bookmark', 'settle')).toBe(true)
    expect(sole()).toEqual([
      'clear-flip',
      'scope=bookmark arm=testid attempt=2 elapsedMs=400 target=button disabled=false reresolved=cleared origin=settle',
      '1',
    ])
    expect(onFlip.mock.calls).toEqual([['1', 'bookmark', 'settle']])
  })

  it('captured node detaches mid-poll ⇒ arm=detached, reresolved=gone', async () => {
    const art = tweet('1', BOOKMARKED)
    document.body.append(art)
    const { clock, onTick } = makeClock()
    onTick((n) => {
      if (n === 1) art.remove()
    })
    expect(await make(clock).clearScope('1', 'bookmark', 'drain')).toBe(true)
    expect(sole()).toEqual([
      'clear-flip',
      'scope=bookmark arm=detached attempt=1 elapsedMs=200 target=button disabled=false reresolved=gone origin=drain',
      '1',
    ])
    expect(onFlip.mock.calls).toEqual([['1', 'bookmark', 'drain']])
  })

  it('detached node but the post is STILL a member ⇒ REFUSED (reresolved=member), clear-flip-fabricated still traced', async () => {
    // The suspected Bookmarks root cause, measured: removing a row re-renders its
    // siblings, so the virtualizer detaches the node we captured while the post itself is
    // still in the list. The detach arm alone used to return TRUE — the #62 fix makes
    // `reresolved=member` refuse (fail-closed, latch stays re-claimable) while the
    // ordinary + fabricated trace lines still fire so diagnosis keeps its evidence.
    const captured = tweet('1', BOOKMARKED)
    const rerendered = tweet('1', BOOKMARKED)
    document.body.append(captured, rerendered)
    const { clock, onTick } = makeClock()
    onTick((n) => {
      if (n === 1) captured.remove()
    })
    expect(await make(clock).clearScope('1', 'bookmark', 'settle')).toBe(false)
    expect(trace).toHaveBeenCalledTimes(2)
    const expectedDetail =
      'scope=bookmark arm=detached attempt=1 elapsedMs=200 target=button disabled=false reresolved=member origin=settle'
    expect(trace.mock.calls[0]).toEqual(['clear-flip', expectedDetail, '1'])
    expect(trace.mock.calls[1]).toEqual(['clear-flip-fabricated', expectedDetail, '1'])
    expect(onFlip).not.toHaveBeenCalled()
  })

  it('active control vanishes with no cleared twin ⇒ reresolved=ambiguous (other scope)', async () => {
    const art = tweet('1', '<button data-testid="unlike"></button>')
    document.body.append(art)
    const { clock, onTick } = makeClock()
    onTick((n) => {
      if (n === 3) art.querySelector('[data-testid="unlike"]')!.remove()
    })
    expect(await make(clock).clearScope('1', 'like', 'settle')).toBe(true)
    expect(sole()).toEqual([
      'clear-flip',
      'scope=like arm=testid attempt=3 elapsedMs=600 target=button disabled=false reresolved=ambiguous origin=settle',
      '1',
    ])
  })

  it('bare testid node carrying `disabled` ⇒ target=testid-node disabled=true', async () => {
    const art = tweet('1', '<div data-testid="removeBookmark" disabled></div>')
    document.body.append(art)
    const { clock, onTick } = makeClock()
    onTick((n) => {
      if (n === 1) art.querySelector('[data-testid="removeBookmark"]')!.remove()
    })
    expect(await make(clock).clearScope('1', 'bookmark', 'settle')).toBe(true)
    expect(sole()[1]).toBe(
      'scope=bookmark arm=testid attempt=1 elapsedMs=200 target=testid-node disabled=true reresolved=ambiguous origin=settle',
    )
  })

  it('button carrying aria-disabled ⇒ disabled=true', async () => {
    const art = tweet('1', '<button data-testid="removeBookmark" aria-disabled="true"></button>')
    document.body.append(art)
    const { clock, onTick } = makeClock()
    onTick((n) => {
      if (n === 1)
        art.querySelector('[data-testid="removeBookmark"]')!.setAttribute('data-testid', 'bookmark')
    })
    expect(await make(clock).clearScope('1', 'bookmark', 'settle')).toBe(true)
    expect(sole()[1]).toBe(
      'scope=bookmark arm=testid attempt=1 elapsedMs=200 target=button disabled=true reresolved=cleared origin=settle',
    )
  })

  it('no matching article ⇒ reason=no-article with the testids token OMITTED', async () => {
    const { clock } = makeClock()
    expect(await make(clock).clearScope('1', 'bookmark', 'settle')).toBe(false)
    const [stage, detail, id] = sole()
    expect([stage, detail, id]).toEqual([
      'clear-attempt-fail',
      'scope=bookmark reason=no-article attempts=0 elapsedMs=0 origin=settle',
      '1',
    ])
    // An empty `testids=` would read as "the action bar has no bookmark/like control" —
    // selector rot — which is a different fault from "the post isn't mounted".
    expect(detail).not.toContain('testids')
    expect(onFlip).not.toHaveBeenCalled()
  })

  it('member that never flips ⇒ reason=no-flip with the full attempt budget + testids', async () => {
    document.body.append(tweet('1', `${BOOKMARKED}<button data-testid="like"></button>`))
    const { clock, sleeps } = makeClock()
    expect(await make(clock).clearScope('1', 'bookmark', 'manual')).toBe(false)
    expect(sole()).toEqual([
      'clear-attempt-fail',
      'scope=bookmark reason=no-flip attempts=6 elapsedMs=1200 target=button disabled=false testids=removeBookmark,like origin=manual',
      '1',
    ])
    expect(sleeps).toHaveLength(6)
    expect(onFlip).not.toHaveBeenCalled()
  })

  it('no-flip carries the click snapshot that exonerates the selectors', async () => {
    // The whole point of `target`/`disabled`: on a FAILURE they separate "X ignored the
    // node we dispatched at" and "the control was inert" from "the click took but the list
    // never updated". `testids=removeBookmark` proves the selector still matched, so
    // without these two tokens this line would be indistinguishable from a server-side
    // no-op — the same collapse the four `clear-*` stages exist to undo.
    document.body.append(
      tweet('1', '<div data-testid="removeBookmark" aria-disabled="true"></div>'),
    )
    const { clock } = makeClock()
    expect(await make(clock).clearScope('1', 'bookmark', 'settle')).toBe(false)
    expect(sole()[1]).toBe(
      'scope=bookmark reason=no-flip attempts=6 elapsedMs=1200 target=testid-node disabled=true testids=removeBookmark origin=settle',
    )
  })

  it('forced member-without-control ⇒ reason=no-control (defensive branch, unreachable live)', async () => {
    const art = tweet('1', BOOKMARKED)
    document.body.append(art)
    // `isMember` and `clearControl` read the same node in the same synchronous tick, so
    // production can never land on that fail-closed branch. Drop the control's hit AFTER
    // the membership read to pin the vocabulary it would emit if that ever stopped holding
    // (a selector-rot report, not a silent success).
    const activeSel = `[data-testid="${CLEAR_TESTID.bookmark.active}"]`
    const real = art.querySelectorAll.bind(art)
    let reads = 0
    art.querySelectorAll = (selectors: string) =>
      selectors === activeSel && ++reads > 1 ? real('[data-xmd-no-such-attr]') : real(selectors)
    const { clock, sleeps } = makeClock()
    expect(await make(clock).clearScope('1', 'bookmark', 'settle')).toBe(false)
    expect(sole()).toEqual([
      'clear-attempt-fail',
      'scope=bookmark reason=no-control attempts=0 elapsedMs=0 testids=removeBookmark origin=settle',
      '1',
    ])
    expect(sleeps).toHaveLength(0) // never clicked, never polled
  })

  it('non-member, verifiably cleared ⇒ clear-already-cleared (never the fail vocabulary)', async () => {
    document.body.append(tweet('1', UNBOOKMARKED))
    const { clock, sleeps } = makeClock()
    expect(await make(clock).clearScope('1', 'bookmark', 'settle')).toBe(true)
    expect(sole()).toEqual([
      'clear-already-cleared',
      'scope=bookmark clicked=false alreadyCleared=true testids=bookmark origin=settle',
      '1',
    ])
    expect(sleeps).toHaveLength(0)
    expect(onFlip).not.toHaveBeenCalled()
  })

  it('non-member with NEITHER control ⇒ clear-already-cleared alreadyCleared=false', async () => {
    // Same stage, opposite verdict: the empty `testids=` is the selector-rot tell, and
    // keeping it out of `clear-attempt-fail` is what stops a no-op reading as a click.
    document.body.append(tweet('1', '<span>no action bar</span>'))
    const { clock } = makeClock()
    expect(await make(clock).clearScope('1', 'bookmark', 'settle')).toBe(false)
    expect(sole()).toEqual([
      'clear-already-cleared',
      'scope=bookmark clicked=false alreadyCleared=false testids= origin=settle',
      '1',
    ])
  })

  it('notInterested emits NOTHING once the caret flow owns the clear', async () => {
    // Unreachable on /i/bookmarks (pageScope there is `bookmark`), and its DEV log lines
    // carry element text: instrumenting its steps would leak post content into a durable
    // log for no diagnostic gain. Its ONE shared line is pinned by the test below.
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
    expect(await make(clock).clearScope('1', 'notInterested', 'settle')).toBe(true)
    expect(trace).not.toHaveBeenCalled()
    expect(onFlip).not.toHaveBeenCalled()
  })

  it('notInterested DOES emit the shared no-article line (scope=notInterested)', async () => {
    // The one `clear-*` line a non-membership scope can produce: it is raised before the
    // caret flow branches off. Content-free, so it is left reachable — but the glossary
    // must accept `scope=notInterested` on `clear-attempt-fail reason=no-article`, and a
    // test that only checked the mounted case would have hidden that.
    const { clock } = makeClock()
    expect(await make(clock).clearScope('1', 'notInterested', 'settle')).toBe(false)
    expect(sole()).toEqual([
      'clear-attempt-fail',
      'scope=notInterested reason=no-article attempts=0 elapsedMs=0 origin=settle',
      '1',
    ])
    expect(onFlip).not.toHaveBeenCalled()
  })

  it('both ports omitted ⇒ zero calls and identical verdicts on every terminal', async () => {
    const scenarios: ReadonlyArray<{
      readonly build: () => void
      readonly tick?: (n: number) => void
      readonly expected: boolean
    }> = [
      { build: () => {}, expected: false }, // no-article
      { build: () => document.body.append(tweet('1', UNBOOKMARKED)), expected: true }, // already-cleared
      { build: () => document.body.append(tweet('1', '<span></span>')), expected: false }, // neither control
      {
        build: () => document.body.append(tweet('1', BOOKMARKED)),
        tick: (n) => {
          if (n === 1) document.querySelector('[data-testid="removeBookmark"]')!.remove()
        },
        expected: true,
      }, // flip
      { build: () => document.body.append(tweet('1', BOOKMARKED)), expected: false }, // no-flip
    ]
    const run = async (withPorts: boolean): Promise<boolean[]> => {
      const verdicts: boolean[] = []
      // oxlint-disable no-await-in-loop -- each scenario owns the shared document
      for (const s of scenarios) {
        document.body.innerHTML = ''
        s.build()
        const { clock, onTick } = makeClock()
        if (s.tick !== undefined) onTick(s.tick)
        const deps: TweetClearerDeps = withPorts
          ? { document, clock, trace, onFlip }
          : { document, clock }
        verdicts.push(await makeTweetClearer(deps).clearScope('1', 'bookmark', 'settle'))
      }
      // oxlint-enable no-await-in-loop
      return verdicts
    }
    const bare = await run(false)
    expect(trace).not.toHaveBeenCalled()
    expect(onFlip).not.toHaveBeenCalled()
    expect(bare).toEqual(scenarios.map((s) => s.expected))
    // Byte-identical verdicts with the ports wired: diagnostics observe, never decide.
    expect(await run(true)).toEqual(bare)
    expect(trace).toHaveBeenCalledTimes(scenarios.length)
    expect(onFlip).toHaveBeenCalledTimes(1)
  })
})

/**
 * The `witness` port's precedence over the DOM (spec: server mutation verdict >
 * DOM flip). `makeMutationWitness` is exercised for real in mutation-witness.test.ts;
 * here a hand-scripted stub pins exactly WHICH poll tick the verdict lands on, so
 * the sleep-count assertions prove the witness is consulted BEFORE the DOM check on
 * every iteration, not just eventually.
 */
describe('makeTweetClearer witness precedence', () => {
  const BOOKMARKED = '<button data-testid="removeBookmark"></button>'

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  /** A `Pick<MutationWitness,'outcome'>` stub returning one scripted verdict per
   *  call, in order (the last entry repeats once exhausted). */
  const scriptedWitness = (results: ReadonlyArray<'ok' | 'error' | 'none'>) => {
    let i = 0
    return {
      outcome: vi.fn<() => 'ok' | 'error' | 'none'>(
        () => results[Math.min(i++, results.length - 1)] ?? 'none',
      ),
    } satisfies { outcome: ReturnType<typeof vi.fn<() => 'ok' | 'error' | 'none'>> }
  }

  it('witness ok on poll 2 with no DOM flip ⇒ true, arm=mutation traced, onFlip called', async () => {
    document.body.append(tweet('1', BOOKMARKED)) // never flips in the DOM
    const trace = vi.fn<NonNullable<TweetClearerDeps['trace']>>()
    const onFlip = vi.fn<NonNullable<TweetClearerDeps['onFlip']>>()
    const witness = scriptedWitness(['none', 'ok'])
    const { clock, sleeps } = makeClock()
    const clearer = makeTweetClearer({ document, clock, trace, onFlip, witness })
    expect(await clearer.clearScope('1', 'bookmark', 'settle')).toBe(true)
    // Stopped at poll 2 — never burned the rest of the DOM poll budget.
    expect(sleeps).toEqual([200, 200])
    expect(trace).toHaveBeenCalledTimes(1)
    expect(trace.mock.calls[0]![0]).toBe('clear-flip')
    expect(trace.mock.calls[0]![1]).toContain('arm=mutation')
    expect(onFlip.mock.calls).toEqual([['1', 'bookmark', 'settle']])
  })

  it('witness error despite an ALREADY-present DOM flip ⇒ false, reason=mutation-error', async () => {
    const art = tweet('1', BOOKMARKED)
    document.body.append(art)
    const { clock, sleeps, onTick } = makeClock()
    // The DOM flips on the very first tick — proves the witness check, which runs
    // BEFORE `flipConfirmed` on every iteration, wins even when the DOM would also
    // have confirmed on this same tick.
    onTick((n) => {
      if (n === 1) art.querySelector('[data-testid="removeBookmark"]')!.remove()
    })
    const trace = vi.fn<NonNullable<TweetClearerDeps['trace']>>()
    const onFlip = vi.fn<NonNullable<TweetClearerDeps['onFlip']>>()
    const witness = scriptedWitness(['error'])
    const clearer = makeTweetClearer({ document, clock, trace, onFlip, witness })
    expect(await clearer.clearScope('1', 'bookmark', 'settle')).toBe(false)
    expect(sleeps).toEqual([200])
    expect(trace).toHaveBeenCalledTimes(1)
    expect(trace.mock.calls[0]![0]).toBe('clear-attempt-fail')
    expect(trace.mock.calls[0]![1]).toContain('reason=mutation-error')
    expect(onFlip).not.toHaveBeenCalled()
  })

  it('witness stays "none" through the whole DOM budget ⇒ falls through to the ordinary no-flip failure', async () => {
    document.body.append(tweet('1', BOOKMARKED))
    const trace = vi.fn<NonNullable<TweetClearerDeps['trace']>>()
    const witness = scriptedWitness(['none'])
    const { clock } = makeClock()
    const clearer = makeTweetClearer({ document, clock, trace, witness })
    expect(await clearer.clearScope('1', 'bookmark', 'settle')).toBe(false)
    // 6 DOM polls + 4 extra witness-only polls, every one consulting the witness.
    expect(witness.outcome).toHaveBeenCalledTimes(10)
    expect(trace.mock.calls.at(-1)?.[0]).toBe('clear-attempt-fail')
    expect(trace.mock.calls.at(-1)?.[1]).toContain('reason=no-flip')
  })

  it('extra witness-only polls confirm a late mutation after the DOM budget exhausts', async () => {
    document.body.append(tweet('1', BOOKMARKED)) // never flips in the DOM
    const trace = vi.fn<NonNullable<TweetClearerDeps['trace']>>()
    const onFlip = vi.fn<NonNullable<TweetClearerDeps['onFlip']>>()
    // 6 DOM-poll 'none's, then 'none' + 'ok' in the extra witness-only polls.
    const witness = scriptedWitness(['none', 'none', 'none', 'none', 'none', 'none', 'none', 'ok'])
    const { clock, sleeps } = makeClock()
    const clearer = makeTweetClearer({ document, clock, trace, onFlip, witness })
    expect(await clearer.clearScope('1', 'bookmark', 'settle')).toBe(true)
    // 6×200ms DOM polls, then 2×250ms extra witness-only polls before the 'ok'.
    expect(sleeps).toEqual([200, 200, 200, 200, 200, 200, 250, 250])
    expect(trace.mock.calls.at(-1)?.[0]).toBe('clear-flip')
    expect(trace.mock.calls.at(-1)?.[1]).toContain('arm=mutation')
    expect(onFlip.mock.calls).toEqual([['1', 'bookmark', 'settle']])
  })

  it('no witness supplied ⇒ unchanged: no extra polls ever run, DOM-only verdict stands', async () => {
    document.body.append(tweet('1', BOOKMARKED))
    const trace = vi.fn<NonNullable<TweetClearerDeps['trace']>>()
    const { clock, sleeps } = makeClock()
    const clearer = makeTweetClearer({ document, clock, trace })
    expect(await clearer.clearScope('1', 'bookmark', 'settle')).toBe(false)
    expect(sleeps).toEqual([200, 200, 200, 200, 200, 200])
    expect(trace).toHaveBeenCalledTimes(1)
    expect(trace.mock.calls[0]![1]).toContain('reason=no-flip')
  })
})
