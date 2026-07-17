/** Phases of the global Download-all launcher: one batch hand-off in flight at a time. */
export type LauncherPhase = 'idle' | 'queued' | 'saved' | 'failed'

/** How long the saved confirmation lingers before the pill collapses back to idle. */
export const launcherSavedRevertMs = 1600

/** How long the failure notice lingers; idle re-offers the same action, so it may expire. */
export const launcherFailedRevertMs = 4000

/** Arm a send-all hand-off: idle → queued (one in flight). A failed batch may
 *  be retried (failed → queued — the visible Retry affordance is real); a click
 *  while queued or while a confirmation still lingers is a no-op. */
export function beginSendAll(phase: LauncherPhase): LauncherPhase {
  return phase === 'idle' || phase === 'failed' ? 'queued' : phase
}

const mediaItemCount = (count: number): string =>
  `${count} media ${count === 1 ? 'item' : 'items'}`

/** Accessible pill name per phase — state and action stay truthful. */
export function launcherAriaLabel(phase: LauncherPhase, count: number): string {
  if (phase === 'queued') return `Saving all detected media (${count})`
  if (phase === 'saved') return `All detected media saved (${count})`
  if (phase === 'failed') return `Retry all detected media (${count})`
  return `Download all detected media (${count})`
}

/** Polite live-region text per phase; idle stays silent. */
export function launcherStatusMessage(phase: LauncherPhase, count: number): string {
  if (phase === 'queued') return `Saving ${mediaItemCount(count)}.`
  if (phase === 'saved') return `${mediaItemCount(count)} saved.`
  if (phase === 'failed') return 'Some media failed to save. Retry available.'
  return ''
}

/** The background's start ack (or failure) resolves an in-flight queue, nothing else. */
export function resolveSendAll(phase: LauncherPhase, ok: boolean): LauncherPhase {
  return phase === 'queued' ? (ok ? 'saved' : 'failed') : phase
}

/** Expire a settled confirmation back to idle; idle and in-flight stay put. */
export function settleLauncher(phase: LauncherPhase): LauncherPhase {
  return phase === 'saved' || phase === 'failed' ? 'idle' : phase
}

/**
 * A LATE per-item outcome for the batch still on screen, arriving after the start
 * ack flipped the pill to `saved`. ANY real failure downgrades a `saved`/`queued`
 * pill to `failed` — the batch can't be a clean success if one item never landed.
 * A success leaves the pill as-is (other items may still be in flight, and the
 * pill is already `saved`). Idle / already-failed are untouched. The caller
 * guarantees the outcome belongs to the current batch.
 */
export function resolveOutcomeAll(phase: LauncherPhase, ok: boolean): LauncherPhase {
  if (ok) return phase
  return phase === 'saved' || phase === 'queued' ? 'failed' : phase
}
