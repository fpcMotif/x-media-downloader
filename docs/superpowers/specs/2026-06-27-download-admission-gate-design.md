# Download Admission Gate — duplicate prevention + filters/caps

**Status:** Designed (2026-06-27), not built
**Topic:** A single pre-scheduling gate that decides whether each planned download is admitted or skipped — unifying per-tweet duplicate prevention and four download filters/caps.

## Problem

Two gaps in the current download path:

1. **Duplicate downloads.** The only guard is an in-memory `inFlight: Set<MediaItem.id>` ([background.ts:105,696](../../../src/entrypoints/background.ts)) that prevents _concurrent_ double-downloads and is cleared when a download settles. Scrolling past an already-saved post in a later session re-downloads it (the browser appends `(1)` to the filename). The `SavedIndex` machinery already answers "is this tweet saved?" (local-first → Convex backstop) but only feeds the timeline badge — it does not gate downloads.

2. **No download filters.** There is no user-configurable way to skip large files, skip a media type, skip tiny images, or cap total download volume. The only size logic is a non-configurable 96 MiB OOM guard inside the Fetched strategy.

Both are the same shape: _before scheduling, decide per planned download whether to admit or skip, and why._

## Decisions (locked during brainstorming)

| Decision             | Choice                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Dedup granularity    | **Per tweet** — reuses the existing tweetId-keyed `SavedIndex` + Convex `by_tweet` index; no new backend                           |
| On duplicate         | **Skip + show a count** (no force-override in v1)                                                                                  |
| Dedup data source    | Enabling dedup **auto-enables `downloadHistoryEnabled`**; Convex cross-device backstop stays opt-in (only when sync is configured) |
| Filters in scope     | Per-file size cap, daily total budget, media-type filter, min-resolution filter                                                    |
| Size-cap enforcement | **HEAD preflight probe** (content-length), strategy-agnostic, fail-open                                                            |
| Budget metric        | **Both** bytes and file count (whichever limit is reached first)                                                                   |
| Budget window        | **Per calendar day** (local), durable, auto-resets at midnight                                                                     |
| Scope of caps        | **All download paths uniformly** (single click, bulk, Quick Grab)                                                                  |
| Budget hit           | **Hard stop + notice** until the day rolls over or the user resets                                                                 |
| Default state        | Every filter/cap independently toggleable, **all default off** → gate is a pass-through, identical to today                        |

## Architecture: the Admission Gate

The gate sits at the existing seam in [background.ts:688-696](../../../src/entrypoints/background.ts), between `planDownloads()` and `queue.enqueue()`:

```
planDownloads()  →  ADMISSION GATE  →  queue.enqueue(admitted)
                         │
                         └─→ skipped: { req, reason }[]  →  UI summary count
```

It splits into a **pure decision core** and a **thin async shell**, matching the codebase's `decideSettle` / `makeSavedIndex` pattern.

### Pure core — `src/core/download/admission.ts`

No I/O, fully unit-testable.

```ts
export type SkipReason = 'duplicate' | 'filtered-type' | 'too-small' | 'too-big' | 'daily-budget'

export type AdmissionDecision = { admit: true } | { admit: false; reason: SkipReason }

export interface AdmissionContext {
  readonly settings: FilterSettings // the new Settings fields
  readonly savedTweetIds: ReadonlySet<string> // tweets already saved (per-tweet dedup)
  readonly sizeBytes: number | null // probed content-length, or null if unknown/not probed
  readonly budget: { bytes: number; count: number } // running projection for THIS pass
}

export function evaluateAdmission(item: MediaItem, ctx: AdmissionContext): AdmissionDecision
```

**Check order (cheapest first — each stage shrinks what the next pays for):**

1. **Media-type** — `item.type ∈ settings.skipTypes` → `filtered-type`. Free (metadata).
2. **Min-resolution** — `item.width/height` present and below `minWidth`/`minHeight` → `too-small`. Free; absent dimensions pass (fail-open).
3. **Duplicate** — `ctx.savedTweetIds.has(item.tweetId)` → `duplicate`.
4. **Per-file size** — `ctx.sizeBytes != null && sizeBytes > maxFileSizeMB*MiB` → `too-big`. Unknown size passes (fail-open).
5. **Daily budget** — admitting this item would push `budget.bytes` past `dailyMaxBytes` **or** `budget.count` past `dailyMaxCount` → `daily-budget`.

**Precedence:** first failing check wins the reason (deterministic; tested explicitly). Disabled settings (off/zero) skip their check.

### Async shell (in background)

Owns the I/O the pure core forbids:

- **Dedup input:** `SavedIndex.resolve(tweetIds, queryConvex)` → the saved subset → `savedTweetIds`. Local Set first; Convex `by_tweet` backstop only for unknown ids, only when sync configured. Never throws (degrades to local).
- **Size input:** a new injected port `SizeProbePort { probe(url): Promise<number | null> }` — a HEAD request reading `content-length`. Invoked **only** when `maxFileSizeMB` _or_ `dailyMaxBytes` is set, and **only** for candidates that survived the free filters and dedup. Returns `null` on missing header / error (fail-open).
- **Budget input:** the durable daily-tally store (below).

The shell walks candidates in order, builds `AdmissionContext` per item (maintaining the running budget projection), calls `evaluateAdmission`, and returns `{ admitted: PlannedDownload[], skipped: { req, reason }[] }`. `admitted` flows to `queue.enqueue`; `skipped` is summarized for the UI.

## Feature 1 — Per-tweet duplicate prevention

