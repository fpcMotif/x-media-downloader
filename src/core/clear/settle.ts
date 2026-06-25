/**
 * Settle gate — the pure verdict that decides whether a recorded download
 * `complete` TRULY landed on disk, gating the irreversible Clear (un-bookmark /
 * un-like).
 *
 * The background SW records `complete` the moment `downloads.onChanged` reports
 * it, but a late post-complete `interrupted` (or a file the user deleted before
 * the SW looked) means the byte never actually landed. Before the Clear fires,
 * the coordinator re-probes the download via the **Settle Port** and asks this
 * module the one question that authorizes an irreversible action: did it land?
 *
 * Pure: no `chrome.*`, no timers. The probe arrives as plain data (real
 * `chrome.downloads.search` in the SW; a fixture row in tests — the two adapters
 * that earn the port), and the verdict maps onto the Completion Ledger's `Settle`
 * / `LateInterrupt` actions. A missing probe (`undefined` — the search found no
 * row, or threw and the adapter swallowed it) is NOT a settle: fail closed, so
 * the Clear never fires on a download whose landing we couldn't confirm.
 */

/** The minimal `chrome.downloads.search` row the settle gate reads — just the two
 *  fields that decide whether the byte landed. Wider `DownloadItem`s satisfy it. */
export interface DownloadProbe {
  readonly state?: string
  readonly exists?: boolean
}

/** Which Completion Ledger action a settle check resolves to: `settle` confirms
 *  the byte landed (the Clear may proceed); `lateInterrupt` retracts the recorded
 *  completion (the Clear must not fire). */
export type SettleVerdict = 'settle' | 'lateInterrupt'

/**
 * Did the download truly land? `complete` AND not known-missing — `exists`
 * `undefined` means the browser didn't report deletion, treated as present. A
 * missing probe, an interrupted/in-progress row, or a vanished file (`exists:
 * false`) all fail closed.
 */
export const didLand = (probe: DownloadProbe | undefined): boolean =>
  probe?.state === 'complete' && probe.exists !== false

/** The settle verdict for a probed download — the sole gate on the irreversible Clear. */
export const decideSettle = (probe: DownloadProbe | undefined): SettleVerdict =>
  didLand(probe) ? 'settle' : 'lateInterrupt'
