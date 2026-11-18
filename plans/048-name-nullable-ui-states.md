# Plan 048: Permission and connect state have named values, not `null`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan in
> `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 2089ed0 -- src/entrypoints/options/panels/sync.tsx src/entrypoints/options/panels/saving.tsx`
> The plan was written against a working tree with uncommitted changes on top
> of `2089ed0`. Plans 046 and 047 edit the same two files first. Locate every
> edit by the quoted text, not by line number. Missing quoted text is a STOP
> condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: plans/046-remove-state-deriving-effects.md, plans/047-load-mount-data-through-one-hook.md (same files)
- **Category**: tech-debt
- **Planned at**: commit `2089ed0`, 2026-11-20
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/122

## Why this matters

Two options panels hold a host-permission answer as `boolean | null`. The
three values mean "not checked or no valid URL", "denied", and "granted", but
the type does not say so, and the JSX compares with `=== false` and
`=== true`. The same check-on-change effect is written twice. A third state,
`connecting`, uses `null` for "no provider is connecting". After this plan one
hook owns the permission effect, its result is a three-member string union,
and `connecting` names its idle value.

## Current state

Preact extension built with WXT. `browser` is the WebExtension API object.
`Option` is Effect's `Option`, already imported in both files.

`src/entrypoints/options/panels/sync.tsx`, inside `SyncPanel`:

```tsx
  const [convexGranted, setConvexGranted] = useState<boolean | null>(null)
```
```tsx
  const [connecting, setConnecting] = useState<CloudProviderId | null>(null)
```
```tsx
  useEffect(() => {
    if (!cloudOn || convexUrl === '') return
    const pattern = convexOriginPattern(convexUrl)
    if (Option.isNone(pattern)) {
      setConvexGranted(null)
      return
    }
    void browser.permissions.contains({ origins: [pattern.value] }).then(setConvexGranted)
  }, [cloudOn, convexUrl])
```
```tsx
  const requestConvexAccess = async (): Promise<void> => {
    const pattern = convexOriginPattern(settings.convexUrl)
    if (Option.isNone(pattern)) return
    setConvexGranted(await browser.permissions.request({ origins: [pattern.value] }))
  }
```
```tsx
              {convexGranted === false && (
```
```tsx
              {convexGranted === true && (
                <span {...stylex.props(styles.grantedText)}>access granted</span>
              )}
```

`connecting` is written by `setConnecting(provider)` and `setConnecting(null)`
and read as `connecting === 'gdrive'` and `connecting === 'dropbox'`.

`src/entrypoints/options/panels/saving.tsx`, inside `SavingPanel`:

```tsx
  const [aria2Granted, setAria2Granted] = useState<boolean | null>(null)
```
```tsx
  const strategy = settings.downloadStrategy
  const rpcUrl = settings.aria2RpcUrl
  useEffect(() => {
    if (strategy !== 'aria2') return
    const pattern = aria2OriginPattern(rpcUrl)
    if (Option.isNone(pattern)) {
      setAria2Granted(null)
      return
    }
    void browser.permissions.contains({ origins: [pattern.value] }).then(setAria2Granted)
  }, [strategy, rpcUrl])

  const requestAria2Access = async (): Promise<void> => {
    const pattern = aria2OriginPattern(settings.aria2RpcUrl)
    if (Option.isNone(pattern)) return
    setAria2Granted(await browser.permissions.request({ origins: [pattern.value] }))
  }
```
```tsx
            {aria2Granted === false && (
```
```tsx
            {aria2Granted === true && (
```

`convexOriginPattern` and `aria2OriginPattern` both take a URL string and
return `Option.Option<string>`.

### Conventions that apply

- Behavior tests that need no DOM are plain vitest. See
  `src/components/owned-timer.test.ts`. Other tests are source-text pins.
- Never add `oxlint-disable`, `eslint-disable`, `@ts-ignore`, or
  `@ts-expect-error`. No `unknown` in parameters or returns.
