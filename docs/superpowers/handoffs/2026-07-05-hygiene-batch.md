# Handoff: Round-4 hygiene batch

- **Date:** 2026-07-05 · **Origin:** round-4 /improve-codebase-architecture (8 survey lenses → 21
  adversarial skeptics → survivors grilled; decisions adjudicated by the lead architect)
- **Status:** READY — not started. **Branch discipline:** implement on a fresh branch off main (or the
  current branch per the user's instruction at execution time); this handoff is self-contained.
- **Skeptic tally:** card deletion verified mechanically by the lead architect (zero importers, checked
  twice); rename salvaged as the one keeper from the killed CloudRuntimePort collapse candidate.

## Problem

Two small pieces of dead weight/name confusion survived the round-4 sweep, both STRONG and trivial —
no design risk, pure hygiene:

1. **Orphaned vendored component.** `src/components/ui/card.tsx` (92 lines, `@ts-nocheck`, vendored
   shadcn/Radix Card family — `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`,
   `CardContent`, `CardFooter`) has zero importers anywhere in the tree. Verified twice:
   `rg -n "components/ui/card|CardHeader|CardContent|CardTitle|CardFooter|CardDescription"` across all
   `.ts`/`.tsx` files returns hits **only inside `card.tsx` itself** (its own function defs and the
   barrel export at line 92). No other file imports from `@/components/ui/card`. The R4 "instrument, not
   dashboard" redesign (`src/app.css:19`, comment: *"structure comes from hairlines, not cards — these
   sit at 7-8% so a divider reads as a seam, not a border"*) replaced card-based structure with hairline
   dividers, which is what orphaned this file. The `--card` / `--card-foreground` CSS custom properties
   in `app.css` (lines 57-58, 101-102, 214) are unrelated Tailwind theme tokens still wired to
   `bg-card`/`text-card-foreground` utility classes elsewhere — leave them alone.

2. **Name collision across two unrelated modules.** `src/background/cloud-upload.ts` defines an inner
   `runUpload` at line 380 (a per-job dispatch closure: resolves+persists the Drive root once, then
   calls `rt.uploadDrive`/`rt.uploadDropbox`) with one call site at line 467 inside `drainUploadJobs`.
   Two layers down, `src/core/cloud/http.ts:63` exports its own `runUpload` — an Effect HTTP template
   method — consumed by `src/core/cloud/drive.ts:210` and `src/core/cloud/dropbox.ts:205`. Same
   identifier, two unrelated interfaces at different depths (background orchestration vs. core Effect
   plumbing) is a locality hazard for anyone grepping/reading the call chain. Verified: no other
   `runUpload` references exist in `src/background/cloud-upload.test.ts` (tests call the outer
   `drainUploadJobs` public interface, never the inner closure by name), so the rename has zero test
   fallout.

## Grilled design decisions

1. **Question:** Should `card.tsx` be kept "just in case" a future card-based surface needs it?
   **Decision:** Delete outright, no deprecation period.
   **Decisive reason:** Zero importers is a mechanically verified fact, not a guess; the file is
   `@ts-nocheck` (already outside the type-check net) and the redesign's stated principle explicitly
   rejects card structure. Keeping dead vendored code around only in case of hypothetical future need is
   the opposite of the hairline-not-card decision already made and documented in `app.css:19`.

2. **Question:** Rename `runUpload` in `cloud-upload.ts` to what?
   **Decision:** `dispatchToProvider`.
   **Decisive reason:** Names the actual job — routing one upload job to whichever provider's uploader
   handles it (Drive root-resolve-then-upload, or Dropbox direct) — without colliding with the
   `core/cloud/http.ts` Effect template method two layers down. This was the one surviving idea from the
   killed CloudRuntimePort collapse candidate (see item 3): even though the broader port-collapse was
   rejected, the naming friction it surfaced (two `runUpload`s at different depths) was real and worth
   fixing on its own.

3. **Question:** Should CloudRuntimePort collapse to a single `upload()` method, folding Drive's
   root-resolution into the port so callers don't special-case providers?
   **Decision:** KILLED — do not re-propose.
   **Decisive reason:** The premise was false. The durable Drive root is `Settings.gdriveFolderId`,
   persisted by the *orchestrator* (`drainUploadJobs` in `cloud-upload.ts`) via the ADR-0005
   single-writer settings queue — not by the cloud runtime port. Two named tests pin this exact
   resolve→persist→upload interleaving: `cloud-upload.test.ts` — *"resolves and persists the Drive root
   folder once when unset, passing it to the upload"* (verified at lines 495-512, asserting
   `runtime.resolveDriveRoot` is called once, `setSettings` is called with the resolved
   `gdriveFolderId`, and `runtime.uploadDrive` receives that `rootFolderId`) and *"reuses a stored Drive
   root without re-resolving"* (lines 514-528). Folding root-resolve into the port would move a
   settings-persist call across the ADR-0017 seam that currently keeps orchestration-level state writes
   out of the port implementation. The per-provider port methods (`uploadDrive` needs a resolved root
   folder id; `uploadDropbox` needs only an access token) reflect genuine provider asymmetry, not
   accidental indirection — collapsing them would hide that asymmetry, not remove it.

