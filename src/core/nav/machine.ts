/**
 * Keyboard Navigation ("vim-like" post traversal for Threads/Instagram) — the
 * pure focus state machine. Mirrors the CONTEXT.md components-by-responsibility
 * split: this module owns ONLY the decision "which post is focused after this
 * move, given what is currently mounted"; the DOM snapshot production lives in
 * `core/adapters/meta-shared/nav-dom.ts`, the effectful wiring (focus ring,
 * scrollIntoView, action clicks) in `entrypoints/overlay.content/nav.ts`.
 *
 * Virtualization rule (mirrors `post-anchor.ts`'s "never trust a cached read"):
 * the machine never holds elements — only string post identities and
 * coordinates. The wiring re-enumerates the snapshot on every mutation burst
 * and calls {@link reconcile}; a focus whose postId vanished moves to the
 * nearest survivor in the same column, never silently to a different post.
 */

/** One focusable post in a snapshot. `id` is the platform post shortcode when
 *  derivable, else a positional fallback (`anon-<column>-<index>`) — positional
 *  ids degrade reconcile to nearest-survivor-by-index, which is exactly the
 *  same outcome, so no special casing is needed anywhere. */
export interface NavPost {
  readonly id: string
}

/** One feed column of posts in DOM order. Single-column platforms (Instagram,
 *  degraded Threads layouts) yield exactly one column. */
export interface NavColumn {
  readonly posts: ReadonlyArray<NavPost>
}

/** What is currently mounted, in spatial order: columns left→right, posts
 *  top→bottom within each column. Rebuilt fresh on every sync. */
export interface NavSnapshot {
  readonly columns: ReadonlyArray<NavColumn>
}

/** Coordinates + identity of the focused post. `postId` is the source of
 *  truth; `column`/`index` are the last-known coordinates, refreshed by
 *  {@link reconcile} whenever the snapshot moves the post. */
export interface NavFocus {
  readonly column: number
  readonly index: number
  readonly postId: string
}

export interface NavState {
  readonly focus: NavFocus | null
}

export const idleNav: NavState = { focus: null }

const lastNonEmptyColumn = (snap: NavSnapshot): number => {
  for (let c = snap.columns.length - 1; c >= 0; c--) {
    const posts = snap.columns[c]?.posts
    if (posts !== undefined && posts.length > 0) return c
  }
  return -1
}

/** Locate `postId` in the snapshot — its last-known column first (the common
 *  case is "hasn't moved"), then every other column in order (a layout change
 *  can migrate a post between Threads columns). */
function locatePost(
  snap: NavSnapshot,
  postId: string,
  preferredColumn: number,
): { column: number; index: number } | null {
  const preferred = snap.columns[preferredColumn]
  if (preferred) {
    const index = preferred.posts.findIndex((p) => p.id === postId)
    if (index >= 0) return { column: preferredColumn, index }
  }
  for (const [c, col] of snap.columns.entries()) {
    if (c === preferredColumn) continue
    const index = col.posts.findIndex((p) => p.id === postId)
    if (index >= 0) return { column: c, index }
  }
  return null
}

/** The nearest non-empty column to `from`, scanning forward before backward
 *  at equal distance (feed order biases down/right). */
function nearestNonEmptyColumn(snap: NavSnapshot, from: number): number {
  for (let d = 1; d < snap.columns.length; d++) {
    if ((snap.columns[from + d]?.posts.length ?? 0) > 0) return from + d
    if ((snap.columns[from - d]?.posts.length ?? 0) > 0) return from - d
  }
  return -1
}

/** Focus `column`/`index` after a clamp has already proven the post exists.
 *  The `undefined` guard is the type checker's bookkeeping (indexed access),
 *  not a reachable state — the clamp is the invariant. */
const focusClamped = (snap: NavSnapshot, column: number, index: number): NavState => {
  const post = snap.columns[column]?.posts[index]
  /* v8 ignore next -- callers clamp index into the column's length */
  if (post === undefined) return { focus: null }
  return { focus: { column, index, postId: post.id } }
}

/**
 * Bring `state` into agreement with what is actually mounted. Identity
 * (`focus.postId`) is the source of truth: the post is followed wherever it
 * moved — new index, new column. A vanished post moves focus to the nearest
 * survivor in the same column (index clamped), then to the nearest non-empty
 * column, then to nothing. Never invents focus: null stays null.
 */
