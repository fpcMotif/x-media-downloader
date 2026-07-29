# ADR-0002 — Fire-and-track Download Queue for the MV3 service-worker lifecycle

- **Status:** Accepted (2026-06-07)
- **Superseded in part:** [Transfer Registry v4](../superpowers/specs/2026-07-18-transfer-registry-design.md)
  now owns durable transfer state, retry, and terminal recovery.

## Context

The MV3 background is an event-driven **service worker**: terminated after ~30s
idle, a single event/promise capped at 5 min, and **all in-memory state is lost**
on termination (grounding §b). A naive `Effect.forEach(items, downloadOne,
{concurrency})` that awaits every file to completion would blow the 5-min cap on a
large Bulk and lose its `Semaphore`/progress state when the worker recycles.

## Decision

The historical Download Queue **fired** `chrome.downloads.download()` (the browser's
download manager owns the transfer, outside the SW fetch lifecycle) and **tracked** it:

- Concurrency is bounded by a `Semaphore` over the number of in-flight download
  **starts**, not awaited completions.
- Progress/retry is driven by a top-level `chrome.downloads.onChanged` listener;
  byte progress is **polled** via `chrome.downloads.search({id})` (onChanged
  excludes `bytesReceived`).
- The queue itself persists no transfer truth. The later Registry persists intent,
  handle/GID correlation, retry state, and terminal work in `storage.local`, then
  reconciles browser rows and aria2 status after restart.

## Consequences

- A Bulk survives SW idle-recycle within a browsing session (the "5/5 complete"
  scenario holds); progress needs polling rather than a push stream.
- More moving parts (listener + poll + persistence) than an awaited loop.

## Historical note

The original `storage.session` queue was an interim design. The fire-and-track
rule remains; its former persistence owner does not.

## Amendment (2026-07-28)

The live **Start Queue** bounds strategy starts only. The Transfer Registry owns
durable intent, handle/GID correlation, retries, observations, and terminal
projection. This ADR retains its historical name and context.

## Alternatives considered

- **Awaited `Effect.forEach` to completion** — blows the 5-min cap, loses state.
- **Keep-alive / `setInterval` hacks** — fragile and discouraged by Chrome.
