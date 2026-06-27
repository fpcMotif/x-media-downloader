# Task 030: ADR-0017 + Convex posture comment updates

**depends-on**:   <!-- none — independent -->

## Description
Record the deliberate extension of the Convex mirror's documented scope: today it is "metadata only — never bytes, captures, or auth", and the capture mirror now also carries tweet **text** (plus link metadata). Author a new ADR-0017 that states the change, its bound (tweet text + link metadata only; never media bytes, media captures, or auth; gated behind its own opt-in `captureMirrorEnabled`), and re-scope the three existing posture comments so they describe **media** mirroring and point readers at ADR-0017. This is documentation/comment work only — no behavior changes.

## Execution Context
**Task Number**: 030 of 30
**Phase**: Mirror
**Prerequisites**: None required to author this file; it documents the posture change introduced by the Phase 2 Convex mirror tasks (capture stream, `recordCaptures` mutation, `tweet_captures` table, `captureMirrorEnabled` toggle). It can be written independently and should land alongside the mirror.

## BDD Scenario
```gherkin
Scenario: the posture change is documented
  Given the existing 'metadata only — never bytes, captures, or auth' posture in three places + ADR-0009
  When the capture mirror ships
  Then ADR-0017 records the deliberate extension to tweet TEXT (bound: text + link metadata only; never media bytes/captures/auth; own opt-in)
  And the three posture comments are re-scoped to media and point at ADR-0017
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§11)

## Files to Modify/Create
- Create: `docs/adr/0017-capture-mirror-extends-convex-scope.md`
- Modify: `src/core/sync/events.ts` (header comment)
- Modify: `src/core/schema/index.ts` (`cloudSyncEnabled` comment)
- Modify: `docs/adr/0009-convex-cloud-control-plane.md` (note the extension)

## Contracts (signatures/types ONLY — no bodies)
```ts
// Documentation only — no code logic.
```

## Steps
1. **Locate the three posture comments.** Open `src/core/sync/events.ts` (header comment), `src/core/schema/index.ts` (the `cloudSyncEnabled` comment), and `docs/adr/0009-convex-cloud-control-plane.md` to find each occurrence of the "metadata only — never bytes, captures, or auth" wording (or its close paraphrase).
   - Verification: each of the three locations is identified and quoted before editing.
2. **Author `docs/adr/0017-capture-mirror-extends-convex-scope.md`.** Follow the existing ADR format used by ADR-0009 (status, context, decision, consequences). Record: (a) the deliberate extension of Convex scope to tweet **text**; (b) the explicit bound — tweet text + link metadata only, still **never** media bytes, media captures, or auth; (c) that it rides its **own** opt-in toggle `captureMirrorEnabled` (default OFF), independent of media `cloudSyncEnabled`; (d) that local capture never implies mirroring and the whole feature is default OFF.
   - Verification: the file exists, links back to ADR-0009 and the §11 design spec, and states the bound and the separate opt-in.
3. **Re-scope the `src/core/sync/events.ts` header comment** so the "metadata only" posture statement describes **media** mirroring specifically, and append a pointer to ADR-0017 for the tweet-text extension.
   - Verification: the comment now reads as media-scoped and references ADR-0017.
4. **Re-scope the `cloudSyncEnabled` comment in `src/core/schema/index.ts`** identically — media-scoped posture, pointing at ADR-0017.
   - Verification: the comment now reads as media-scoped and references ADR-0017.
5. **Update `docs/adr/0009-convex-cloud-control-plane.md`** with a short note (e.g. a "Superseded/Extended by" line or consequences addendum) recording that ADR-0017 extends the scope to tweet text.
   - Verification: ADR-0009 names ADR-0017 and notes the extension.

## Verification Commands
```bash
bun run check   # docs + comment edits must not break build/lint
```

## Success Criteria
- `docs/adr/0017-capture-mirror-extends-convex-scope.md` exists and records the deliberate extension to tweet text, the bound (text + link metadata only; never media bytes/captures/auth), and the separate `captureMirrorEnabled` opt-in (default OFF).
- All three posture comments (`src/core/sync/events.ts` header, `src/core/schema/index.ts` `cloudSyncEnabled`, ADR-0009) are re-scoped to **media** and point at ADR-0017.
- `bun run check` passes (comment-only source edits do not break build, lint, or types; no logic changed).