- Hooks list every dependency. No "latest value" refs.
- Keep existing comments. A comment leaves only with the code it describes.
- Package manager is `bun`.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Typecheck | `bun run typecheck` | exit 0 |
| Lint | `bun run lint` | exit 0, no new warning |
| One test file | `bun run test src/components/use-origin-grant.test.ts` | all pass |
| All tests | `bun run test` | all pass |

## Scope

**In scope**:

- `src/components/use-origin-grant.ts` (create)
- `src/components/use-origin-grant.test.ts` (create)
- `src/entrypoints/options/panels/sync.tsx`
- `src/entrypoints/options/panels/saving.tsx`
- `src/entrypoints/options/panels/saving.test.ts` (only to update a pin)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- `convexOriginPattern`, `aria2OriginPattern`, and their packages.
- Every other nullable state: status-message slots (`string | null`),
  `armedAt`, `cloudStatus`, `relaySetup`, `metrics`, `tabAdapter`, `scope`,
  and `useLingeringValue`. They cross component and helper boundaries. Plan
  050 counts them and a later plan converts them.

## Git workflow

- Branch: `advisor/048-name-nullable-ui-states`
- One commit per step. Message style: `refactor(options): …`.
- Do NOT push or open a PR unless the operator told you to.

## Steps

### Step 1: Write the failing test

Create `src/components/use-origin-grant.test.ts`:

```ts
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { grantOf, queryGrant } from './use-origin-grant'

describe('grantOf', () => {
  it('names both answers of the permissions API', () => {
    expect(grantOf(true)).toBe('granted')
    expect(grantOf(false)).toBe('denied')
  })
})

describe('queryGrant', () => {
  it('is unknown without a valid origin pattern and asks nothing', async () => {
    let asked = 0
    const grant = await queryGrant(Option.none(), () => {
      asked += 1
      return Promise.resolve(true)
    })
    expect(grant).toBe('unknown')
    expect(asked).toBe(0)
  })

  it('asks for exactly the given origin', async () => {
    const seen: string[] = []
    const grant = await queryGrant(Option.some('https://a.example/*'), (origin) => {
      seen.push(origin)
      return Promise.resolve(false)
    })
    expect(grant).toBe('denied')
    expect(seen).toEqual(['https://a.example/*'])
  })
})
```

**Verify**: `bun run test src/components/use-origin-grant.test.ts` → FAILS,
because the module does not exist. That is the expected result.

### Step 2: Write the hook

Create `src/components/use-origin-grant.ts`:

```ts
import { Option } from 'effect'
import { useEffect, useState } from 'preact/hooks'

export type OriginGrant = 'unknown' | 'granted' | 'denied'

export interface OriginGrantHandle {
  readonly grant: OriginGrant
  readonly request: () => Promise<void>
}

export const grantOf = (allowed: boolean): OriginGrant => (allowed ? 'granted' : 'denied')

export const queryGrant = async (
  pattern: Option.Option<string>,
  ask: (origin: string) => Promise<boolean>,
): Promise<OriginGrant> => (Option.isNone(pattern) ? 'unknown' : grantOf(await ask(pattern.value)))

const containsOrigin = (origin: string): Promise<boolean> =>
  browser.permissions.contains({ origins: [origin] })

const requestOrigin = (origin: string): Promise<boolean> =>
  browser.permissions.request({ origins: [origin] })

/** Tracks whether the extension holds host access to one origin pattern.
 *  @param origin The match pattern, or `''` when there is none to check. A
 *  string keeps the effect dependency stable; an `Option` would be a new
 *  object on every render. */
export function useOriginGrant(origin: string): OriginGrantHandle {
  const [grant, setGrant] = useState<OriginGrant>('unknown')
  useEffect(() => {
    let active = true
    void queryGrant(origin === '' ? Option.none() : Option.some(origin), containsOrigin).then(
      (next) => {
        if (active) setGrant(next)
        return next
      },
    )
    return () => {
      active = false
    }
  }, [origin])
  return {
    grant,
    request: async () => {
      if (origin !== '') setGrant(grantOf(await requestOrigin(origin)))
    },
  }
}
```

