# Save Folder + Naming Strategy — Design

**Date:** 2026-06-28
**Status:** Approved (brainstorming) — pending implementation plan
**Branch (current work):** `feat/download-admission-gate`

## Problem

Cloud sync — especially Dropbox — scatters media into a folder **per author handle**.
The default filename template is `{handle}/{tweetId}_{index}.{ext}`; the `/` makes
`{handle}` a directory. That template drives three destinations inconsistently:

- **Local download** → `Downloads/<handle>/<tweetId>_<index>.<ext>`
- **Dropbox** ([dropbox.ts:169](../../../src/core/cloud/dropbox.ts)) mirrors the template
  path verbatim → `/<handle>/<tweetId>_<index>.<ext>` inside the app folder. This is the
  per-handle clutter the user dislikes.
- **Google Drive** ([drive.ts:172](../../../src/core/cloud/drive.ts)) **ignores** the
  template's folders and **hardcodes** its own structure:
  `X Media Downloader/<handle>/<basename>` via `resolveHandleFolder(target.handle)`.

So there are three gaps:

1. The default nests by handle instead of producing a flat, prefixed filename.
2. There is no configurable "save into this folder" base path.
3. Drive and Dropbox don't even agree on the resulting layout.

## Goals

- A single, configurable **save folder** ("given folder") applied to **every** destination.
- A flat default filename: **`handle-{tweetId}_{index}.{ext}`** (handle as prefix, not a folder).
- A **user-customizable** strategy via named presets, with a custom-template escape hatch.
- **Local and cloud unified**: one naming strategy + one base folder governs all destinations.
- Drive and Dropbox produce **identical** layouts.

## Non-goals

- Re-architecting the upload ledger, OAuth, or sync pipeline.
- Per-destination divergent naming (the explicit point is to unify them).
- Removing the `gdriveFolderId` settings field (kept as a deprecated no-op to avoid a
  schema-migration ripple; a later cleanup may delete it).

## Decisions (from brainstorming)

| Question            | Decision                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| Scope               | **Cloud + local unified** — one strategy drives everything.                                           |
| Default name suffix | **`handle-{tweetId}_{index}.{ext}`** (keep tweetId + index, handle as prefix).                        |
| Customization UI    | **Preset dropdown + Custom escape hatch.**                                                            |
| Base folder default | **`"X Media"`** (applied to every destination; user may rename or clear).                             |
| UI placement        | **Downloads panel → "Save defaults".**                                                                |
| Drive cleanup       | **Included** — drop Drive's hardcoded `X Media Downloader` root so both clouds agree.                 |
| Migration           | Untouched installs auto-flip to the new flat default; customized templates are preserved as `custom`. |

## Architecture

### 1. Settings (data model)

In [`src/core/schema/index.ts`](../../../src/core/schema/index.ts), replace the lone
`filenameTemplate` field with three:

| Field              | Type                                                                  | Default                              | Role                                                                   |
| ------------------ | --------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| `saveFolder`       | `Schema.String`                                                       | `"X Media"`                          | Base folder prefixed onto every destination. Empty = destination root. |
| `namingStrategy`   | `Schema.Literals(['handlePrefix','mediaId','handleFolder','custom'])` | `'handlePrefix'`                     | Selects the filename template.                                         |
| `filenameTemplate` | `Schema.String`                                                       | `'{handle}-{tweetId}_{index}.{ext}'` | **Only** consulted when `namingStrategy === 'custom'`.                 |

All three use `Schema.withDecodingDefaultKey` (the existing idiom).

### 2. Naming resolution — new pure module `src/core/download/naming.ts`

```ts
export const CANONICAL_TEMPLATES = {
  handlePrefix: '{handle}-{tweetId}_{index}.{ext}', // jack-123_0.jpg  (default)
  mediaId: '{tweetId}_{index}.{ext}', // 123_0.jpg
  handleFolder: '{handle}/{tweetId}_{index}.{ext}', // jack/123_0.jpg  (old behavior)
} as const

/** The filename template the strategy resolves to (custom uses the stored template). */
export function strategyTemplate(s: Pick<Settings, 'namingStrategy' | 'filenameTemplate'>): string

/** Prefix a save folder onto a template: `folder/template`, or `template` if folder is blank. */
export function withSaveFolder(folder: string, template: string): string

/** The folder-prefixed template string both local + cloud render. */
export function resolveTemplate(
  s: Pick<Settings, 'saveFolder' | 'namingStrategy' | 'filenameTemplate'>,
): string
```

