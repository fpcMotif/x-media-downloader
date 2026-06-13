# Task 009: Popup history section helpers — test

**Type:** test
**depends-on:** ["002", "006"]
**Files:**
- `src/entrypoints/popup/history-section.test.ts` (create — pure helpers)

## Objective
Write failing (Red) tests for the pure helpers that drive the "Download history" popup section: grouping records by author, formatting a record for display, and the empty/disabled states. Extracting pure helpers keeps the Preact component thin and testable (repo convention). OUT of scope: rendering JSX, background messaging.

## Contract (signatures & types ONLY)
```ts
import type { DownloadRecord } from '../../core/history/record'

export function groupByAuthor(records: ReadonlyArray<DownloadRecord>): ReadonlyArray<{
  handle: string
  records: ReadonlyArray<DownloadRecord>
}> // newest-first within and across groups

export function formatRecord(r: DownloadRecord): {
  title: string        // e.g. filename
  link: string         // r.media.url (the original link)
  status: DownloadRecord['status']
  when: string         // human time from finishedAt ?? queuedAt
}

export function historyEmptyLabel(enabled: boolean, count: number): string
// enabled=false → "Turn on to keep a local history"; enabled && count===0 → "No downloads yet"; else ""
```

## BDD Scenarios
```gherkin
Scenario: Records group by author, newest-first
  Given records for two handles with interleaved timestamps
  When groupByAuthor(records) is called
  Then records are grouped by handle and ordered newest-first within each group

Scenario: A record formats with its original link and status
  Given a completed DownloadRecord
  When formatRecord(r) is called
  Then link equals r.media.url, status is "completed", title is the filename, when is derived from finishedAt

Scenario: Empty/disabled labels
  Given the toggle is off
  Then historyEmptyLabel(false, 0) returns the "turn on" prompt
  Given the toggle is on with no records
  Then historyEmptyLabel(true, 0) returns "No downloads yet"
  Given the toggle is on with records
  Then historyEmptyLabel(true, n>0) returns ""
```

## Steps
1. Create the test importing helpers from `./history-section` (does not exist → Red) and `DownloadRecord` from `../../core/history/record`.
2. Build records via the `core/history` builders with explicit timestamps.
3. Assert grouping order, formatting (esp. `link === media.url`), and the three label states.

## Verification
- `bun run test src/entrypoints/popup/history-section.test.ts` — **fails (Red)** until `history-section.ts` exists.

## Notes
- Pure helpers only; no DOM, no `browser.*`. Follow the existing popup pure-formatter style (e.g. `popup-layout.test.ts` / `fmt*` helpers in `App.tsx`).
