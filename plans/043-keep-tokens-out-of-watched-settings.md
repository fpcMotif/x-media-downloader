# Plan 043: Keep tokens and secrets out of the settings key that every page watches

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/packages/settings src/packages/overlay src/entrypoints/overlay.content/index.tsx src/entrypoints/background.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S (Part A), M (Part B)
- **Risk**: LOW (Part A), MED (Part B)
- **Depends on**: Part A: none. Part B: `plans/018-cache-settings-and-skip-noop-writes.md` must be DONE first. Both edit `src/packages/settings/index.ts`, and plan 018's done criteria assume it is the only change to that file.
- **Category**: perf, security
- **Planned at**: commit `cee429a`, 2026-11-17. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/119

## Why this matters

All settings live in one storage key, `local:settings`. That key also holds
the cloud access and refresh tokens, the Google client secret, the Convex sync
secret, and the aria2 secret. Every X, Instagram and Threads tab runs a
content script that reads and watches that key. Two costs follow:

1. Each background token refresh rewrites the key. Every open tab then decodes
   the full settings schema and runs `applySettings`, which resets the badge,
   cancels an active Quick Grab, re-renders, and schedules a saved-status
   sweep that messages the service worker.
2. Every content script receives the tokens and secrets in its memory. No
   content-script code needs them.

Part A makes `applySettings` return early when no field the overlay uses has
changed. Part B stores the tokens and secrets under a second key that content
scripts never read or watch. The gain is an estimate from reading the code. It
was not measured.

## Current state

Files and roles:

- `src/packages/settings/index.ts` — the settings entry point: `getSettings`,
  `setSettings`, `watchSettings`, `SettingsService`. 89 lines.
- `src/packages/settings/tests/settings.test.ts` — its tests. They seed raw
  storage with `fakeBrowser.storage.local.set({ settings: { … } })`.
- `src/packages/schema/index.ts` — the `Settings` schema (fields near lines
  40-200).
- `src/packages/overlay/` — pure overlay logic. Root files are entry points.
  Tests live in `src/packages/overlay/tests/`.
- `src/entrypoints/overlay.content/index.tsx` — the content script.
- `src/background/cloud-upload.ts` — refreshes tokens and writes them through
  `setSettings`. Read only.
- `src/entrypoints/background.ts` — the service worker. Locate edits by quoted
  code, not by line number.

The storage item and the three helpers (`src/packages/settings/index.ts:7-9`, `:18-26`, `:74-89`):

```ts
const defaults: Settings = Schema.decodeUnknownSync(SettingsSchema)({})

const item = storage.defineItem<JsonValue>('local:settings', { fallback: {} })
```

```ts
function decode(raw: JsonValue): Settings {
  try {
    /* v8 ignore next -- defineItem's fallback ({}) means raw is never null/undefined here; `?? {}` is unreachable */
    const decoded = Schema.decodeUnknownSync(SettingsSchema)(raw ?? {})
    return { ...decoded, filenameTemplate: normalizeFilenameTemplate(decoded.filenameTemplate) }
  } catch {
    return defaults
  }
}
```

```ts
export const getSettings = (): Promise<Settings> =>
  provide(Effect.flatMap(SettingsService, (s) => s.get)).catch((err: unknown) => {
    console.warn('[XMD] getSettings failed, falling back to defaults:', err)
    return defaults
  })
export const setSettings = (patch: Partial<Settings>): Promise<Settings> =>
  provide(Effect.flatMap(SettingsService, (s) => s.set(patch)))

/** Live subscription for long-lived contexts (content scripts), so popup changes
 *  reach already-open tabs without a reload. Returns an unwatch function. */
export const watchSettings = (cb: (s: Settings) => void): (() => void) =>
  item.watch((raw) => cb(decode(raw)))
```

The service reads and writes the item at three places
(`src/packages/settings/index.ts:38`, `:44`, `:69`):

