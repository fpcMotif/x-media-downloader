# improve-react plans

All plans come from the vetted `improve-react` audit at commit `cf787c6`.
001–006, 009, and 010 are executed (landed on main via the PR-#55 absorb); 008
was landed and reverted (it broke the action-popup bubble — see the plan);
007 remains the one outstanding plan.

| Plan | Severity | Status | Depends on | Summary |
| --- | --- | --- | --- | --- |
| [001](001-block-forged-media-urls.md) | HIGH | DONE | — | Reject untrusted media URLs before storage, probing, or download. |
| [002](002-coalesce-pointer-hit-tests.md) | HIGH | DONE | — | Run at most one mouse hit-test per frame. |
| [003](003-own-saved-status-lifecycle.md) | MEDIUM | DONE | — | Gate, serialize, and dispose saved-status work and raw listeners. |
| [004](004-stop-popup-poll-after-unmount.md) | MEDIUM | DONE | — | Stop the popup metrics poll after unmount. |
| [005](005-announce-overlay-save-status.md) | MEDIUM | DONE | — | Expose badge and launcher progress to screen readers. |
| [006](006-debounce-video-recovery-scans.md) | MEDIUM | DONE | — | Move video recovery off every scroll frame. |
| [007](007-split-overlay-content-controller.md) | MEDIUM | NOT STARTED | 001, 002, 003, 005, 006 | Split the overlay view, interactions, capture, and message seams. |
| [008](008-support-320px-popup-reflow.md) | MEDIUM | REVERTED (broke the action bubble) | — | Let the popup reflow to 320 CSS px. |
| [009](009-replace-stale-feedback-timers.md) | LOW | DONE | 004 first | Cancel old feedback timers before rearming. |
| [010](010-name-sidebar-navigation.md) | LOW | DONE | 009 first | Name the Settings and Library navigation landmarks. |
| [011](011-extension-a11y-audit-and-reflow.md) | MEDIUM | DONE | — | Fix save-status live regions, WCAG 2.5.3 label matching, and bubble-safe popup shell. |

## Recommended order

1. Execute `001`, then `003`, `002`, `006`, and `005`.
2. Execute `004`, then `009`, then `010`.
3. Execute `008` at any time.
4. Execute `007` last. It moves code changed by five earlier plans.

Each plan is stamped to the same base commit. After any plan changes a file used
by the next plan, run `improve-react reconcile`. Do not apply stale line-based
instructions by guesswork.

## Shared completion gate

For every plan:

1. Run its focused tests.
2. Run `bun run typecheck`, `bun run lint`, and `bun run build`.
3. Run `npx --yes react-doctor@latest . --scope changed`.
4. Confirm no new React Doctor issue and no lower score. Rule-backed plans must
   clear their named diagnostic.
5. Perform the plan's browser behavior check.

