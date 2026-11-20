# Plan 046: Six effects that only derive state are gone

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan in
> `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 2089ed0 -- src/entrypoints/options/panels/sync.tsx src/components/confirm-strip.tsx src/entrypoints/popup/App.tsx`
> The plan was written against a working tree with uncommitted changes on top
> of `2089ed0`. If any in-scope file changed, compare the "Current state"
> excerpts with the live code before you edit. A mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `2089ed0`, 2026-11-20
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/120

## Why this matters

The popup and options pages hold 26 `useEffect` calls. Six of them talk to no
external system. Each one watches a prop or a state value and then sets other
state. That costs one extra render per change and shows one frame of stale
data. React Doctor reports three of the six
(`no-adjust-state-on-prop-change` at `sync.tsx:185`, `no-mirror-prop-effect`
at `sync.tsx:551` and `sync.tsx:555`). After this plan the same behavior comes
from a `key`, a derived value, an interval callback, or an event handler.

The other 20 effects stay. They subscribe to timers, DOM events, or extension
messages. Do not touch them.

## Current state

This is a Preact extension built with WXT. Hooks come from `preact/hooks`.

### A. `src/entrypoints/options/panels/sync.tsx`: two prop mirrors

`CloudProviderRow` copies two props into state with effects (lines 550–557):

```tsx
  const [draft, setDraft] = useState(clientId)
  useEffect(() => {
    setDraft(clientId)
  }, [clientId])
  const [secretDraft, setSecretDraft] = useState(clientSecret)
  useEffect(() => {
    setSecretDraft(clientSecret)
  }, [clientSecret])
```

`SyncPanel` renders the row twice (lines 446–472):

```tsx
            <CloudProviderRow
              provider="gdrive"
              clientId={settings.gdriveClientId}
              clientSecret={settings.gdriveClientSecret}
```

```tsx
            <CloudProviderRow
              provider="dropbox"
              clientId={settings.dropboxClientId}
              clientSecret=""
```

### B. `src/entrypoints/options/panels/sync.tsx`: one reset on change

`SyncPanel` holds the last connection-test result (line 117) and clears it
when the URL or secret changes (lines 163–186):

```tsx
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
```

```tsx
  const convexUrl = settings.convexUrl
  const convexSecret = settings.convexSyncSecret
```

```tsx
  useEffect(() => {
    if (!cloudOn) {
      setSyncStatus(null)
      return
    }
    void browser.runtime
      .sendMessage({ _tag: 'SyncStatusRequest' })
      .then((s) => setSyncStatus(Option.getOrNull(decodeSyncStatus(s))))
      .catch(() => {})
  }, [cloudOn])
  useEffect(() => {
    setSyncStatus(null)
  }, [convexUrl, convexSecret])
```

`testConvexConnection` (lines 211–221) also writes it:

```tsx
      const res = await browser.runtime.sendMessage({ _tag: 'SyncTestRequest' })
      setSyncStatus(Option.getOrNull(decodeSyncStatus(res)))
    } catch {
      setSyncStatus({ ok: false, detail: 'The extension background did not respond.', pending: 0 })
```

The only reader is the JSX at lines 358–367:

```tsx
            {syncStatus && (
              <p
                {...stylex.props(
                  styles.statusText,
                  syncStatus.ok ? styles.colorSuccess : styles.colorDestructive,
                )}
              >
                {syncStatus.detail}
              </p>
            )}
```

`decodeSyncStatus` returns an Effect `Option`. `Option` is already imported in
this file.

### C. `src/components/confirm-strip.tsx`: one effect chained on a tick

`useConfirmStrip` ticks `now` in one effect and reacts to `now` in a second
(lines 343–352):

```tsx
  useEffect(() => {
    if (armedAt === null) return undefined
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [armedAt])

  useEffect(() => {
    if (armedAt === null) return
    if (now >= disarmDeadline(armedAt)) disarm()
  }, [now, armedAt, disarm])
```

`disarm` is a `useCallback` with a stable identity.

### D. `src/entrypoints/popup/App.tsx`: two timers armed by effects

`App` holds two status lines (lines 1238–1239) and clears each after 6 seconds
with an effect (lines 1380–1390):