```ts
  get: Effect.promise(() => item.getValue()).pipe(Effect.map(decode)),
```

```ts
      const current = decode(yield* Effect.promise(() => item.getValue()))
```

```ts
      yield* Effect.promise(() => item.setValue(next))
```

If plan 018 has landed, the file also exports `readSettings`, and
`getSettings` calls it. Keep that.

The token write (`src/background/cloud-upload.ts:434-441`):

```ts
  const persistAccessToken = (
    p: CloudProviderId,
    accessToken: string,
    expiresAt: number,
  ): Promise<Settings> => {
    const f = PROVIDERS[p].fields
    return writeCloudSettings({ [f.accessToken]: accessToken, [f.expiry]: expiresAt })
  }
```

`writeCloudSettings` ends in `setSettings` (`cloud-upload.ts:362`, `:432`).

The fields this plan calls secret fields, all declared in
`src/packages/schema/index.ts` (lines 90, 99, 161-164, 169-171). Every one is a
string defaulting to `''`, except the two expiry fields, which are numbers
defaulting to `0`:

- `aria2Secret`
- `convexSyncSecret`
- `gdriveClientSecret`
- `gdriveAccessToken`, `gdriveRefreshToken`, `gdriveTokenExpiry`
- `dropboxAccessToken`, `dropboxRefreshToken`, `dropboxTokenExpiry`

The expiry fields are not secret. They move because they change together with
the access token.

The content script's consumer (`src/entrypoints/overlay.content/index.tsx`,
near lines 65, 1522-1568):

```ts
import { getSettings, watchSettings } from '@/packages/settings'
```

```ts
    const applySettings = (s: Settings): void => {
      qgEnabled = s.quickGrabEnabled
      qgModifier = s.quickGrabModifier
      badgeEnabled = s.downloadBadgeEnabled
      dockEnabled = s.downloadDockEnabled
      dockGlass = s.dockGlassEnabled
      // Sensitive-content auto-reveal + the "Not interested" stub-collapse are both
      // X-only (X-specific data-testid selectors, no Instagram/Threads equivalent):
      // gate their observer setup so no MutationObserver is even constructed there.
      if (adapter.platform === 'x') setAutoReveal(s.autoRevealSensitiveEnabled)
      // Hide the cleared-post feedback stub only when the For-You "Not interested"
      // clear is actually active (master + the per-scope toggle on).
      if (adapter.platform === 'x') setStubCollapse(s.clearOnSave && s.autoNotInterestedOnSave)
      // Cross-device "Saved" status: gate the sweep on the toggle; a flip re-paints.
      // X-only (SavedIndex/Convex queries + TWEET_ARTICLE_SEL are X-DOM-specific):
      // don't even arm the debounce timer on Instagram/Threads.
      savedStatusOn = s.showSavedStatus
      savedStatusLifecycle.sync()
      releaseMutationDiagnosticsOn = s.releaseMutationDiagnosticsEnabled
      // Tweet-text harvest (§7): default OFF. `captureAllScrolled` widens breadth
      // from media/thread tweets to every scrolled text-only tweet.
      captureEnabled = s.captureEnabled
      captureAllScrolled = s.captureAllScrolled
      // Surface clear-on-save state in the PAGE console (the one you can see here),
      // so "why didn't it un-like?" is answerable without the SW console: if
      // clearOnSave is false, nothing ever clears — turn it on in the popup.
      if (import.meta.env.DEV)
        clearLog(
          `settings · clearOnSave=${s.clearOnSave} unbookmark=${s.autoUnbookmarkOnSave} unlike=${s.autoUnlikeOnSave} strategy=${s.downloadStrategy}`,
        )
      resetBadge()
      releaseAll()
      rerender()
    }
    void getSettings()
      .then(applySettings)
      .catch(() => {})
    // On invalidation `wxt/storage` is already torn down and its unwatch throws —
    // swallow it so the reload path stays quiet (the real hint is logged below).
    const unwatchSettings = watchSettings(applySettings)
```

