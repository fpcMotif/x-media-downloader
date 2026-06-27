# Tweet Harvest ("Capture") Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Load `superpowers:executing-plans` using the Skill tool to implement this plan task-by-task.

**Goal:** Harvest tweet text/metadata off the existing passive GraphQL tee into a durable local IndexedDB store (opt-in Convex mirror), and export it as flat JSONL + per-thread nested JSON / threaded Markdown for AI ingestion.

**Architecture:** A new text/metadata harvest layer rides the *existing* MAIN-world tee — one shared depth-first traversal (`forEachTweetNode`) feeds both the existing media detector and a new `harvestTweets`. Pure, 100%-gated core modules (`src/core/capture/**`) do extraction, link de-shortening, tree reconstruction, merge, and export; thin ungated shells (background IndexedDB store, Convex mirror outbox, options panel) do I/O. Local and cloud merges use one identical `richer-source-wins` rule keyed on `sourceRank`.

**Tech Stack:** TypeScript, WXT (MV3 extension), Effect `Schema`, Preact (options UI), Convex (backend), Vitest (+ `convex-test`), `bun`.

**Design Support:**
- [Design Spec](../../superpowers/specs/2026-06-27-tweet-harvest-capture-design.md) — the approved, review-hardened source of truth (BDD scenarios below are derived from its §6–§13).

## Context

The extension is a media downloader: the passive tee copies X's GraphQL responses to the content script, but [`detectFromJson`](../../../src/core/adapters/x/index.ts) extracts **only** media. The tweet text, author, counts, links (the real YouTube/arXiv URLs behind `t.co`), and reply trees are discarded. The user wants that metadata harvested into structured JSON to feed an AI for studying technical discussions. The design was hardened by an adversarial review that fixed 16 findings (durable-layer dedup so opened threads upgrade scrolled tweets; one merge rule across local + cloud; a dedicated capture ledger; MV3-safe export delivery).

| Aspect | Current State | Target State |
|--------|--------------|--------------|
| Tee consumption | `detectFromJson` walks JSON → `MediaItem[]` only | One shared `forEachTweetNode` feeds **both** media detection and `harvestTweets` → `TweetRecord[]` |
| What is persisted | Media download history (`storage.local`, cap 500) | + Durable **IndexedDB** harvest of tweet records (keyed by `tweetId`, `unlimitedStorage`) |
| Links | t.co left as-is, not captured | De-shortened to `expanded_url`, joined with X card title/domain |
| Threads | none | Real reply trees from `TweetDetail` + loose `conversation_id` linkage |
| Convex scope | "metadata only — never bytes, captures, or auth" | + opt-in tweet **text** mirror (`tweet_captures`, ADR-0017, own toggle) |
| Export | none | JSONL (bulk) + per-thread nested JSON / threaded Markdown via `data:`/offscreen |
| Settings | media toggles | + `captureEnabled`, `captureAllScrolled`, `captureMirrorEnabled` (all default OFF) |

### Conventions for executors (read before starting)

- **TS Red/Green:** a Red test task creates its module with exported **type + signature stubs** (bodies `throw new Error('not implemented')`) so the test **compiles and fails on an assertion**, never on `ImportError`. The paired Green task fills in the bodies only.
- **Coverage gate:** everything under `src/core/**` and `src/lib/**` is gated at **100%** (`bun run test:coverage`). Ungated shells (`src/background/**`, `src/entrypoints/**`, panels) are verified via `bun run check` + a described manual extension check.
- **No implementation bodies in this plan.** Task files give signatures/contracts only.
- **Reuse, don't re-walk:** harvest consumes the shared `forEachTweetNode`; it must not run a second walk or re-resolve media (ADR-0016 identity).
- **One merge rule (§6.4 of the spec):** `keep incoming ⟺ incoming.sourceRank > existing.sourceRank OR (equal rank AND incoming.capturedAt ≥ existing.capturedAt)` — applied identically in `store.ts` and the Convex `recordCaptures` mutation. **Field-name note:** the local `TweetRecord` timestamp is `capturedAt`; the Convex `tweet_captures` row mirrors it as `at`. Same value, same rule — only the column name differs (use `capturedAt` in `store.ts`, `at` in the mutation).

