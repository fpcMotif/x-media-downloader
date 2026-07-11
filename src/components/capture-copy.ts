// Shared copy/formatting for the capture surfaces (options Capture/Archive panels,
// popup quick actions, popup App). Downstream of capture-export.ts: this module is
// pure string builders only — no JSX, no state, nothing stateful (see the
// capture-copy handoff for why flashStatus stays put in each consumer).

export const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

export const fmtDay = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

// Erase (Tier 1 — local data wipe) is the verb; "Clear" is retired from every
// user-facing surface (2026-07-11 Stage redesign, design contract line 3).
export const confirmEraseArchiveCopy = (count: number): string =>
  `Erase all ${plural(count, 'captured tweet')}? This cannot be undone.`

export const erasedArchiveCopy = (count: number): string =>
  `Erased ${plural(count, 'tweet')} from the archive.`