`applySettings` reads exactly these 15 fields: `quickGrabEnabled`,
`quickGrabModifier`, `downloadBadgeEnabled`, `downloadDockEnabled`,
`dockGlassEnabled`, `autoRevealSensitiveEnabled`, `clearOnSave`,
`autoNotInterestedOnSave`, `showSavedStatus`,
`releaseMutationDiagnosticsEnabled`, `captureEnabled`, `captureAllScrolled`,
`autoUnbookmarkOnSave`, `autoUnlikeOnSave`, `downloadStrategy`. Each one is a
boolean or a string literal.

At planning time a search for the secret field names in
`src/entrypoints/overlay.content`, `src/entrypoints/inject.content.ts`,
`src/core` and `src/packages/overlay` returned no match. `local:settings` is
named only in `src/packages/settings/index.ts`.

Design constraints:

- `docs/adr/0005-state-persistence-split.md`: "**Settings → `storage.local`**
  — durable across browser restarts (single-writer: the background SW;
  popup/content observe via `storage.onChanged`)." The new key stays in
  `storage.local`. Do not move anything to `storage.session`.
- `docs/adr/0013-client-side-cloud-byte-upload.md`: "That user-supplied secret
  resides in extension storage". Extension storage still holds it.
- `src/packages/README.md`: code outside a package imports only the package's
  root files. A new root file is a new entry point.

Repo conventions that apply (from `AGENTS.md`):

- No `oxlint-disable`, `eslint-disable`, `@ts-ignore`, or `@ts-expect-error`.
- Every `as` needs an uppercase `SAFETY:` comment. Prefer code that needs no `as`.
- `unknown` is banned in parameters, returns, and type aliases. Third-party
  JSON is typed `JsonValue` / `JsonObject` from `@/packages/schema`.
- `satisfies` over a widening annotation.
- Named constants, not magic numbers.
- Tests are vitest. Assertions live inside `it()`.

Comment rule: do not add, edit, or delete code comments, except a comment that
describes code this plan removes. A pre-edit hook (`doc-lock`) blocks other
comment changes. Carry intent in names, types, and tests. Do not edit any
Markdown file except this plan's status row in `plans/README.md`. The target
code below deliberately has no comments.

## Commands you will need

| Purpose       | Command                                 | Expected on success |
|---------------|-----------------------------------------|---------------------|
| Typecheck     | `bun run typecheck`                     | exit 0, no errors   |
| Lint          | `bun run lint`                          | exit 0              |
| Format check  | `bun run fmt:check`                     | exit 0              |
| Boundaries    | `bun run lint:boundaries`               | exit 0              |
| Focused tests | `bun run test <path/to/file.test.ts>`   | all pass            |
| Full gate     | `bun run check`                         | exit 0              |
| Build         | `bun run build`                         | exit 0              |

The package manager is bun. Never use npm or npx. If `bun run fmt:check` fails
only on files you edited, run `bunx oxfmt --write <those files>` and re-check.

## Scope

**In scope** (the only files you should modify or create):

- `src/packages/overlay/settings-view.ts` (create, Part A)
- `src/packages/overlay/tests/settings-view.test.ts` (create, Part A)
- `src/entrypoints/overlay.content/index.tsx` (Parts A and B)
- `src/packages/settings/index.ts` (Part B)
- `src/packages/settings/page.ts` (create, Part B)
- `src/packages/settings/lib/secret-fields.ts` (create, Part B)
- `src/packages/settings/tests/secrets.test.ts` (create, Part B)
- `src/packages/settings/tests/settings.test.ts` (Part B, only if an existing
  watch test needs the timing change described in Step B3)
