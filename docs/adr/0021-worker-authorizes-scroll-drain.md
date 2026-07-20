# ADR-0021 — The worker authorizes Scroll Drain

- **Status:** Accepted (2026-07-16)

## Context

When a Tweet is not mounted, an Overlay currently starts Scroll Drain before
the worker finishes checking other tabs. Another tab may then Clear the same
Tweet. The first tab's Drain can later Clear it again.

## Decision

The worker is the sole authority that starts Scroll Drain for download-gated
Clear.

Overlays report whether the Tweet is mounted. They do not start Drain while
the worker is still checking tabs. The worker first tries immediate Clear in
eligible tabs. Only when none can Clear does it choose one eligible list tab
and ask that tab to run Scroll Drain.

That Drain attempt is not fire-and-forget. Its success or failure returns to
the worker through the Clear session's existing claim/resolve latch. The
worker retains ownership until the attempt reaches a terminal result.

## Consequences

- One Clear attempt owns not-mounted recovery.
- A tab cannot race eager Drain against another tab's immediate Clear.
- The tab protocol must separate “not mounted” from “start Drain.”
- Drain completion must be represented in the tab protocol.
- Worklist state and the per-scope claim latch resolve from the same result.
- DOM click and scroll behavior remain in the Overlay. The worker only decides
  when and where Drain starts.

## Alternative rejected

Let every not-mounted Overlay start Drain immediately. This is simpler, but it
has no single owner and permits duplicate Clear side effects across tabs.

Let the worker start one Drain but treat it as fire-and-forget. This avoids the
cross-tab start race, but abandons the claim latch and can leave durable
worklist state stale after a successful Clear.
