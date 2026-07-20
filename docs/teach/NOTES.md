# Teaching notes

## User preferences
- **Be extremely concise** (global instruction). Lessons: dense, example-first, minimal preamble.
- Learns best from **real code in this repo** (x-media-downloader). Always ground examples in their actual functions.
- Strong engineer; do not re-explain TS generics, discriminated unions, or basic FP.
- **Teaching-first (reaffirmed session 5):** mastery of monadic/categorical thinking is the goal; codebase edits are *illustrative vehicles*, runnable demos — NOT deliverables. Do not propose big risky production refactors as "the work." Showcase the pattern in `src/core/teach/` (runnable, deletable), reference the real code as the "before."

## Calibration (open)
- Math/CT background and appetite for formal rigor (proofs vs intuition) — **ask in session 1** and record as a learning record + update MISSION.

## Workspace
- Located at `docs/teach/` inside the project (not repo root, to avoid clutter). Untracked; not committed unless the user asks.
- Lessons open in browser; they are printable/offline (system serif fonts, no external CDN).

## Pedagogy reminders
- Knowledge first (cite sources), then retrieval-practice quiz with immediate feedback.
- Tie every lesson to the mission: reason about + defend monadic design in their codebase.
- Their Phase 4 *curation* (declining the resolve chain) is a recurring teachable example of the "don't over-apply" wisdom (Wlaschin's caveat).
