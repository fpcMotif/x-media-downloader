/**
 * Keyboard Navigation (issue #58) — the effectful controller between the pure
 * `core/nav` machine and the live Threads/Instagram page, in the
 * `saved-status-lifecycle.ts` idiom: every effect (DOM writes, store reads,
 * send, timers, scroll) arrives through {@link NavControllerDeps}, so the
 * module is unit-testable with fakes while `index.tsx` stays thin wiring.
 *
 * Owns: the focus ring (one injected `<style>`, one toggled class), the gg
 * chord timer, the verified-flip polls behind like/reply/repost (the Clear
 * feature's `FLIP_POLL_*` pattern — a click is never reported done until the
 * platform's own rendered state confirms it), and the snapshot/reconcile
 * cycle that keeps focus on the same post across feed virtualization.
 * Constructed only for adapters carrying a `nav` descriptor; with none (X —
 * native shortcuts are authoritative there) every method is inert.
 */
import type { PlatformAdapter } from '../../core/adapters/types'
import type { DetectionStore } from '../../core/adapters/detection-store'
import {
  buildNavSnapshot,
  enumerateNavColumns,
  type NavColumnDom,
} from '../../core/adapters/meta-shared/nav-dom'
import {
  commandForKey,
  idleKeymap,
  isEditableTarget,
  type KeymapState,
} from '../../core/nav/keymap'
import {
  firstPost,
  focusedPost,
  idleNav,
  lastPost,
  moveColumn,
  movePost,
  reconcile,
  type NavSnapshot,
  type NavState,
} from '../../core/nav/machine'
import type { MediaItem } from '@/packages/schema'

/** The class the controller toggles on the focused post. */
export const NAV_FOCUS_CLASS = 'xmd-nav-focus'

/** Focus ring — X's own focus blue, inset so it hugs the post container. */
const NAV_FOCUS_CSS = `.${NAV_FOCUS_CLASS}{outline:2px solid rgb(29 155 240);outline-offset:-2px;border-radius:4px}`

/** How long a pending `g` waits for the second chord key. */
export const NAV_GG_CHORD_MS = 500

/** Verified-flip poll cadence (the Clear feature's FLIP_POLL_* values). */
export const NAV_FLIP_POLL_MS = 200
export const NAV_FLIP_POLL_ATTEMPTS = 6

export interface NavControllerDeps {
  readonly adapter: PlatformAdapter
  readonly store: DetectionStore
  /** The Bulk handoff — the same path the popup's Drain rides. */
  readonly sendTracked: (items: ReadonlyArray<MediaItem>) => Promise<boolean>
  /** Live settings read (flips take effect without a reload). */
  readonly isEnabled: () => boolean
  /** Injected timer seam (the repo's Clock Port convention). */
  readonly schedule: (fn: () => void, ms: number) => () => void
  readonly scrollIntoView: (el: Element) => void
  readonly pathname: () => string
  readonly log: (...args: unknown[]) => void
  readonly doc: Document
}

export interface NavController {
  /** window keydown handler — registers no modifier traffic, see the keymap. */
  readonly handleKey: (e: KeyboardEvent) => void
  /** Re-enumerate the snapshot and reconcile focus (call on mutation bursts). */
  readonly sync: () => void
  readonly dispose: () => void
}

