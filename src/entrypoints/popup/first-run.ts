import { storage } from 'wxt/utils/storage'

export interface FirstRunState {
  readonly opens: number
  readonly done: boolean
}

/** Number of popup opens the first-run teaching strip is allowed to survive
 *  before it dismisses itself (spec §2.2 "First-run overlay state"). */
export const MAX_TEACHING_OPENS = 3

// Deliberately OUTSIDE the Settings schema (src/core/settings) — this is
// popup-local onboarding UI state, not a user preference any other part of
// the extension reads. Same `local:` idiom filters.tsx already uses for
// `local:daily-budget`.
const introItem = storage.defineItem<FirstRunState>('local:xmd-popup-intro', {
  fallback: { opens: 0, done: false },
})

/** Whether the first-run strip should render for a given stored state.
 *  Dismissal (whichever comes first, per spec §2.2): the user clicks the `×`
 *  (→ `markDone`), a Stage action completes successfully once (caller's
 *  responsibility to call `markDone`), or the popup has been opened more
 *  than `MAX_TEACHING_OPENS` times. */
export function shouldShowIntro(state: FirstRunState): boolean {
  return !state.done && state.opens <= MAX_TEACHING_OPENS
}

/** Records one popup open — call once per popup mount, before deciding
 *  whether to show the strip. */
export async function recordOpen(): Promise<FirstRunState> {
  const current = await introItem.getValue()
  const next: FirstRunState = { opens: current.opens + 1, done: current.done }
  await introItem.setValue(next)
  return next
}

/** Permanently dismisses the strip (the `×`, or a completed Stage action). */
export async function markDone(): Promise<FirstRunState> {
  const current = await introItem.getValue()
  const next: FirstRunState = { opens: current.opens, done: true }
  await introItem.setValue(next)
  return next
}