## Execution Plan

```yaml
tasks:
  - id: "001"
    subject: "Create capture test fixtures"
    slug: "capture-test-fixtures"
    type: "config"
    depends-on: []
  - id: "002"
    subject: "Shared tweet-node traversal test (Red)"
    slug: "shared-traversal-test"
    type: "test"
    depends-on: ["001"]
  - id: "003"
    subject: "Shared tweet-node traversal impl + detectFromJson refactor (Green)"
    slug: "shared-traversal-impl"
    type: "impl"
    depends-on: ["002"]
  - id: "004"
    subject: "Card / link de-shortening test (Red)"
    slug: "card-links-test"
    type: "test"
    depends-on: ["001"]
  - id: "005"
    subject: "Card / link de-shortening impl (Green)"
    slug: "card-links-impl"
    type: "impl"
    depends-on: ["004"]
  - id: "006"
    subject: "TweetRecord extraction + findAuthor test (Red)"
    slug: "record-extraction-test"
    type: "test"
    depends-on: ["001", "003", "005"]
  - id: "007"
    subject: "TweetRecord extraction + findAuthor impl (Green)"
    slug: "record-extraction-impl"
    type: "impl"
    depends-on: ["006"]
  - id: "008"
    subject: "Conversation tree buildTree test (Red)"
    slug: "conversation-tree-test"
    type: "test"
    depends-on: ["007"]
  - id: "009"
    subject: "Conversation tree buildTree impl (Green)"
    slug: "conversation-tree-impl"
    type: "impl"
    depends-on: ["008"]
  - id: "010"
    subject: "Harvest breadth rule + assembly test (Red)"
    slug: "harvest-breadth-test"
    type: "test"
    depends-on: ["001", "003", "005", "007"]
  - id: "011"
    subject: "Harvest breadth rule + assembly impl (Green)"
    slug: "harvest-breadth-impl"
    type: "impl"
    depends-on: ["010"]
  - id: "012"
    subject: "Local store merge + selectors test (Red)"
    slug: "store-merge-test"
    type: "test"
    depends-on: ["007"]
  - id: "013"
    subject: "Local store merge + selectors impl (Green)"
    slug: "store-merge-impl"
    type: "impl"
    depends-on: ["012"]
  - id: "014"
    subject: "Export converters test (Red)"
    slug: "export-converters-test"
    type: "test"
    depends-on: ["007", "009"]
  - id: "015"
    subject: "Export converters impl (Green)"
    slug: "export-converters-impl"
    type: "impl"
    depends-on: ["014"]
  - id: "016"
    subject: "Capture settings + message schema test (Red)"
    slug: "schema-wiring-test"
    type: "test"
    depends-on: ["007"]
  - id: "017"
    subject: "Capture settings + message schema impl (Green)"
    slug: "schema-wiring-impl"
    type: "impl"
    depends-on: ["016"]
  - id: "018"
    subject: "Capture pipeline e2e (harvest→store→export)"
    slug: "capture-pipeline-e2e"
    type: "test"
    depends-on: ["011", "013", "015"]
  - id: "019"
    subject: "IndexedDB harvest-store shell"
    slug: "capture-db-shell"
    type: "impl"
    depends-on: ["013", "017"]
  - id: "020"
    subject: "Background capture handlers + dispatcher + export delivery"
    slug: "background-capture-handlers"
    type: "impl"
    depends-on: ["015", "017", "019"]
  - id: "021"
    subject: "Content-script harvest flush (batch + debounce)"
    slug: "content-script-flush"
    type: "impl"
    depends-on: ["011", "017"]
  - id: "022"
    subject: "Knowledge Capture options panel"
    slug: "options-capture-panel"
    type: "impl"
    depends-on: ["017"]
  - id: "023"
    subject: "Manifest unlimitedStorage permission"
    slug: "manifest-unlimited-storage"
    type: "config"
    depends-on: []
  - id: "024"
    subject: "Capture sync event + ledger test (Red)"
    slug: "capture-sync-ledger-test"
    type: "test"
    depends-on: ["007"]
  - id: "025"
    subject: "Capture sync event + ledger impl (Green)"
    slug: "capture-sync-ledger-impl"
    type: "impl"
    depends-on: ["024"]
  - id: "026"
    subject: "Convex recordCaptures mutation test (Red)"
    slug: "convex-record-captures-test"
    type: "test"
    depends-on: []
  - id: "027"
    subject: "Convex tweet_captures table + recordCaptures impl (Green)"
    slug: "convex-record-captures-impl"
    type: "impl"
    depends-on: ["026"]
  - id: "028"
    subject: "Background capture mirror shell (mirrorCaptures)"
    slug: "capture-mirror-shell"
    type: "impl"
    depends-on: ["020", "025", "027"]
  - id: "029"
    subject: "captureMirrorEnabled setting + panel toggle"
    slug: "capture-mirror-setting"
    type: "impl"
    depends-on: ["017", "022"]
  - id: "030"
    subject: "ADR-0017 + Convex posture comment updates"
    slug: "adr-0017-posture"
    type: "docs"
    depends-on: []
```