```tsx
  const [downloadMsg, setDownloadMsg] = useState<string | null>(null)
  const [releaseMsg, setReleaseMsg] = useState<string | null>(null)
```

```tsx
  useEffect(() => {
    if (downloadMsg === null || isPersistentStatus(downloadMsg)) return undefined
    const timer = setTimeout(() => setDownloadMsg(null), 6000)
    return () => clearTimeout(timer)
  }, [downloadMsg])

  useEffect(() => {
    if (releaseMsg === null || isPersistentStatus(releaseMsg)) return undefined
    const timer = setTimeout(() => setReleaseMsg(null), 6000)
    return () => clearTimeout(timer)
  }, [releaseMsg])
```

The only writers are `trackDownloadMsg` (lines 1250–1253) and two
`setMsg: setReleaseMsg` entries (near lines 1294 and 1303):

```tsx
  const trackDownloadMsg = (m: string | null): void => {
    downloadOkRef.current = isDownloadOk(m)
    setDownloadMsg(m)
  }
```

`App` already uses the owned timer a few lines below:

```tsx
  const savedTimer = useOwnedTimer()
```

`useOwnedTimer` lives in `src/components/owned-timer.ts`. `arm(fn, delayMs)`
cancels the pending callback before it schedules the new one. `cancel()`
cancels it. The hook cancels on unmount.

### Conventions that apply

- Tests in these folders are source-text pins. They read the `.tsx` file as a
  string and assert on substrings. See `src/components/confirm-strip.test.ts`.
  When you delete or reword pinned text, update the pin in the same step.
- Never add `oxlint-disable`, `eslint-disable`, `@ts-ignore`, or
  `@ts-expect-error`. Fix the code.
- Every `as` cast needs a `// SAFETY:` comment. Prefer no cast.
- Named constants, not magic numbers.
- Do not add or reword comments beyond the lines you replace. A comment leaves
  only with the code it describes.
- Package manager is `bun`. Never `npm` or `npx`.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Typecheck | `bun run typecheck` | exit 0 |
| Lint | `bun run lint` | exit 0, no new warning |
| One test file | `bun run test src/components/confirm-strip.test.ts` | all pass |
| All tests | `bun run test` | all pass |
| React Doctor | `bunx react-doctor@latest . --no-supply-chain --verbose` | see Done criteria |

## Scope

**In scope** (the only files you may modify):

- `src/entrypoints/options/panels/sync.tsx`
- `src/components/confirm-strip.tsx`
- `src/components/confirm-strip.test.ts`
- `src/entrypoints/popup/App.tsx`
- `src/entrypoints/popup/App.test.ts`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- Every other `useEffect` in these files. They own a timer, a DOM listener, or
  an extension message.
- The metrics poll effect in `App.tsx` (near line 1343). `App.test.ts` pins
  its text.
- `src/components/owned-timer.ts`.
- The `string | null` type of the two status lines. Plan 048 owns it.

## Git workflow

- Branch: `advisor/046-remove-state-deriving-effects`
- One commit per step. Message style matches the repo, for example:
  `fix(overlay): cap only off-page detections so long X pages keep every item (#91)`.
  Use `refactor(options): …` and `refactor(popup): …`.
- Do NOT push or open a PR unless the operator told you to.

## Steps

### Step 1: Reset the provider drafts with a `key`

In `sync.tsx`:

1. Delete both effects shown in section A. Keep the two `useState` lines.
2. Add a `key` to each `CloudProviderRow` call so a changed persisted value
   remounts the row and reseeds its drafts:

   ```tsx
   <CloudProviderRow
     key={`gdrive:${settings.gdriveClientId}:${settings.gdriveClientSecret}`}
     provider="gdrive"
   ```

   ```tsx
   <CloudProviderRow
     key={`dropbox:${settings.dropboxClientId}`}
     provider="dropbox"
   ```

3. The comment above `const [draft, setDraft]` ends with "and resync when it
   changes (e.g. after a successful connect)". Leave it. It is still true.

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Tie the connection-test result to the config it tested

In `sync.tsx`:

1. Above `SyncPanel`, add a tagged type:

   ```tsx
   type SyncProbe =
     | { readonly _tag: 'NotProbed' }
     | { readonly _tag: 'Probed'; readonly configKey: string; readonly status: SyncStatus }

   const NOT_PROBED: SyncProbe = { _tag: 'NotProbed' }
   ```

   If lint rejects the annotation on `NOT_PROBED`, write
   `const NOT_PROBED = { _tag: 'NotProbed' } satisfies SyncProbe`.

2. Replace the state line with
   `const [syncProbe, setSyncProbe] = useState<SyncProbe>(NOT_PROBED)`.
3. After the `convexSecret` line add
   `` const configKey = `${convexUrl}\n${convexSecret}` ``.
4. Add one helper inside `SyncPanel`, after `configKey`:

   ```tsx
   const recordProbe = (status: Option.Option<SyncStatus>): void =>
     setSyncProbe(
       Option.match(status, {
         onNone: () => NOT_PROBED,
         onSome: (value) => ({ _tag: 'Probed', configKey, status: value }),
       }),
     )
   ```

5. In the `[cloudOn]` effect, replace `setSyncStatus(null)` with
   `setSyncProbe(NOT_PROBED)` and the `.then` body with
   `.then((s) => recordProbe(decodeSyncStatus(s)))`.
6. Delete the whole `useEffect(() => { setSyncStatus(null) }, [convexUrl, convexSecret])`.
7. In `testConvexConnection`, use `recordProbe(decodeSyncStatus(res))` in the
   `try` branch and
   `recordProbe(Option.some({ ok: false, detail: 'The extension background did not respond.', pending: 0 }))`
   in the `catch` branch.
8. Replace the JSX reader:

   ```tsx
   {syncProbe._tag === 'Probed' && syncProbe.configKey === configKey && (
     <p
       {...stylex.props(
         styles.statusText,
         syncProbe.status.ok ? styles.colorSuccess : styles.colorDestructive,
       )}
     >
       {syncProbe.status.detail}
     </p>
   )}
   ```

A result for an old URL or secret no longer shows, because its `configKey`
differs. That replaces the deleted effect.

**Verify**: `bun run typecheck` → exit 0. Then
`export CODEDB_NO_HOOKS=1; rg -n 'setSyncStatus|syncStatus\b' src/entrypoints/options/panels/sync.tsx`
→ no match.

### Step 3: Disarm the confirm strip from the interval

In `confirm-strip.tsx`, replace both effects shown in section C with one:

```tsx
  useEffect(() => {
    if (armedAt === null) return undefined
    const id = setInterval(() => {
      const tickedAt = Date.now()
      if (tickedAt >= disarmDeadline(armedAt)) disarm()
      else setNow(tickedAt)
    }, TICK_MS)
    return () => clearInterval(id)
  }, [armedAt, disarm])
```

Keep the comment block that sits above the first effect.

Then open `src/components/confirm-strip.test.ts`. Search it for
`now >= disarmDeadline` and for `setNow(Date.now())`. Update each pin that
matches to the new text. Add this test inside the existing `describe`:

```ts
  it('auto-disarms from the tick itself, with no effect chained on now', () => {
    expect(source).toContain('if (tickedAt >= disarmDeadline(armedAt)) disarm()')
    expect(source).not.toContain('}, [now, armedAt, disarm])')
  })
```

Run the new test once before you edit `confirm-strip.tsx` and confirm that it
fails.

**Verify**: `bun run test src/components/confirm-strip.test.ts` → all pass.

### Step 4: Arm the popup status timers where the message is set

In `App.tsx`:

1. Near the other module-level constants, add
   `const STATUS_CLEAR_MS = 6000`.
2. Delete both effects shown in section D. The comment block above them
   explains the 6-second auto-clear and the persistent-status exception. Move
   it above the new helper from item 4.
3. After the `releaseMsg` state line add:

   ```tsx
   const downloadMsgTimer = useOwnedTimer()
   const releaseMsgTimer = useOwnedTimer()
   ```

4. Above `function App`, at module level, add:

   ```tsx
   const armStatusClear = (timer: OwnedTimer, m: string | null, clear: () => void): void => {
     if (m === null || isPersistentStatus(m)) timer.cancel()
     else timer.arm(clear, STATUS_CLEAR_MS)
   }
   ```

   Import the `OwnedTimer` type from `@/components/owned-timer` next to the
   existing `useOwnedTimer` import.

