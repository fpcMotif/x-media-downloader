import { storage } from 'wxt/utils/storage'

export interface FirstRunState {
  readonly opens: number
  readonly done: boolean
}

/** Number of popup opens the first-run teaching strip is allowed to survive
 *  before it dismisses itself (spec §2.2 "First-run overlay state"). */
export const MAX_TEACHING_OPENS = 3

// Four is the sole terminal count: the first three opens render the strip,
// then the next open dismisses it. Keeping the counter bounded prevents a
// corrupt or old value from hiding onboarding forever.
const MAX_STORED_OPENS = MAX_TEACHING_OPENS + 1
const DEFAULT_INTRO_STATE: FirstRunState = { opens: 0, done: false }
const INTRO_KEY = 'local:xmd-popup-intro'
const DONE_KEY = 'local:xmd-popup-intro-done'

// Deliberately OUTSIDE the Settings schema (src/core/settings) — this is
// popup-local onboarding UI state, not a user preference any other part of
// the extension reads. Same `local:` idiom filters.tsx already uses for
// `local:daily-budget`.
const introItem = storage.defineItem<FirstRunState>(INTRO_KEY, {
  fallback: DEFAULT_INTRO_STATE,
})

function isIntroState(value: unknown): value is FirstRunState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  return (
    keys.length === 2 &&
    keys.includes('opens') &&
    keys.includes('done') &&
    typeof record.done === 'boolean' &&
    typeof record.opens === 'number' &&
    Number.isSafeInteger(record.opens) &&
    record.opens >= 0 &&
    record.opens <= MAX_STORED_OPENS
  )
}

export interface FirstRunStorage {
  readonly readState: () => Promise<unknown>
  readonly writeState: (state: FirstRunState) => Promise<void>
  readonly readDone: () => Promise<unknown>
  /** Terminal marker. Implementations must never write `false`. */
  readonly writeDone: () => Promise<void>
}

export interface FirstRunStateOwner {
  readonly get: () => Promise<FirstRunState>
  readonly recordOpen: () => Promise<FirstRunState>
  readonly markDone: () => Promise<FirstRunState>
}

/**
 * One mutation lane owns the compound state. A separate monotonic marker keeps
 * dismissal sticky even if another popup context finishes an older write later.
 */
export function makeFirstRunStateOwner(store: FirstRunStorage): FirstRunStateOwner {
  let tail: Promise<void> = Promise.resolve()

  const turn = <A>(operation: () => Promise<A>): Promise<A> => {
    const result = tail.then(operation, operation)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const terminal = async (): Promise<boolean> => (await store.readDone()) === true

  const commit = async (state: FirstRunState): Promise<FirstRunState> => {
    await store.writeState(state)
    if (state.done || !(await terminal())) return state
    const corrected = { ...state, done: true }
    await store.writeState(corrected)
    return corrected
  }

  const read = async (): Promise<FirstRunState> => {
    const raw = await store.readState()
    const state = isIntroState(raw) ? raw : DEFAULT_INTRO_STATE
    const done = state.done || (await terminal())
    const corrected = done === state.done ? state : { ...state, done }
    return raw === state && corrected === state ? state : commit(corrected)
  }

  return {
    get: () => turn(read),
    recordOpen: () =>
      turn(async () => {
        const current = await read()
        return commit({
          opens: Math.min(current.opens + 1, MAX_STORED_OPENS),
          done: current.done,
        })
      }),
    markDone: () =>
      turn(async () => {
        await store.writeDone()
        const current = await read()
        return commit({ opens: current.opens, done: true })
      }),
  }
}

const owner = makeFirstRunStateOwner({
  readState: () => storage.getItem(INTRO_KEY),
  writeState: (state) => introItem.setValue(state),
  readDone: () => storage.getItem(DONE_KEY),
  writeDone: () => storage.setItem(DONE_KEY, true),
})

/** Whether the first-run strip should render for a given stored state.
 *  Dismissal (whichever comes first, per spec §2.2): the user clicks the `×`
 *  (→ `markDone`), a Stage action completes successfully once (caller's
 *  responsibility to call `markDone`), or the popup has been opened more
 *  than `MAX_TEACHING_OPENS` times. */
export function shouldShowIntro(state: FirstRunState): boolean {
  return !state.done && state.opens <= MAX_TEACHING_OPENS
}

export async function getIntroState(): Promise<FirstRunState> {
  return owner.get()
}

/** Records one popup open — call once per popup mount, before deciding
 *  whether to show the strip. */
export async function recordOpen(): Promise<FirstRunState> {
  return owner.recordOpen()
}

/** Permanently dismisses the strip (the `×`, or a completed Stage action). */
export async function markDone(): Promise<FirstRunState> {
  return owner.markDone()
}
