# ADR-0014 — Transfer Tracker: durable outcome ledger + badge backlink

- **Status:** Accepted (2026-06-20)

## Context

Download success was declared at **queue-start**. The Overlay marked the badge
`saved` the instant `enqueue` reported `completed === total` — which only means
"every request was handed to the browser downloader," not "bytes landed." The
**real** terminal state (complete / interrupted / 403 / timeout) is observed later,
in the module-level `downloads.onChanged` listener, and **no message carried that
outcome back to the UI** — so a transfer that 403'd seconds after hand-off still
showed a green check (the `download-handoff-interruption-blind-spot`).

A second, deeper gap: the `downloadId → requestId` correlation lived only in SW
memory (`requestIdByDownloadId`). MV3 recycles the worker after ~30s idle
(ADR-0002), so a download that **completed or failed while the worker was dead**
was lost entirely — no metric, no history, no Cloud Sync event. ADR-0002 mandates
"rehydrate persisted queue state and reconcile against `downloads.search` on worker
restart," but only the interrupt-retry queue was being rehydrated; live transfers
were not reconciled.

## Decision

Introduce a **Transfer Tracker** that owns the span from `Download Handle` →
terminal outcome.

- **A pure ledger module** (`core/download/transfer-tracker.ts`): a durable set of
  in-flight browser transfers (`{ id, downloadId, tweetId?, startedAt }`) with
  `trackTransfer` / `settleTransfer` (both idempotent), `correlationFrom` (rebuilds
  the SW-memory map the recycle destroys), and `reconcile(state, rows)` which
  classifies each tracked transfer against `downloads.search` rows
  (`classifyTransfer`: a `complete` row is a success only if its file still
  `exists`; `interrupted`/deleted → failed; missing row → `unknown`, never a
  fabricated outcome). Pure (no `chrome.*`, no timers), unit-tested like
  `metrics.ts`.
- **A durable ledger** in `storage.session` (`session:transfers`), written at every
  mutation (track on browser-start and on retry success; settle on terminal /
  interrupt). On boot, `reconcileTransfersOnBoot` searches each tracked transfer
  and surfaces the outcomes that landed in the dead window (recording them to
  metrics/history/sync and announcing them), then re-seeds the correlation map for
  the still-in-progress transfers.
- **A backlink message** (`TransferOutcome { requestId, outcome, at }`,
  schema/index.ts): broadcast fire-and-forget to every open X tab on a terminal
  browser outcome. The Overlay corrects the entrance that fired it
  (`badge.resolveOutcome` / `launcher.resolveOutcomeAll`), guarded by request-id +
  live media-key match; a dead tab or an entrance that moved on is a silent no-op
  (the `refreshMediaUrlFromTabs` dead-receiver pattern). `requestId` is the
  `SaveRequest.id` (== `MediaItem.id`); `.json` sidecars are never announced.

### Bounded scope (decisions, deliberately)

- **Full module vs. minimal message** — built the tracker AND the message, but
  bounded: the durable ledger + reconcile + backlink. The intertwined imperative
  lifecycle (`completeBrowserDownload`/retry loop and their `live`/clear-ledger/
  sync side-effects) was **left in `background.ts`** — moving it earns little and
  cannot be verified without running the extension; the bug does not require it.
- **Storage-backed, not in-memory** — non-negotiable per ADR-0002; an in-memory
  tracker reintroduces the exact recycle blind spot it exists to fix.
- **`DownloadHandle` kept as a one-shot receipt** — the browser/aria2 observation
  asymmetry stays in the tracker, not pushed into `DownloadStrategy.save`.
- **aria2 outcome observation deferred** — aria2 hand-offs are terminal at enqueue
  (ADR-0006, no `tellStatus`); they never enter the ledger and emit no backlink.
  The discriminated handle keeps the door open for a future `tellStatus` tracker.

## Consequences

- The badge/launcher reflect a **real** terminal outcome, not just a hand-off.
- Outcomes that land during an SW recycle are **recovered** on the next boot
  (closes the ADR-0002 reconcile gap), recorded durably and announced.
- The `onChanged` guard was relaxed from `id === undefined || !live` to
  `id === undefined`, so a reconciled in-progress transfer's later terminal state
  is still captured even when the ephemeral metrics accumulator is null (byte-sample
  writes stay `live`-guarded; `recordOutcome` idempotency prevents double-counting).
- New pure test surfaces (`transfer-tracker`, `badge.resolveOutcome`,
  `launcher.resolveOutcomeAll`) cover logic that was previously only reachable
  through `chrome.*` listeners.

## Known limitations

- The badge is per-entrance and reverts after ~1.6s; a late outcome only corrects
  it while the same media is still on screen. The durable metrics/history/sync
  records are the truthful surfaces for outcomes that arrive after the badge is
  gone.
- A `complete` record purged by Chrome before reconcile is classified `unknown`
  (traced, not recorded) — neither a false success nor a false failure.
- Launcher backlink downgrades the pill but does not re-arm its revert timer.

## Alternatives considered

- **Targeted send to the originating tab** (persist `sender.tab.id`) — more precise
  than broadcast, but adds state; the broadcast + per-entrance guard is sufficient
  and simpler for v1.
- **Forklift the whole lifecycle into the tracker** — rejected as scope creep
  (ADR-0002/0008 stay intact; the imperative `live`/clear coupling is unverifiable
  off-device).