- `src/entrypoints/background.ts` (Part B, one call)
- `plans/README.md` (only this plan's status row)

**Out of scope** (do NOT touch, even though they look related):

- `src/packages/schema/index.ts`. The `Settings` schema and type do not change.
  Trusted contexts keep reading tokens from the same `Settings` object.
- `src/background/cloud-upload.ts`, `src/background/remote-upload.ts`, the
  popup and the options pages. They keep calling `getSettings`, `setSettings`
  and `watchSettings` unchanged.
- `chrome.storage.local.setAccessLevel`. It would also block the content
  script from reading `local:settings`. See "Maintenance notes".
- `storage.session`. ADR-0005 keeps settings in `storage.local`.

## Git workflow

- Branch: `advisor/043-keep-tokens-out-of-watched-settings`
- Conventional commits. Example from this repo:
  `perf(cloud): copy each byte once when chunking upload streams`.
  Use `perf(overlay): …` for Part A and `refactor(settings): …` for Part B. One
  commit per part.
- Do NOT push or open a PR.
- The working tree has uncommitted user changes, and some are in this plan's
  in-scope files. Never revert or stash them.
- Before editing, run the drift check command from the top of this plan. Note
  every in-scope file it lists: those files already hold uncommitted changes.
- Do not commit a file that had uncommitted changes before you started. Make
  the plan's edits in it, leave them unstaged, and name that file in your final
  message.
- Commit only in-scope files that were clean before you started. Stage each by
  explicit path.

## Steps

### Part A — skip `applySettings` when nothing the overlay uses changed

#### Step A1: Add the comparison, test first

Create `src/packages/overlay/tests/settings-view.test.ts` with the tests in
"Test plan" items 1–3. Import from `'../settings-view'`, the same way
`src/packages/overlay/tests/badge.test.ts` imports from `'../badge'`.

**Verify**: `bun run test src/packages/overlay/tests/settings-view.test.ts` →
FAILS (module not found).

Then create `src/packages/overlay/settings-view.ts`:

```ts
import type { Settings } from '@/packages/schema'

export const OVERLAY_SETTINGS_FIELDS = [
  'quickGrabEnabled',
  'quickGrabModifier',
  'downloadBadgeEnabled',
  'downloadDockEnabled',
  'dockGlassEnabled',
  'autoRevealSensitiveEnabled',
  'clearOnSave',
  'autoNotInterestedOnSave',
  'showSavedStatus',
  'releaseMutationDiagnosticsEnabled',
  'captureEnabled',
  'captureAllScrolled',
  'autoUnbookmarkOnSave',
  'autoUnlikeOnSave',
  'downloadStrategy',
] as const satisfies ReadonlyArray<keyof Settings>

export type OverlaySettings = Pick<Settings, (typeof OVERLAY_SETTINGS_FIELDS)[number]>

export const sameOverlaySettings = (a: OverlaySettings, b: OverlaySettings): boolean =>
  OVERLAY_SETTINGS_FIELDS.every((field) => a[field] === b[field])
```

**Verify**: `bun run test src/packages/overlay/tests/settings-view.test.ts` →
all pass.

#### Step A2: Return early in the content script

In `src/entrypoints/overlay.content/index.tsx`:

1. Import `sameOverlaySettings` and the type `OverlaySettings` from the overlay
   package's new root file. Match the path style the file already uses for
   other `packages/overlay` imports
   (`rg -n "packages/overlay" src/entrypoints/overlay.content/index.tsx`).
2. Directly above `const applySettings`, add:

```ts
    let appliedSettings: OverlaySettings | null = null
```

3. Change the signature to `const applySettings = (s: OverlaySettings): void => {`
   and add these two statements as the first lines of its body, above
   `qgEnabled = s.quickGrabEnabled`:

```ts
      if (appliedSettings !== null && sameOverlaySettings(appliedSettings, s)) return
      appliedSettings = s
```

   Do not change any other line or comment in the function. If the `Settings`
   type import in this file becomes unused, remove only that name from its
   import list.

If typecheck reports that `applySettings` reads a field that is not in
`OverlaySettings`, that is a STOP condition. Do not widen the list on your own.

**Verify**: `bun run typecheck` → exit 0. `bun run lint` → exit 0.
`rg -n "sameOverlaySettings" src/entrypoints/overlay.content/index.tsx` → 2
matches.

You may stop here, run Step B6, and mark the plan
`DONE (Part A; Part B not started)`. Part B needs plan 018 to be DONE.

### Part B — store tokens and secrets under a second key

Check first: `rg -n "readSettings" src/packages/settings/index.ts` must return
a match. If it does not, plan 018 has not landed. Stop after Part A.

#### Step B1: Name the secret fields

Create `src/packages/settings/lib/secret-fields.ts`:

```ts
import type { JsonObject, JsonValue, Settings } from '@/packages/schema'

export const SECRET_SETTINGS_FIELDS = [
  'aria2Secret',
  'convexSyncSecret',
  'gdriveClientSecret',
  'gdriveAccessToken',
  'gdriveRefreshToken',
  'gdriveTokenExpiry',
  'dropboxAccessToken',
  'dropboxRefreshToken',
  'dropboxTokenExpiry',
] as const satisfies ReadonlyArray<keyof Settings>

export type SecretSettingsField = (typeof SECRET_SETTINGS_FIELDS)[number]
export type PageSettings = Omit<Settings, SecretSettingsField>

const SECRET_FIELD_SET: ReadonlySet<string> = new Set(SECRET_SETTINGS_FIELDS)

const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const splitSettings = (
  merged: JsonValue,
): { readonly publicPart: JsonObject; readonly secretPart: JsonObject } => {
  const publicPart: Record<string, JsonValue> = {}
  const secretPart: Record<string, JsonValue> = {}
  if (isJsonObject(merged)) {
    for (const [key, value] of Object.entries(merged)) {
      if (SECRET_FIELD_SET.has(key)) secretPart[key] = value
      else publicPart[key] = value
    }
  }
  return { publicPart, secretPart }
}

export const mergeSettings = (publicRaw: JsonValue, secretsRaw: JsonValue): JsonObject => ({
  ...(isJsonObject(publicRaw) ? publicRaw : {}),
  ...(isJsonObject(secretsRaw) ? secretsRaw : {}),
})

export const hasSecretField = (publicRaw: JsonValue): boolean =>
  isJsonObject(publicRaw) && Object.keys(publicRaw).some((key) => SECRET_FIELD_SET.has(key))
```

If `@/packages/schema` already exports an `isJsonObject` with this meaning
(`rg -n "export const isJsonObject|export function isJsonObject" src/packages/schema`),
import it and drop the local copy. If `JsonObject` is not assignable from
`Record<string, JsonValue>`, that is a STOP condition. Do not add an `as`.

**Verify**: `bun run typecheck` → exit 0.

#### Step B2: Write the failing tests

Create `src/packages/settings/tests/secrets.test.ts` with the tests in "Test
plan" items 4–9. Model it on `src/packages/settings/tests/settings.test.ts`:
same imports, same `beforeEach` with `fakeBrowser.reset()`, raw storage seeded
and read through `fakeBrowser.storage.local`. WXT stores `local:settings`
under the raw key `settings`, and `local:settingsSecrets` under the raw key
`settingsSecrets`. Import `getPageSettings` and `watchPageSettings` from
`'../page'`, and `migrateSettingsSecrets` from `'../index'`.

**Verify**: `bun run test src/packages/settings/tests/secrets.test.ts` → FAILS
(modules or exports missing).

#### Step B3: Split reads and writes in the settings entry point

In `src/packages/settings/index.ts`:

1. Import `hasSecretField`, `mergeSettings` and `splitSettings` from
   `'./lib/secret-fields'`.
2. Below the `item` definition, add:

```ts
const secretsItem = storage.defineItem<JsonValue>('local:settingsSecrets', { fallback: {} })

const readMergedRaw = async (): Promise<JsonValue> => {
  const [publicRaw, secretsRaw] = await Promise.all([item.getValue(), secretsItem.getValue()])
  return mergeSettings(publicRaw, secretsRaw)
}

const writeSplit = async (next: Settings): Promise<void> => {
  const { publicPart, secretPart } = splitSettings(next)
  await secretsItem.setValue(secretPart)
  await item.setValue(publicPart)
}
```

   The secrets key is written first on purpose. If the worker dies between
   the two writes, the merged read still returns the new secret values,
   because the secrets key overrides the public key.

   `splitSettings(next)` takes a `JsonValue`. If `Settings` is not assignable
   to `JsonValue` at that call, look at how the existing
   `item.setValue(next)` call compiles and follow the same route. If that
   needs an `as`, it is a STOP condition.

3. Replace each of the three `item.getValue()` reads listed in "Current state"
   (and the one inside `readSettings` if plan 018 added it there) with
   `readMergedRaw()`. Replace `item.setValue(next)` with `writeSplit(next)`.
4. Replace `watchSettings` with a version that watches both keys. Keep the
   existing comment block above it unchanged:

```ts
export const watchSettings = (cb: (s: Settings) => void): (() => void) => {
  const notify = (): void => {
    void readMergedRaw().then((raw) => cb(decode(raw)))
  }
  const unwatchPublic = item.watch(notify)
  const unwatchSecrets = secretsItem.watch(notify)
  return () => {
    unwatchPublic()
    unwatchSecrets()
  }
}
```

5. Add the one-time migration export at the end of the file:

```ts
export const migrateSettingsSecrets = async (): Promise<boolean> => {
  const publicRaw = await item.getValue()
  if (!hasSecretField(publicRaw)) return false
  await writeSplit(decode(mergeSettings(publicRaw, await secretsItem.getValue())))
  return true
}
```

The watch callback now arrives one asynchronous step after the storage write.
If an existing test in `settings.test.ts` under `describe('watchSettings', …)`
fails only for that reason, wrap its assertion in
`await vi.waitFor(() => { … })` and name the test in your final message. Do not
change what the test asserts.

**Verify**: `bun run test src/packages/settings/tests/settings.test.ts` → all
pass. `bun run typecheck` → exit 0.

#### Step B4: Add the page entry point

Create `src/packages/settings/page.ts`:

```ts
import { Schema } from 'effect'
import { storage } from 'wxt/utils/storage'
import { Settings as SettingsSchema, type JsonValue } from '@/packages/schema'
import { normalizeFilenameTemplate } from './lib/template-migration'
import { splitSettings, type PageSettings } from './lib/secret-fields'

export type { PageSettings } from './lib/secret-fields'

const pageItem = storage.defineItem<JsonValue>('local:settings', { fallback: {} })

const decodePage = (raw: JsonValue): PageSettings => {
  const { publicPart } = splitSettings(raw)
  const decoded = Schema.decodeUnknownOption(SettingsSchema)(publicPart)
  const settings =
    decoded._tag === 'Some' ? decoded.value : Schema.decodeUnknownSync(SettingsSchema)({})
  return { ...settings, filenameTemplate: normalizeFilenameTemplate(settings.filenameTemplate) }
}

export const getPageSettings = (): Promise<PageSettings> =>
  pageItem.getValue().then(decodePage, () => decodePage({}))

export const watchPageSettings = (cb: (s: PageSettings) => void): (() => void) =>
  pageItem.watch((raw) => cb(decodePage(raw)))
```

`splitSettings` drops any secret field that an old install still holds in
`local:settings`, so the page never decodes one. The returned object still
carries the secret keys with their empty defaults at runtime. The
`PageSettings` type hides them, so content-script code cannot read them
without a type error.

Check that `Schema.decodeUnknownOption` exists in the installed Effect version
(`rg -n "decodeUnknownOption" src | head`). It is used in
`src/background/clear-session.ts`. If your shape differs from that use, copy
that use.

**Verify**: `bun run test src/packages/settings/tests/secrets.test.ts` → all
pass. `bun run lint:boundaries` → exit 0.

#### Step B5: Switch the content script and run the migration

1. In `src/entrypoints/overlay.content/index.tsx`, change the import
   `import { getSettings, watchSettings } from '@/packages/settings'` to
   `import { getPageSettings, watchPageSettings } from '@/packages/settings/page'`.
   Replace the one `getSettings()` call and the one `watchSettings(…)` call
   near `applySettings` with `getPageSettings()` and `watchPageSettings(…)`.
   `rg -n "getSettings|watchSettings" src/entrypoints/overlay.content` must
   then show only comment lines.
2. In `src/entrypoints/background.ts`, find the boot block that holds this
   line:

```ts
    if (s.cloudUploadEnabled) cloudUpload.resumeOnBoot()
```

   That block is an async function that reads settings at worker start. As the
   first statement of that async function, add:

```ts
    await migrateSettingsSecrets()
```

   Add `migrateSettingsSecrets` to the file's existing import from
   `@/packages/settings`. If the first statement of that block is not inside an
   `async` function, that is a STOP condition.

**Verify**: `bun run typecheck` → exit 0. `bun run lint` → exit 0.
`rg -n "from '@/packages/settings'" src/entrypoints/overlay.content src/entrypoints/inject.content.ts src/core src/packages/overlay`
→ no match.

#### Step B6: Run the gate

**Verify**: `bun run check` → exit 0. `bun run build` → exit 0.

## Test plan

`src/packages/overlay/tests/settings-view.test.ts` (Part A, model on
`src/packages/overlay/tests/badge.test.ts`):

1. **Equal overlay fields compare equal.** Two objects with the same 15 field
   values give `true`.
2. **Each overlay field is compared.** For every name in
   `OVERLAY_SETTINGS_FIELDS`, changing only that field gives `false`. Loop over
   the list inside one `it`.
3. **Other fields are ignored.** Build two full `Settings` objects with
   `Schema.decodeUnknownSync(Settings)({})` from `@/packages/schema`, set a
   different `gdriveAccessToken` on one, and expect `true`.

`src/packages/settings/tests/secrets.test.ts` (Part B, model on
`src/packages/settings/tests/settings.test.ts`):

4. **A token write lands only in the secrets key.**
   `await setSettings({ gdriveAccessToken: 'test-token' })`. The raw `settings`
   value has none of the nine secret field names as keys. The raw
   `settingsSecrets` value has `gdriveAccessToken: 'test-token'`.
   `getSettings()` returns that token.
5. **An old install still reads its tokens.** Seed raw `settings` with
   `{ dropboxRefreshToken: 'legacy-token' }` and no `settingsSecrets`.
   `getSettings()` returns `dropboxRefreshToken: 'legacy-token'`.
6. **Migration moves the legacy fields.** Continue from test 5. Call
   `migrateSettingsSecrets()` and expect `true`. Raw `settings` no longer has
   the key. Raw `settingsSecrets` has it. `getSettings()` is unchanged. A
   second call returns `false`.
7. **The secrets key wins over a stale public value.** Seed raw `settings`
   with `{ gdriveAccessToken: 'old' }` and raw `settingsSecrets` with
   `{ gdriveAccessToken: 'new' }`. `getSettings()` returns `'new'`.
8. **The page reader never returns a stored secret.** Seed raw `settings` with
   `{ convexSyncSecret: 'legacy-secret', showSavedStatus: false }`.
   `getPageSettings()` returns `showSavedStatus: false`, and
   `JSON.stringify(result)` does not contain `legacy-secret`.
9. **A token refresh does not notify the page watcher.** Register
   `watchPageSettings(spy)` and `watchSettings(trustedSpy)`. Call
   `setSettings({ gdriveAccessToken: 'a', gdriveTokenExpiry: 1 })`. After
   `await vi.waitFor(() => expect(trustedSpy).toHaveBeenCalled())`, the page
   spy has 0 calls. Then `setSettings({ showSavedStatus: false })` calls the
   page spy once.

Use only made-up literal strings such as `'test-token'` in tests. Never paste
a real credential.

Verification:
`bun run test src/packages/overlay/tests/settings-view.test.ts src/packages/settings/tests/secrets.test.ts src/packages/settings/tests/settings.test.ts`
→ all pass, 9 new tests.

Optional check in a real browser (the operator runs this): with Google Drive
connected, open an x.com tab, open its DevTools console, switch the console
context to the extension's content script, and run
`chrome.storage.local.get('settings')`. After Part B and one worker start, the
result has no token or secret field. Uploads still succeed.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] `bun run lint:boundaries` exits 0
- [ ] Part A: the 3 new tests exist and pass, and `rg -n "sameOverlaySettings" src/entrypoints/overlay.content/index.tsx` returns 2 matches
- [ ] Part B (if done): the 6 new tests exist and pass
- [ ] Part B (if done): `rg -n "from '@/packages/settings'" src/entrypoints/overlay.content src/entrypoints/inject.content.ts src/core src/packages/overlay` returns no match
- [ ] Part B (if done): `rg -n "migrateSettingsSecrets" src/entrypoints/background.ts` returns 2 matches (import and call)
- [ ] `git diff --stat cee429a -- src/packages/schema/index.ts` shows no change made by this plan
- [ ] `git diff -U0 -- src | rg "^\+.*(oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error)"` returns no matches
- [ ] `git status --short` shows no modified file outside the in-scope list that was not already modified before you started
- [ ] `plans/README.md` status row updated (say whether Part B was done)