const clickElement = (el: Element): void => {
  // The aria-label can sit on an <svg> (no .click()) as easily as a button.
  if (el instanceof HTMLElement) el.click()
  else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

export function makeNavController(deps: NavControllerDeps): NavController {
  const nav = deps.adapter.nav
  let state: NavState = idleNav
  let keymap: KeymapState = idleKeymap
  let columns: ReadonlyArray<NavColumnDom> = []
  let snapshot: NavSnapshot = { columns: [] }
  /** postId → mounted element, rebuilt fresh every sync (Threads recycles). */
  let elements = new Map<string, Element>()
  let painted: Element | null = null
  const cancels = new Set<() => void>()

  const styleEl = deps.doc.createElement('style')
  styleEl.textContent = NAV_FOCUS_CSS
  deps.doc.head.appendChild(styleEl)

  const after = (fn: () => void, ms: number): void => {
    const cancel = deps.schedule(() => {
      cancels.delete(cancel)
      fn()
    }, ms)
    cancels.add(cancel)
  }

  const focusedElement = (): Element | null => {
    const post = focusedPost(state, snapshot)
    return post ? (elements.get(post.id) ?? null) : null
  }

  const clearPaint = (): void => {
    painted?.classList.remove(NAV_FOCUS_CLASS)
    painted = null
  }

  /** Move the ring to the focused element. Scrolls only on explicit keyboard
   *  moves — a reconcile repaint must never hijack the user's own scroll. */
  const paint = (scroll: boolean): void => {
    const el = focusedElement()
    if (el === painted) {
      if (scroll && el) deps.scrollIntoView(el)
      return
    }
    clearPaint()
    if (el) {
      el.classList.add(NAV_FOCUS_CLASS)
      painted = el
      if (scroll) deps.scrollIntoView(el)
    }
  }

  const applyMove = (next: NavState): void => {
    if (next === state) return
    state = next
    paint(true)
  }

  /** Verified-flip poll: first check is immediate, then NAV_FLIP_POLL_MS ×
   *  NAV_FLIP_POLL_ATTEMPTS before reporting the action unconfirmed. */
  const pollFor = (done: () => boolean, label: string, attempts = NAV_FLIP_POLL_ATTEMPTS): void => {
    if (done()) {
      deps.log(`[XMD nav] ${label} confirmed`)
      return
    }
    if (attempts <= 0) {
      deps.log(`[XMD nav] ${label} unconfirmed (clicked, no state flip)`)
      return
    }
    after(() => pollFor(done, label, attempts - 1), NAV_FLIP_POLL_MS)
  }

  const openFocused = (): void => {
    const el = focusedElement()
    if (!el || !nav) return
    const anchor = nav.permalinkOf(el)
    if (anchor) clickElement(anchor)
    else deps.log('[XMD nav] open: no permalink on the focused post')
  }

  const downloadFocused = (): void => {
    const el = focusedElement()
    if (!el) return
    const code = deps.adapter.postCodeFromElement?.(el, deps.pathname()) ?? null
    if (!code) {
      deps.log('[XMD nav] download: focused post has no shortcode')
      return
    }
    const postId = deps.store.postIdForCode(code) ?? code
    const items = deps.store.valuesForTweet(postId)
    if (items.length === 0) {
      deps.log(`[XMD nav] download: post ${code} has no detected media yet`)
      return
    }
    void (async () => {
      if (!(await deps.sendTracked(items)))
        deps.log(`[XMD nav] download: handoff failed for post ${code}`)
    })()
  }

  const fireAction = (action: 'like' | 'repost'): void => {
    const el = focusedElement()
    if (!el || !nav) return
    const control = nav.actionControl(el, action)
    if (!control) {
      deps.log(`[XMD nav] ${action}: no control on the focused post`)
      return
    }
    clickElement(control)
    pollFor(() => nav.actionFlipped(el, action), action)
  }

  const fireReply = (): void => {
    const el = focusedElement()
    if (!el || !nav) return
    const control = nav.actionControl(el, 'reply')
    if (!control) {
      deps.log('[XMD nav] reply: no control on the focused post')
      return
    }
    clickElement(control)
    pollFor(() => nav.replyComposerOpen(), 'reply')
  }

  /** The row anchor for a column switch: the target column post nearest the
   *  current focus's viewport top. happy-dom has no layout (every rect is 0),
   *  so equal distances fall back to preserving the row index — which is also
   *  the sane behavior when columns are perfectly aligned. */
  const anchorIndexFor = (delta: 1 | -1): number | undefined => {
    const focus = state.focus
    const currentEl = focus ? elements.get(focus.postId) : undefined
    if (!focus || !currentEl) return undefined
    const refTop = currentEl.getBoundingClientRect().top
    for (let c = focus.column + delta; c >= 0 && c < columns.length; c += delta) {
      const col = columns[c]
      if (!col || col.posts.length === 0) continue
      const distances = col.posts.map((p) => Math.abs(p.getBoundingClientRect().top - refTop))
      const first = distances[0]
      if (first === undefined || distances.every((d) => d === first)) return focus.index
      let best = 0
      for (let i = 1; i < distances.length; i++) {
        if ((distances[i] ?? Infinity) < (distances[best] ?? Infinity)) best = i
      }
      return best
    }
    return undefined
  }

  const spatial = (delta: 1 | -1): void => {
    // Instagram is single-column: the spatial keys' natural meaning there is
    // carousel prev/next on the focused post (spec, issue #58).
    if (deps.adapter.platform === 'instagram') {
      const el = focusedElement()
      if (!el) return
      const controls = nav?.carouselControls?.(el)
      const button = delta < 0 ? controls?.prev : controls?.next
      if (button) clickElement(button)
      return
    }
    applyMove(moveColumn(state, snapshot, delta, anchorIndexFor(delta)))
  }

  const handleKey = (e: KeyboardEvent): void => {
    if (!deps.isEnabled() || !nav) return
    if (isEditableTarget(e.target)) {
      keymap = idleKeymap
      return
    }
    const out = commandForKey(keymap, e.key, e)
    keymap = out.state
    if (keymap.pendingG)
      after(() => {
        keymap = idleKeymap
      }, NAV_GG_CHORD_MS)
    if (out.command === null) return
    // Act against the freshest view of the world: the mutation-debounced sync
    // can lag a fast feed, so reconcile before dispatching.
    state = reconcile(state, snapshot)
    switch (out.command) {
      case 'nextPost':
        applyMove(movePost(state, snapshot, 1))
        break
      case 'prevPost':
        applyMove(movePost(state, snapshot, -1))
        break
      case 'firstPost':
        applyMove(firstPost(state, snapshot))
        break
      case 'lastPost':
        applyMove(lastPost(state, snapshot))
        break
      case 'spatialLeft':
        spatial(-1)
        break
      case 'spatialRight':
        spatial(1)
        break
      case 'openPost':
        openFocused()
        break
      case 'downloadPost':
        downloadFocused()
        break
      case 'likePost':
        fireAction('like')
        break
      case 'repostPost':
        fireAction('repost')
        break
      case 'replyPost':
        fireReply()
        break
    }
  }

  const sync = (): void => {
    if (!deps.isEnabled() || !nav) {
      state = idleNav
      clearPaint()
      return
    }
    columns = enumerateNavColumns(deps.doc, nav.postSelector)
    snapshot = buildNavSnapshot(
      columns,
      (post) => deps.adapter.postCodeFromElement?.(post, deps.pathname()) ?? null,
    )
    elements = new Map(
      columns.flatMap((column, colIdx) =>
        column.posts.map((post, postIdx) => {
          const id = snapshot.columns[colIdx]?.posts[postIdx]?.id ?? `anon-${colIdx}-${postIdx}`
          return [id, post] as const
        }),
      ),
    )
    state = reconcile(state, snapshot)
    paint(false)
  }

  const dispose = (): void => {
    for (const cancel of cancels) cancel()
    cancels.clear()
    state = idleNav
    clearPaint()
    styleEl.remove()
  }

  return { handleKey, sync, dispose }
}
