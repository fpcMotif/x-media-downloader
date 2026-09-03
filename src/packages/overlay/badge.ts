/** Phases of the per-media download badge (Overlay fast path): one entrance at a time. */
export type BadgePhase = 'hidden' | 'shown' | 'nudged' | 'queued' | 'saved' | 'failed'

import type { MediaType } from '@/packages/schema'

const MEDIA_NOUN = {
  photo: 'photo',
  video: 'video',
  gif: 'GIF',
} satisfies Record<MediaType, string>
const MEDIA_TITLE = {
  photo: 'Photo',
  video: 'Video',
  gif: 'GIF',
} satisfies Record<MediaType, string>

/** Accessible button name per phase+type — state and action stay truthful. */
export function badgeAriaLabel(phase: BadgePhase, type: MediaType): string {
  const noun = MEDIA_NOUN[type]
  if (phase === 'queued') return `Saving ${noun}`
  if (phase === 'saved') return `${MEDIA_TITLE[type]} saved`
  if (phase === 'failed') return `Retry ${noun} download`
  return `Download ${noun}`
}

/** Polite live-region text per phase+type; idle phases stay silent. */
export function badgeStatusMessage(phase: BadgePhase, type: MediaType): string {
  const noun = MEDIA_NOUN[type]
  if (phase === 'queued') return `Saving ${noun}.`
  if (phase === 'saved') return `${MEDIA_TITLE[type]} saved.`
  if (phase === 'failed') return `${MEDIA_TITLE[type]} save failed. Retry available.`
  return ''
}

/**
 * Badge entrance state. `key` is the twimg media key the badge is anchored to;
 * `null` only while hidden. One entrance exists at a time — entering new media
 * replaces it wholesale.
 */
export interface BadgeState {
  readonly phase: BadgePhase
  readonly key: string | null
}

/** Unclicked dwell before the badge plays its single two-hop nudge. */
export const badgeNudgeDelayMs = 2200

/** How long the saved confirmation lingers before reverting to the idle arrow. */
export const badgeSavedRevertMs = 1600

export const hiddenBadge: BadgeState = { phase: 'hidden', key: null }

/** Inputs that gate badge visibility, resolved by the caller per hover. */
export interface BadgeVisibilityInput {
  readonly enabled: boolean
  readonly resolvable: boolean
  readonly modifierHeld: boolean
}

/**
 * Whether the badge may appear at all: setting on, hovered media resolvable to
 * a Media Item, and the Quick Grab modifier not held (one affordance at a time).
 */
export function canShowBadge(input: BadgeVisibilityInput): boolean {
  return input.enabled && input.resolvable && !input.modifierHeld
}

/**
 * Move the entrance to `key`. Re-entering the media of the current entrance
 * never resets an in-flight phase; a different key replaces the entrance even
 * mid-save; anything unshowable (setting off, unresolvable, modifier held)
 * hides the badge.
 */
export function enterMedia(
  state: BadgeState,
  key: string,
  input: BadgeVisibilityInput,
): BadgeState {
  if (!canShowBadge(input)) return hiddenBadge
  if (state.key === key && state.phase !== 'hidden') return state
  return { phase: 'shown', key }
}

/** The pointer left the media: the entrance — whatever its phase — is over. */
export function leaveMedia(state: BadgeState): BadgeState {
  return state.phase === 'hidden' ? state : hiddenBadge
}

/** Play the one attention nudge of this entrance; only a still-idle badge nudges. */
export function nudgeBadge(state: BadgeState): BadgeState {
  return state.phase === 'shown' ? { phase: 'nudged', key: state.key } : state
}

/** A click hands the item to the queue; failed retries, in-flight and saved don't re-fire. */
export function beginSave(state: BadgeState): BadgeState {
  return state.phase === 'shown' || state.phase === 'nudged' || state.phase === 'failed'
    ? { phase: 'queued', key: state.key }
    : state
}

/** The background's start ack (or failure) resolves an in-flight queue, nothing else. */
export function resolveSave(state: BadgeState, ok: boolean): BadgeState {
  return state.phase === 'queued' ? { phase: ok ? 'saved' : 'failed', key: state.key } : state
}

/**
 * A LATE terminal outcome (bytes actually landed / 403 / timeout), arriving after
 * the start ack already flipped the badge to `saved`. Corrects the optimistic
 * `saved` — the start ack only meant "handed to the browser", not "on disk". A
 * still-`queued` entrance is resolved too; an entrance that has moved on, reverted
 * to the idle arrow, or already failed is left untouched. The caller guarantees
 * the outcome belongs to THIS entrance (same request id and live media key).
 */
export function resolveOutcome(state: BadgeState, ok: boolean): BadgeState {
  if (state.phase !== 'saved' && state.phase !== 'queued') return state
  const phase = ok ? 'saved' : 'failed'
  // A confirmed complete on an already-saved badge is a no-op: keep the SAME
  // reference so the caller doesn't cancel the pending saved→shown revert timer.
  return phase === state.phase ? state : { phase, key: state.key }
}