## STOP conditions

Stop and report back (do not improvise) if:

- `applySettings` or `src/packages/settings/index.ts` does not match the
  excerpts, apart from the `readSettings` addition that plan 018 makes.
- `applySettings` reads a field that is not in `OVERLAY_SETTINGS_FIELDS`.
- `rg -n "aria2Secret|convexSyncSecret|ClientSecret|AccessToken|RefreshToken|TokenExpiry" src/entrypoints/overlay.content src/entrypoints/inject.content.ts src/core src/packages/overlay -g '!*.test.*'`
  returns any match. A content script reads a field this plan moves.
- `rg -n "local:settings|storage\.local\.(get|set)\(\s*['\"{]\s*settings" src tools scripts -g '!*.test.*'`
  shows a reader or writer of the raw key outside `src/packages/settings/`.
- A test outside `src/packages/settings/tests/` asserts that the raw
  `settings` storage value contains a token or secret field.
- Part B needs an `as` cast or a lint suppression to compile.
- Plan 018 is not DONE and you are about to start Part B.
- The `doc-lock` hook rejects an edit. Report which edit and its message.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- New secret or token fields must be added to `SECRET_SETTINGS_FIELDS`.
  Otherwise they land in the watched key again. Test 4 loops over the list, so
  it covers a new name once the name is in the list.
- The trusted `watchSettings` still fires on a token refresh. The service
  worker's own watcher in `background.ts` then runs
  `reconcileCloudOnlyHistory`. Narrowing that watcher is a separate change.
  Plan 018's cache stays correct because it rebuilds from the merged read.
- The two keys are written one after the other, secrets first. A reader that
  runs between the two writes sees the new secrets with the old public
  settings. No current code depends on reading both in one instant.
- Deferred: `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`
  would stop content scripts from reading any `storage.local` key, including
  the secrets key by its name. It would also block `local:settings`, which the
  content script needs. Doing it requires the worker to push page settings by
  message. That changes ADR-0005 and needs an owner decision.
- Plan 045 can later replace the Schema decode in `page.ts` with plain
  predicates to shrink the content-script bundle.
- Reviewer: check the migration order (secrets key first), and that no test
  or log prints a real token.