**Task File References (for detailed BDD scenarios):**
- [Task 001: Create capture test fixtures](./task-001-capture-test-fixtures.md)
- [Task 002: Shared traversal test (Red)](./task-002-shared-traversal-test.md)
- [Task 003: Shared traversal impl + detectFromJson refactor (Green)](./task-003-shared-traversal-impl.md)
- [Task 004: Card / link de-shortening test (Red)](./task-004-card-links-test.md)
- [Task 005: Card / link de-shortening impl (Green)](./task-005-card-links-impl.md)
- [Task 006: TweetRecord extraction + findAuthor test (Red)](./task-006-record-extraction-test.md)
- [Task 007: TweetRecord extraction + findAuthor impl (Green)](./task-007-record-extraction-impl.md)
- [Task 008: Conversation tree test (Red)](./task-008-conversation-tree-test.md)
- [Task 009: Conversation tree impl (Green)](./task-009-conversation-tree-impl.md)
- [Task 010: Harvest breadth test (Red)](./task-010-harvest-breadth-test.md)
- [Task 011: Harvest breadth impl (Green)](./task-011-harvest-breadth-impl.md)
- [Task 012: Local store merge test (Red)](./task-012-store-merge-test.md)
- [Task 013: Local store merge impl (Green)](./task-013-store-merge-impl.md)
- [Task 014: Export converters test (Red)](./task-014-export-converters-test.md)
- [Task 015: Export converters impl (Green)](./task-015-export-converters-impl.md)
- [Task 016: Settings + message schema test (Red)](./task-016-schema-wiring-test.md)
- [Task 017: Settings + message schema impl (Green)](./task-017-schema-wiring-impl.md)
- [Task 018: Capture pipeline e2e](./task-018-capture-pipeline-e2e.md)
- [Task 019: IndexedDB harvest-store shell](./task-019-capture-db-shell.md)
- [Task 020: Background capture handlers + delivery](./task-020-background-capture-handlers.md)
- [Task 021: Content-script harvest flush](./task-021-content-script-flush.md)
- [Task 022: Knowledge Capture options panel](./task-022-options-capture-panel.md)
- [Task 023: Manifest unlimitedStorage permission](./task-023-manifest-unlimited-storage.md)
- [Task 024: Capture sync event + ledger test (Red)](./task-024-capture-sync-ledger-test.md)
- [Task 025: Capture sync event + ledger impl (Green)](./task-025-capture-sync-ledger-impl.md)
- [Task 026: Convex recordCaptures test (Red)](./task-026-convex-record-captures-test.md)
- [Task 027: Convex tweet_captures + recordCaptures impl (Green)](./task-027-convex-record-captures-impl.md)
- [Task 028: Background capture mirror shell](./task-028-capture-mirror-shell.md)
- [Task 029: captureMirrorEnabled setting + panel toggle](./task-029-capture-mirror-setting.md)
- [Task 030: ADR-0017 + posture comments](./task-030-adr-0017-posture.md)

## BDD Coverage

Every behavior in spec §6–§13 maps to a Red/Green task pair (pure core) or an impl/config/docs task (ungated glue). Coverage matrix:

| Spec section / behavior | Task(s) |
|---|---|
| §6.0 shared `forEachTweetNode` + `detectFromJson` refactor | 002 / 003 |
| §6.3 `expandText` (index-safe) + card (flat + unified) | 004 / 005 |
| §6.1 `TweetRecord` extraction + `findAuthor` (outer author) | 006 / 007 |
| §6.2 `buildTree` (multi-level, orphan, root-missing, self-thread, cycle) | 008 / 009 |
| §7 harvest breadth rule + assembly | 010 / 011 |
| §6.4 + §8 merge (rich-then-thin stays rich) + selectors | 012 / 013 |
| §10 export converters (JSONL / tree / Markdown + quote inlining) | 014 / 015 |
| §12 settings defaults + message decode | 016 / 017 |
| §5 end-to-end pure pipeline | 018 |
| §8 IndexedDB shell | 019 |
| §5/§10/§12 background handlers + dispatcher + delivery | 020 |
| §7 content-script flush | 021 |
| §12 options panel | 022 |
| §8 `unlimitedStorage` | 023 |
| §9 capture ledger + event | 024 / 025 |
| §6.4/§9 Convex `recordCaptures` parity merge | 026 / 027 |
| §9 mirror shell | 028 |
| §11/§12 mirror toggle | 029 |
| §11 ADR-0017 + posture comments | 030 |

## Dependency Chain

```
001 fixtures ─┬─→ 002 walk-test → 003 walk-impl ─┐
              ├─→ 004 card-test → 005 card-impl ──┤
              ├──────────────────────────────────┼─→ 006 record-test → 007 record-impl ─┬─→ 008 tree-test → 009 tree-impl ─┐
              └──────────────────────────────────┘                                       │                                  │
                                                                                         ├─→ 010 harvest-test → 011 harvest-impl ─┐
                                                                                         ├─→ 012 store-test  → 013 store-impl  ─┤
                                                                                         ├─→ 014 export-test → 015 export-impl ─┤ (014 also ← 009)
                                                                                         ├─→ 016 schema-test → 017 schema-impl ─┤
                                                                                         └─→ 024 ledger-test → 025 ledger-impl   │
                                                                                                                                 │
   011 + 013 + 015 ──────────────────────────────────────────────────────────────────────────→ 018 pipeline-e2e               │
   013 + 017 ───────────────────────────────────→ 019 capture-db-shell ──┐                                                      │
   015 + 017 + 019 ─────────────────────────────→ 020 bg-handlers ───────┼──────────────────────────────────────────────→ 028 mirror-shell
   011 + 017 ───────────────────────────────────→ 021 content-flush      │                                              ↑
   017 ─────────────────────────────────────────→ 022 options-panel ─────┼─→ 029 mirror-setting (← 017,022)             │
   (none) ──────────────────────────────────────→ 023 wxt-permission     │                                              │
   (none) ──────────────────────────────────────→ 026 convex-test → 027 convex-impl ────────────────────────────────────┘
   (none) ──────────────────────────────────────→ 030 ADR-0017 + posture
```

**Analysis**:
- No circular dependencies.
- Foundation (fixtures + shared traversal + card) → record → {tree, harvest, store, export, schema, ledger} fan out in parallel → integration (pipeline e2e, background glue) → mirror.
- Phase 1 = tasks 001–023 (fully usable, local-only, no cloud dependency). Phase 2 = 024–030.
- Parallelizable clusters once 007 lands: {008/009 tree}, {010/011 harvest}, {012/013 store}, {014/015 export}, {016/017 schema}, {024/025 ledger}. Backend {026/027} and docs {030} and config {023} are independent throughout.

---

## Execution Handoff

**Plan complete and saved to `docs/plans/2026-06-27-tweet-harvest-capture-plan/`. Execution options:**

**1. Orchestrated Execution (Recommended)** — Load `superpowers:executing-plans` using the Skill tool.

**2. Direct Agent Team** — Load `superpowers:agent-team-driven-development` using the Skill tool.

**3. BDD-Focused Execution** — Load `superpowers:behavior-driven-development` using the Skill tool for specific scenarios.