## Interface sketch

No public interface changes. Internal rename only:

```ts
// src/background/cloud-upload.ts — before (line 380)
/** Dispatch one job to its provider uploader on the cloud runtime. Drive resolves
 *  (and persists) its app root folder once; Dropbox needs only the access token. */
const runUpload = async (
  job: UploadJob,
  accessToken: string,
  settings: Settings,
): Promise<UploadOutcome> => { ... }

// after
const dispatchToProvider = async (
  job: UploadJob,
  accessToken: string,
  settings: Settings,
): Promise<UploadOutcome> => { ... }
```

Call site (line 467, inside `drainUploadJobs`):

```ts
// before
outcome = await runUpload(job, accessToken, settings)
// after
outcome = await dispatchToProvider(job, accessToken, settings)
```

`src/core/cloud/http.ts:63`'s `runUpload` (the Effect HTTP template method used by `drive.ts:210` and
`dropbox.ts:205`) is untouched — it keeps its name; only the background-layer shadow is renamed.

`src/components/ui/card.tsx` deletion has no interface surface — nothing imports it.

## Out of scope — DO NOT

- Do not re-propose the CloudRuntimePort `upload()` collapse (see decision 3) — it was killed on a
  verified-false premise, not on style grounds.
- Do not touch the `--card` / `--card-foreground` CSS custom properties in `src/app.css` — they back
  live Tailwind utility classes (`bg-card`, `text-card-foreground`) used elsewhere and are unrelated to
  the vendored component file being deleted.
- Do not touch the unrelated "tweet card" domain concept in `src/core/capture` — `rg` hits for "card" in
  that area are a different, in-use domain term, not the vendored UI component.
- Do not rename or touch `src/core/cloud/http.ts`'s `runUpload` — it is the correct, actively-used name
  for that interface; only the background-layer duplicate name is the problem.
- Do not expand this into a broader cloud-upload.ts refactor — this round leaves cloud-upload.ts
  otherwise untouched.

## Plan with verifiable goals

1. Delete `src/components/ui/card.tsx`.
   → verify: `rg -n "components/ui/card|CardHeader|CardContent|CardTitle|CardFooter|CardDescription" src` returns no hits.
2. Rename `runUpload` → `dispatchToProvider` in `src/background/cloud-upload.ts` (declaration at line
   380, call site at line 467). Confirm no references remain in
   `src/background/cloud-upload.test.ts` (there should be none — verified pre-change).
   → verify: `rg -n "runUpload" src/background/cloud-upload.ts` shows zero hits;
     `rg -n "runUpload" src/core/cloud/http.ts src/core/cloud/drive.ts src/core/cloud/dropbox.ts` is
     unchanged (http.ts:63 def, drive.ts:210 + dropbox.ts:205 call sites still present).
3. Run the full gate stack, expect zero behavioral change:
   → verify: `bun run check` (oxfmt --check + oxlint + wxt prepare + tsgo --noEmit + vitest run) exits 0
   → verify: `bun run test:coverage` stays green and 100% over `src/core` + `src/lib` (this change
     touches neither directory's coverage-gated files, so the gate should be a no-op pass)
   → verify: `bun run build` (wxt build) exits 0

## Files

- DELETE `src/components/ui/card.tsx`
- EDIT `src/background/cloud-upload.ts` (rename at declaration line 380 and call site line 467)
- No test file edits expected (`src/background/cloud-upload.test.ts` has zero `runUpload` references
  today — confirm this still holds before finishing; if a concurrent change has since added one,
  rename it too)

## Test plan

No new tests — this is a pure rename + dead-file deletion with no behavioral change. Rely on the
existing `src/background/cloud-upload.test.ts` suite (already covers `drainUploadJobs`, including the
two Drive-root-resolution tests at lines 495-528 cited in decision 3) to catch any regression from the
rename. No sibling test file exists for `card.tsx` (it was never covered — vendored `@ts-nocheck` UI is
excluded from the coverage gate by design; see the repo's existing UI/entrypoints coverage exclusion).

## Coordination

- `cloud-upload.ts` is otherwise untouched this round by any other 2026-07-05 handoff — safe to land
  independently, no ordering constraint.
- `card.tsx` deletion overlaps nothing else in flight (zero importers means zero shared edit surface
  with the other 2026-07-05 handoffs).
- Both items in this batch are independent of each other and can be done in either order, or as one
  commit — recommend one commit since both are trivial and mechanically verified.
