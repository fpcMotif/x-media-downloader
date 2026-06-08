# ADR-0008 — Download-efficiency monitoring: pure reducer + poll transport

- **Status:** Accepted (2026-06-08)

## Context

Users want **download-efficiency monitoring**: throughput, ETA, success/fail/retry
rates, concurrency utilization. Two MV3 facts shape the design (grounding §b, §d):

- **Byte progress is not in `downloads.onChanged`** — it must be polled via
  `downloads.search({ id })` (guard `totalBytes === -1`).
- The **SW dies after 30s idle**; in-memory state is lost. Live progress must be
  pollable by the popup against persisted state, not held in a long-lived stream.

## Decision

- Model metrics as a **pure reducer** (`core/download/metrics.ts`) over timestamped
  samples + state transitions → a `MetricsSnapshot`. No Effect, no I/O; **timestamps
  are injected** (`recordSample`/`recordOutcome`/`snapshot(state, now)`), so the math
  is exhaustively unit-tested with synthetic streams.
- **Throughput** is a rolling average over a 5 s window (ref = most recent timeline
  point at/before `now − window`, else earliest); **ETA** = remaining / throughput,
  emitted only when throughput > 0 and totals are known (the key is omitted
  otherwise, respecting `exactOptionalPropertyTypes`).
- **Transport is poll-on-demand**: the background SW persists the latest
  `MetricsSnapshot` to `storage.session` (ADR-0005) and answers a `MetricsRequest`
  message with it; the popup polls (~1 s) and renders counters. No long-lived port.

## Consequences

- The metric math is framework-agnostic and locked by tests; it can be fed from any
  sample source.
- Survives SW recycle (snapshot in `storage.session`); resets on browser close —
  acceptable for within-session monitoring.
- **Remaining integration:** the live byte-sampling loop (`downloads.search` under a
  `chrome.alarms` cadence → `recordSample`, plus mapping `downloadId → request id`)
  is **not yet wired**. Today the SW seeds a snapshot at queue start and writes a
  terminal snapshot (counts) at queue end; throughput/ETA stay zero until the
  sampling loop lands. The reducer is ready for it.

## Alternatives considered

- **Effectful metrics service** — unnecessary ceremony for pure math; rejected in
  favor of plain functions (resolver/filename precedent).
- **Long-lived `runtime.connect` progress stream** — dies silently on SW recycle
  (grounding §b); poll-on-demand was chosen instead.
- **`onChanged`-only progress** — impossible; `onChanged` excludes `bytesReceived`.
