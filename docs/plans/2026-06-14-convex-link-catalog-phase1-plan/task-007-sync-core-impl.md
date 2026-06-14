# Task 007 — Sync core (impl / Green)

- **type:** impl
- **depends-on:** ["006"]
- **files:** `src/core/sync/machine.ts` (new, lifted + trimmed), `src/core/sync/index.ts` (new)

## Objective

Lift the validated `study/cloud-sync-prototype/machine.ts` into `src/core/sync/machine.ts`,
**trimming to the Phase-1 slice**: keep the capture decision, the durable-queue entry shape, dedupe,
and a 3-state rollup. **Drop** `UploadJob`, `Provider`, lease/`attempt`/`backoff`/`recycle` — those
are Phase 2 (presign byte path) and must not ship in Phase 1. Keep it pure (no I/O, no console).

## Contracts (signatures only — no bodies)

```ts
export type SyncTrigger = 'onDownload' | 'onDemand' | 'both'
export type CaptureSource = 'download' | 'on-demand'
export type ItemSyncState = 'pending' | 'safe' | 'failed'

export interface CaptureEntry { mediaId: string; source: CaptureSource; item: MediaItem; at: number }
export interface CaptureDecision { enqueue: boolean; reason: string }

export function decideCapture(
  settings: { cloudSyncEnabled: boolean; syncTrigger: SyncTrigger },
  source: CaptureSource,
): CaptureDecision

export function dedupeQueue(queue: CaptureEntry[], entry: CaptureEntry): CaptureEntry[]
export function rollup(states: ItemSyncState[]): { safe: number; pending: number; failed: number }
```

## BDD Scenario

```gherkin
Scenario: A completed download auto-captures only when the trigger opts in
  Given cloudSyncEnabled is true and syncTrigger is "onDemand"
  When a download-complete capture is decided
  Then enqueue is false
  When syncTrigger is "onDownload" and the decision is retried
  Then enqueue is true

Scenario: The on-demand backup button always captures while sync is on
  Given cloudSyncEnabled is true and syncTrigger is "onDownload"
  When an on-demand capture is decided
  Then enqueue is true
```

## Steps

1. Copy the gate/trigger logic and `CaptureEntry`/dedupe from the prototype; remove all upload-job,
   provider, lease, attempt, backoff, and recycle code.
2. Implement `rollup` over `ItemSyncState[]`.
3. Re-export the public surface from `src/core/sync/index.ts`.

## Verification

- `bun run test src/core/sync` → **GREEN**.
- `bun run typecheck` passes; no references to Phase-2 types remain.
