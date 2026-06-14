# Task 007 (doc): CONTEXT.md vocabulary + ADR-0015

- **Type:** doc
- **depends-on:** []
- **Files:** `CONTEXT.md` (add nouns/action); `docs/adr/0015-extension-initiated-ui-actions.md` (new)

The grill-with-docs outcome (spec §5): this feature adds vocabulary the domain glossary lacks and a behavioral class no ADR covers.

## CONTEXT.md additions

- **Like** — the user's "like" engagement state on a Tweet (an X surface, distinct from a Media Item).
- **Bookmark** — the user's "bookmark" engagement state on a Tweet. *(Noun documented now; un-bookmark behavior deferred — see ADR-0015 / design spec §6.)*
- **Clear-on-save** — removing a post from a saved list (v1: **un-like** on the Likes page) once **all** its downloaded Media Items are confirmed saved to disk. The first action where the extension *acts on* X rather than reading it.

Keep the glossary style: definitions only, no implementation detail.

## ADR-0015 — Extension-initiated UI actions (clear-on-save)

Use the existing ADR format (status, context, decision, consequences, alternatives). Content:

- **Status:** Accepted (2026-06-15).
- **Context:** ADR-0001 established passive-first extraction — *issues no extra network requests*, only reads. Clear-on-save needs the extension to **mutate X state** (un-like) for the first time.
- **Decision:** The extension may synthesize a click on a control **the user could click themselves**, but only: (a) on the user's own list surface (Likes), (b) after the user's own download is **confirmed complete** (`onChanged` `complete`, never the hand-off badge), (c) issuing **no direct API calls** — X issues its own request exactly as for a manual click, (d) gated by a default-off setting, (e) one synthesized action per user download, never enumerating.
- **Consequences:** A new "write" seam (`adapters/x/actions.ts`) and the trust requirement that completion be genuinely confirmed. Un-bookmark is **deferred**: live verification found no inline un-bookmark control on the Bookmarks list (only the detail page), and a detail-page navigation dance would violate the "minimal, user-equivalent, non-disruptive" boundary under silent mode.
- **Alternatives considered:** direct GraphQL mutation (rejected — violates passive-first / no-API); detail-page navigation for un-bookmark (rejected for v1 — disruptive, scroll-loss).

## Verification

- Both files updated; `CONTEXT.md` reads consistently (definitions only).
- ADR file present at `docs/adr/0015-extension-initiated-ui-actions.md` following the format of `docs/adr/0001-passive-first-extraction.md`.
- No code/test dependency — this task can land in parallel.