`resolveTemplate(settings)` returns e.g. `X Media/{handle}-{tweetId}_{index}.{ext}`.
It is pure (no I/O). `renderFilename` already splits on `/` and sanitizes each segment
(`sanitizeSegment`), so the literal folder segment rides through safely — including
illegal-char stripping and `..` defusing. A blank `saveFolder` yields just the template.

### 3. Single wiring seam

[`src/entrypoints/background.ts:756`](../../../src/entrypoints/background.ts) changes:

```diff
- planDownloads({ template: settings.filenameTemplate, item, sidecar: settings.sidecarMetadata })
+ planDownloads({ template: resolveTemplate(settings), item, sidecar: settings.sidecarMetadata })
```

Cloud inherits automatically: the planned `PlannedDownload.filename` flows through
`requestMetaById` into the upload candidate, and `cloudTargetFor(item, filename)` sets
`UploadTarget.path = filename`. So the save folder + flat name appear on every destination
without touching `cloud-upload.ts` naming logic. (`cloudTargetFor` keeps setting `handle`
for provenance, but it no longer drives Drive foldering — see §5.)

The history **backfill** path ([cloud-upload.ts:500](../../../src/background/cloud-upload.ts),
`cloudTargetFor(r.media, r.filename)`) already uses the stored historical `filename`, which
was produced by the same planner, so it remains consistent with no change.

### 4. Migration (back-compat)

Settings persist the **full materialized object** on every write
([settings/index.ts:33](../../../src/core/settings/index.ts),
`decode({ ...current, ...patch })`). So any install that ever changed a setting has the old
`filenameTemplate` pinned — changing the schema default alone won't reach them.

Add a pure `migrate(raw)` that runs **before** schema decode in `decode()`, keyed on
`namingStrategy` being **absent** from the raw stored object (true absence, since the
schema would otherwise default it):

```ts
const LEGACY_TEMPLATE = '{handle}/{tweetId}_{index}.{ext}'
function migrate(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const r = raw as Record<string, unknown>
  if ('namingStrategy' in r) return r // already migrated / explicit
  const t = r.filenameTemplate
  const strategy =
    t === undefined || t === LEGACY_TEMPLATE
      ? 'handlePrefix' // untouched → new flat default
      : 'custom' // user-customized → preserve it
  return { ...r, namingStrategy: strategy }
}
```

`decode()` becomes `Schema.decodeUnknownSync(SettingsSchema)(migrate(raw ?? {}))`, applied
in both `get` and `watch`. Consequences:

- **New install** (`{}`): `namingStrategy` defaults to `handlePrefix`, `saveFolder` to `X Media`.
- **Untouched legacy install**: flipped to `handlePrefix` (the desired new default).
- **Customized legacy install**: marked `custom`, so the stored template is honored verbatim.
- `saveFolder` is absent in all legacy raw → schema fills `X Media` (a deliberate, uniform
  redesign default; existing users' files move under `X Media/` going forward).

The migration is idempotent: once `namingStrategy` is present (it will be after the next
write), `migrate` is a no-op.

### 5. Drive unification

[`src/core/cloud/drive.ts`](../../../src/core/cloud/drive.ts): replace
`resolveHandleFolder(deps, target.handle)` with a path-folder resolver that mirrors Dropbox:

```ts
// Split target.path into directory segments + basename; ensure each nested folder
// from My Drive root, caching per joined folder-path in the SW-life folderCache.
async function resolvePathParent(deps, path): Promise<string | null> // leaf folder id, or null = My Drive root
```

- `dirs = path.split('/').slice(0, -1)`; walk them from My Drive root, `ensureFolder(name, parentId)`
  per segment, caching by the cumulative folder-path string.
- Upload `target.filename` (basename) into the leaf parent (or My Drive root when there are no dirs).

[`src/core/cloud/provider.ts`](../../../src/core/cloud/provider.ts): Drive's `makeDestination`
no longer calls `ensureRootFolder('X Media Downloader', …)` or reads/writes `gdriveFolderId`.
The `gdriveFolderId` schema field and the provider record's `fields.folderId` are retained as
**deprecated no-ops** (commented as such) to avoid a schema migration; the disconnect wipe of
that field stays harmless. `ensureRootFolder` is removed if it has no remaining callers.

Result: with `saveFolder="X Media"` and `handlePrefix`, the rendered path is
`X Media/jack-123_0.jpg`, and **all three destinations** produce:

- Local: `Downloads/X Media/jack-123_0.jpg`
- Dropbox: `/X Media/jack-123_0.jpg` (app folder)
- Drive: `X Media/jack-123_0.jpg` (under My Drive)

A blank `saveFolder` yields the destination root on each (Drive → My Drive root).

### 6. UI

[`src/entrypoints/options/panels/downloads.tsx`](../../../src/entrypoints/options/panels/downloads.tsx),
"Save defaults" group — replace the raw "Filename template" field with:

1. **Save folder** text input (`saveFolder`), placeholder `X Media`, hint "Folder under your
   Downloads / cloud drive. Leave blank for the root."
2. **Naming strategy** select/toggle (`namingStrategy`): Handle prefix · Media ID · Handle folder · Custom.
3. **Custom template** input, shown only when strategy = `custom`, bound to `filenameTemplate`,
   with the existing `{handle} {tweetId} {index} {ext} {type} {date}` token hint.
   - **Seeding rule:** when the user switches the dropdown _to_ Custom from a preset, prefill
     `filenameTemplate` with that preset's canonical template (`CANONICAL_TEMPLATES[prev]`), so
     the box starts from what was just active rather than a stale stored value. This matters for
     migrated installs, whose stored `filenameTemplate` may still hold the legacy folder template
     (the migration sets `namingStrategy` but does not rewrite `filenameTemplate`).
4. A live **preview** line rendering a sample resolved path via `renderFilename(resolveTemplate(settings), sampleItem)`
   (e.g. `X Media/jack-1890123456789_0.jpg`), so the effect is visible before saving.

The sidecar toggle and the rest of the panel are unchanged.

## Data flow

```
settings ─ resolveTemplate ─┬─ planDownloads.template ─ renderFilename ─ PlannedDownload.filename
                            │                                                   │
                            │                                       chrome.downloads (local)
                            │                                                   │
                            └────────────── (same filename) ── cloudTargetFor ─ UploadTarget.path
                                                                                 │
                                            ┌── Dropbox: write `/<path>`  ───────┤
                                            └── Drive:  folders from <path> dirs ┘
```

## Error handling

- `renderFilename` already guarantees a non-empty, `..`-free relative path; `saveFolder`
  flows through the same sanitizer, so a hostile/blank folder cannot break the path contract.
- Drive folder resolution: an `ensureFolder` failure rejects the upload attempt → the existing
  UploadJob failure/backoff path handles it (unchanged). Folder cache is best-effort, SW-life.
- Migration: pure, total, and guarded for non-object raw; a corrupt store still falls back to
  `defaults` via the existing `try/catch` in `decode`.

## Testing (TDD; repo enforces 100% coverage on `src/core` + `src/lib`)

- `naming.test.ts`: each preset → expected template; `custom` → stored template; `withSaveFolder`
  with/without folder; `resolveTemplate` end-to-end; sanitization of an illegal folder name.
- `settings.test.ts`: `migrate` — untouched legacy → `handlePrefix`; customized legacy → `custom`;
  already-migrated → no-op; new install (`{}`) → defaults; non-object raw passthrough.
- `schema.test.ts`: new defaults (`saveFolder='X Media'`, `namingStrategy='handlePrefix'`,
  `filenameTemplate='{handle}-{tweetId}_{index}.{ext}'`).
- `drive.test.ts`: path with dirs → folders created/cached from My Drive root; flat path →
  upload at root; folder-path cache hit avoids a second `ensureFolder`.
- `destination.test.ts` / background wiring: `planDownloads` receives the folder-prefixed
  template; sidecar sibling stays in the same folder.
- Options panel: render presets, Custom reveals the template box, preview reflects settings.

## Files touched

| File                                           | Change                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/core/schema/index.ts`                     | Add `saveFolder`, `namingStrategy`; retune `filenameTemplate` default.            |
| `src/core/settings/index.ts`                   | Add `migrate(raw)` before decode in `get` + `watch`.                              |
| `src/core/download/naming.ts`                  | **New** pure module: canonical templates + `resolveTemplate`.                     |
| `src/entrypoints/background.ts`                | One-line seam: `settings.filenameTemplate` → `resolveTemplate(settings)`.         |
| `src/core/cloud/drive.ts`                      | Resolve folders from `target.path`; drop hardcoded handle folder.                 |
| `src/core/cloud/provider.ts`                   | Drive `makeDestination` drops fixed-root resolution; `gdriveFolderId` deprecated. |
| `src/entrypoints/options/panels/downloads.tsx` | Save-folder input + strategy dropdown + custom box + preview.                     |
| `*.test.ts` (per above)                        | New + updated tests.                                                              |

## Open risks

- **Existing files don't move.** Already-downloaded/synced media stays where it is; only new
  saves use the new layout. Acceptable and expected.
- **`gdriveFolderId` left vestigial.** Deliberate, to avoid a wider migration; flagged for cleanup.
- **Drive root behavior on blank folder.** Files land at My Drive root (parity with Dropbox app
  root). The `"X Media"` default keeps this out of the common path.