5. Change `trackDownloadMsg` to:

   ```tsx
   const trackDownloadMsg = (m: string | null): void => {
     downloadOkRef.current = isDownloadOk(m)
     setDownloadMsg(m)
     armStatusClear(downloadMsgTimer, m, () => setDownloadMsg(null))
   }
   ```

6. Below it add:

   ```tsx
   const trackReleaseMsg = (m: string | null): void => {
     setReleaseMsg(m)
     armStatusClear(releaseMsgTimer, m, () => setReleaseMsg(null))
   }
   ```

7. Replace both `setMsg: setReleaseMsg` entries with `setMsg: trackReleaseMsg`.

Then add to `src/entrypoints/popup/App.test.ts`, as a new `describe` at the
end of the file:

```ts
describe('cluster status lines clear from an owned timer, not an effect', () => {
  it('arms the clear where the message is set', () => {
    expect(popupSource).toContain('const STATUS_CLEAR_MS = 6000')
    expect(popupSource).toContain('else timer.arm(clear, STATUS_CLEAR_MS)')
    expect(popupSource).toContain('setMsg: trackReleaseMsg')
    expect(popupSource).not.toContain('setMsg: setReleaseMsg')
  })

  it('keeps persistent statuses on screen', () => {
    expect(popupSource).toContain('if (m === null || isPersistentStatus(m)) timer.cancel()')
  })

  it('has no effect keyed on a status message', () => {
    expect(popupSource).not.toContain('}, [downloadMsg])')
    expect(popupSource).not.toContain('}, [releaseMsg])')
  })
})
```

Run the new tests once before you edit `App.tsx` and confirm that they fail.
A test that cannot fail proves nothing.

**Verify**: `bun run test src/entrypoints/popup/App.test.ts` → all pass.

### Step 5: Run the gate

**Verify**: `bun run typecheck && bun run lint && bun run test` → exit 0.

## Test plan

- `confirm-strip.test.ts`: one new pin (Step 3).
- `App.test.ts`: one new `describe` with three tests (Step 4).
- `sync.tsx` has no test file. Steps 1 and 2 are checked by typecheck, by the
  `rg` commands, and by React Doctor.
- Pattern to follow: the existing source-text pins in
  `src/components/confirm-strip.test.ts`.

## Done criteria

ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bun run test` exits 0
- [ ] `export CODEDB_NO_HOOKS=1; rg -c 'useEffect\(' src/entrypoints/options/panels/sync.tsx` prints `3`
- [ ] `export CODEDB_NO_HOOKS=1; rg -c 'useEffect\(' src/components/confirm-strip.tsx` prints `4`
- [ ] `export CODEDB_NO_HOOKS=1; rg -c 'useEffect\(' src/entrypoints/popup/App.tsx` prints `5`
- [ ] `bunx react-doctor@latest . --no-supply-chain --verbose` no longer lists
      `no-adjust-state-on-prop-change` or `no-mirror-prop-effect`
- [ ] `git status --short` shows no modified file outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:

- An excerpt in "Current state" does not match the live file.
- `setDownloadMsg` or `setReleaseMsg` has a caller that this plan does not
  list. Run
  `export CODEDB_NO_HOOKS=1; rg -n 'setDownloadMsg|setReleaseMsg' src/entrypoints/popup/App.tsx`
  before Step 4. Expect only the state lines, `trackDownloadMsg`, the two
  `setMsg:` entries, and the two effects.
- Lint reports a rule you can clear only by renaming, moving, or disabling.
- A verification fails twice after a reasonable fix.

## Maintenance notes

- A new writer of `downloadMsg` or `releaseMsg` must go through
  `trackDownloadMsg` or `trackReleaseMsg`, or the line never clears.
- The `key` on `CloudProviderRow` remounts the row when the persisted client id
  changes. Unsaved text in that row is dropped at that moment. The deleted
  effects did the same.
- A reviewer should check Step 2 in a browser: run "Test connection", edit the
  Convex URL, and confirm that the old result line disappears at once.
- Plan 017 also edits the cloud status poll in `sync.tsx`. Run the two plans
  one after the other and rerun the second plan's drift check.