export function reconcile(state: NavState, snap: NavSnapshot): NavState {
  const focus = state.focus
  if (!focus) return state
  const located = locatePost(snap, focus.postId, focus.column)
  if (located) {
    return located.column === focus.column && located.index === focus.index
      ? state
      : { focus: { column: located.column, index: located.index, postId: focus.postId } }
  }
  const column = Math.min(focus.column, snap.columns.length - 1)
  const col = snap.columns[column]
  if (col !== undefined && col.posts.length > 0) {
    return focusClamped(snap, column, Math.min(focus.index, col.posts.length - 1))
  }
  const near = nearestNonEmptyColumn(snap, column)
  if (near < 0) return { focus: null }
  const target = snap.columns[near]
  /* v8 ignore next -- nearestNonEmptyColumn only yields non-empty columns */
  if (target === undefined || target.posts.length === 0) return { focus: null }
  return focusClamped(snap, near, Math.min(focus.index, target.posts.length - 1))
}

/** Where an un-focused move starts: `+1` enters at the very first post, `-1`
 *  at the very last — X's "first j focuses the first tweet", mirrored. */
function enterFromNull(snap: NavSnapshot, delta: 1 | -1): NavState {
  const column =
    delta > 0 ? snap.columns.findIndex((c) => c.posts.length > 0) : lastNonEmptyColumn(snap)
  if (column < 0) return idleNav
  const col = snap.columns[column]
  /* v8 ignore next -- the column was selected for being non-empty */
  if (col === undefined) return idleNav
  const index = delta > 0 ? 0 : col.posts.length - 1
  const post = col.posts[index]
  /* v8 ignore next -- the column was selected for being non-empty */
  if (post === undefined) return idleNav
  return { focus: { column, index, postId: post.id } }
}

/**
 * Move focus one post within its column, clamped at both ends — never wraps,
 * never hops columns (columns are the arrow keys' domain). Reconciles first,
 * so a move issued against a stale, just-virtualized snapshot still lands on
 * the right post.
 */
export function movePost(state: NavState, snap: NavSnapshot, delta: 1 | -1): NavState {
  const s = reconcile(state, snap)
  const focus = s.focus
  if (!focus) {
    const entered = enterFromNull(snap, delta)
    return entered.focus === null ? s : entered
  }
  const col = snap.columns[focus.column]
  /* v8 ignore next -- reconcile already proved the focused column non-empty */
  if (col === undefined || col.posts.length === 0) return s
  const index = Math.max(0, Math.min(focus.index + delta, col.posts.length - 1))
  if (index === focus.index) return s
  return focusClamped(snap, focus.column, index)
}

/**
 * Move focus to the nearest non-empty column in `delta`'s direction — the
 * Threads multi-column move. `anchorIndex` is the wiring's geometry-derived
 * "closest row" hint (pixel positions are effectful; the machine takes the
 * number), clamped into the target column; without it the row index carries
 * over. No non-empty column in that direction → unchanged.
 */
export function moveColumn(
  state: NavState,
  snap: NavSnapshot,
  delta: 1 | -1,
  anchorIndex?: number,
): NavState {
  const s = reconcile(state, snap)
  const focus = s.focus
  if (!focus) {
    const entered = enterFromNull(snap, delta)
    return entered.focus === null ? s : entered
  }
  for (let c = focus.column + delta; c >= 0 && c < snap.columns.length; c += delta) {
    const posts = snap.columns[c]?.posts
    if (posts !== undefined && posts.length > 0) {
      const index = Math.max(0, Math.min(anchorIndex ?? focus.index, posts.length - 1))
      return focusClamped(snap, c, index)
    }
  }
  return s
}

/** Jump to the first mounted post (`gg`). */
export function firstPost(state: NavState, snap: NavSnapshot): NavState {
  const column = snap.columns.findIndex((c) => c.posts.length > 0)
  if (column < 0) return state
  const post = snap.columns[column]?.posts[0]
  /* v8 ignore next -- the column was selected for being non-empty */
  if (post === undefined) return state
  const focus = state.focus
  return focus !== null && focus.column === column && focus.index === 0 && focus.postId === post.id
    ? state
    : { focus: { column, index: 0, postId: post.id } }
}

/** Jump to the last mounted post (`G`). */
export function lastPost(state: NavState, snap: NavSnapshot): NavState {
  const column = lastNonEmptyColumn(snap)
  if (column < 0) return state
  const col = snap.columns[column]
  /* v8 ignore next -- lastNonEmptyColumn only yields non-empty columns */
  if (col === undefined) return state
  const post = col.posts[col.posts.length - 1]
  /* v8 ignore next -- lastNonEmptyColumn only yields non-empty columns */
  if (post === undefined) return state
  const focus = state.focus
  const index = col.posts.length - 1
  return focus !== null &&
    focus.column === column &&
    focus.index === index &&
    focus.postId === post.id
    ? state
    : { focus: { column, index, postId: post.id } }
}

/** The post under focus, verified by identity — null when unfocused or when
 *  the coordinates are stale (callers {@link reconcile} first). */
export function focusedPost(state: NavState, snap: NavSnapshot): NavPost | null {
  const focus = state.focus
  if (!focus) return null
  const post = snap.columns[focus.column]?.posts[focus.index]
  return post !== undefined && post.id === focus.postId ? post : null
}