- Setting `preventDuplicateDownloads` (default off). Enabling it auto-enables `downloadHistoryEnabled` and the settings copy states the dependency.
- Reuses 100% of the B+C `SavedIndex` machinery — **no new Convex index or query** (`by_tweet` + `queryDownloadedAmong` already exist).
- A saved tweet → all its media skipped with `reason: 'duplicate'`. Re-download requires clearing history (no v1 override).

## Feature 2 — Filters & caps

Four independent gates, each its own setting:

| Filter            | Setting(s)                               | Enforced via                                 | Skip reason     |
| ----------------- | ---------------------------------------- | -------------------------------------------- | --------------- |
| Media-type        | `skipTypes: ('video'\|'gif'\|'photo')[]` | `MediaItem.type` (free)                      | `filtered-type` |
| Min-resolution    | `minWidth`, `minHeight`                  | `MediaItem.width/height` when present (free) | `too-small`     |
| Per-file size cap | `maxFileSizeMB`                          | HEAD preflight → content-length              | `too-big`       |
| Daily budget      | `dailyMaxMB`, `dailyMaxCount`            | durable per-day tally                        | `daily-budget`  |

### Daily-budget store — `src/core/download/daily-budget.ts`

- Durable state uses an exact bounded v1 envelope in `local:daily-budget`:
  `{ version: 1, record: { day, bytes, count, creditedReceiptIds, resetAt } }`.
  The two prior exact bare shapes migrate. Unknown versions, excess fields, and
  corrupt values are quarantined.
- One background owner serializes reads, migrations, completion credits, and
  reset. A stable terminal projection ID credits once. Receipt count and total
  JSON bytes are capped.
- `readTodayForAdmission()` fails closed when another worst-case valid receipt
  cannot fit. New launches stop before terminal projection can exceed storage.
- **Accounting timing:** incremented on **download completion**. Failed or
  interrupted downloads never consume budget. A terminal rejected at capacity
  stays pending in the Transfer Registry.
- **In-pass projection:** to enforce tightly within a single bulk grab before any completion lands, the admission pass seeds `budget` from `readToday()` and adds each item it admits this pass. Once the projection would cross either limit, remaining items are skipped `daily-budget`.
- **Byte count source at completion:** actual `bytesReceived` when available (from the completion/metrics path), else the probed `content-length`, else 0.
- Settings exposes a **"reset today"** button. Reset clears receipts and writes
  a monotonic `resetAt` fence, so an old terminal replay cannot restore usage.
  Explicit reset may replace corrupt state. Day rollover safely starts a new
  record.

**Known limit:** two bulk grabs fired before completions land can share the same
persisted usage projection. User-configured byte/count limits may overshoot.
The durable receipt-capacity guard still stops launches once its ledger is full.

## Settings & UI

- New fields on the `Settings` struct ([src/core/schema/index.ts](../../../src/core/schema/index.ts)), all default off/zero: `preventDuplicateDownloads`, `skipTypes`, `minWidth`, `minHeight`, `maxFileSizeMB`, `dailyMaxMB`, `dailyMaxCount`. (Persisted settings are MB-valued and user-friendly; the gate converts `maxFileSizeMB`/`dailyMaxMB` to bytes internally.)
- The daily tally is **not** in `Settings` (it's runtime state, separate key).
- New options panel `src/entrypoints/options/panels/filters.tsx` ("Downloads & Filters"): the dedup toggle (with its auto-enables-history note), the four filters, and today's usage with the "reset today" button. Keeps `general.tsx` from growing further.

## Skipped feedback channel

Skipped items never enter the queue, so `handleDownload` returns a `skipped` summary alongside its existing per-request outcomes. The overlay surfaces it where the current "saved/queued" feedback shows — e.g. _"5 downloaded · 3 skipped (2 already saved, 1 too big)"_, aggregated by reason.

## Error handling & edge cases

- Probe failure / no `content-length` → fail-open (allowed; 0 bytes toward budget).
- Convex dedup query failure → degrade to local set (existing `SavedIndex.resolve` behavior; never throws, never blocks).
- Day rollover mid-session → tally auto-resets on next read.
- Auth-gated media → HEAD may 401; fail-open covers it (size cap can't apply to media we can't measure — documented limitation).
- All filters off → gate is a pass-through; zero added latency, no probes, identical to today.

## Testing

- **`evaluateAdmission`** — exhaustive table tests per reason and precedence (e.g. `duplicate` before `too-big` when both apply); disabled-setting short-circuits. Fits the 100% `src/core` coverage gate.
- **`daily-budget`** — fake clock: day-rollover reset, projection/overshoot, byte+count whichever-first.
- **Shell** — fake `SavedIndex`, fake `SizeProbePort`, fake budget store: assert ordering (free filters before probes), fail-open paths, the skipped-summary shape, and that probes run only when size/byte-budget settings are active.

## Implementation sequence (for the plan)

1. Gate skeleton: pure `evaluateAdmission` + `AdmissionContext` + shell wiring at the `planDownloads → enqueue` seam (all checks no-op until settings added).
2. Per-tweet dedup gate (wire `SavedIndex` + auto-enable history).
3. Metadata filters (type, min-resolution).
4. Size cap (`SizeProbePort` + HEAD).
5. Daily budget (`daily-budget` store + completion-hook accounting + projection).
6. Settings schema + `filters.tsx` panel + skipped-summary UI surface.

## Non-goals (v1)

- Force/override re-download of duplicates.
- Per-file-level (media-key) dedup — explicitly per-tweet.
- Cross-batch budget reservations (the overshoot edge above).
- Estimating image byte size without a probe.