Check how other files in `src/components` reach `browser` (an import from
`wxt/browser` or the WXT auto-import) and do the same here.

`browser.permissions.request` must run inside a user gesture. `request` is
called straight from a click handler in both panels, as today.

**Verify**: `bun run test src/components/use-origin-grant.test.ts` → 3 pass.
`bun run typecheck && bun run lint` → exit 0.

### Step 3: Use it in the Sync panel

In `sync.tsx`:

1. Delete the `convexGranted` state line, the permission effect, and
   `requestConvexAccess`, all quoted in "Current state".
2. After the `convexUrl` line add:

   ```tsx
   const convexOrigin = cloudOn
     ? Option.getOrElse(convexOriginPattern(convexUrl), () => '')
     : ''
   const convexAccess = useOriginGrant(convexOrigin)
   ```

3. JSX: `convexGranted === false` → `convexAccess.grant === 'denied'`;
   `convexGranted === true` → `convexAccess.grant === 'granted'`;
   `onClick={() => void requestConvexAccess()}` →
   `onClick={() => void convexAccess.request()}`.
4. `connecting`: change the state to
   `useState<CloudProviderId | 'none'>('none')` and `setConnecting(null)` to
   `setConnecting('none')`. The two `connecting === '…'` reads stay as they
   are.

Behavior note: before, turning Cloud Sync off left the last answer in state
while the section was hidden. Now the grant is `'unknown'` while it is off and
is checked again when it turns on. The visible result is the same.

**Verify**: `bun run typecheck` → exit 0.
`export CODEDB_NO_HOOKS=1; rg -n 'convexGranted|boolean \| null|CloudProviderId \| null' src/entrypoints/options/panels/sync.tsx`
→ no match.

### Step 4: Use it in the Saving panel

In `saving.tsx`:

1. Delete the `aria2Granted` state line, the permission effect, and
   `requestAria2Access`.
2. After the `rpcUrl` line add:

   ```tsx
   const aria2Origin =
     strategy === 'aria2' ? Option.getOrElse(aria2OriginPattern(rpcUrl), () => '') : ''
   const aria2Access = useOriginGrant(aria2Origin)
   ```

3. JSX: `aria2Granted === false` → `aria2Access.grant === 'denied'`;
   `aria2Granted === true` → `aria2Access.grant === 'granted'`;
   `requestAria2Access()` → `aria2Access.request()`.
4. Open `saving.test.ts` and search for `aria2Granted` and
   `requestAria2Access`. Update each matching pin to the new text.

**Verify**: `bun run typecheck && bun run lint && bun run test` → exit 0.

## Test plan

- New: `src/components/use-origin-grant.test.ts`, three behavior tests, seen
  failing before Step 2.
- Updated: pins in `saving.test.ts` that quote removed text.
- Pattern: `src/components/owned-timer.test.ts`.

## Done criteria

ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bun run test` exits 0, including 3 tests in `use-origin-grant.test.ts`
- [ ] `export CODEDB_NO_HOOKS=1; rg -n 'useState<boolean \| null>' src` → no match
- [ ] `export CODEDB_NO_HOOKS=1; rg -n 'permissions\.(contains|request)' src/entrypoints/options`
      → exactly one match, the `browser.permissions.request({ origins })` call
      inside `connectProvider` in `sync.tsx`. That call asks for a provider's
      origins during Connect and is out of scope.
- [ ] `git status --short` shows no modified file outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:

- Quoted text in "Current state" is missing from the live file.
- `convexGranted`, `aria2Granted`, or `connecting` is read somewhere this plan
  does not list.
- `convexOriginPattern` or `aria2OriginPattern` does not return
  `Option.Option<string>`.
- Lint can be cleared only by disabling, renaming, or moving code.

## Maintenance notes

- A reviewer should check both "Grant access" buttons in a real browser.
  Chrome rejects `permissions.request` outside a user gesture, and no unit
  test covers that.
- The remaining nullable UI state is listed under "Out of scope". Plan 050's
  ratchet stops the count from rising while those wait.
