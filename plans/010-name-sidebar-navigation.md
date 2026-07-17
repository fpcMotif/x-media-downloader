# 010 — Name sidebar navigation

- **Workflow**: improve-react
- **Status**: TODO
- **Commit**: cf787c6
- **Severity**: LOW
- **Category**: Accessibility
- **Rule**: Beyond the scan
- **Estimated scope**: 2 files, about 20 lines

## Problem

The options sidebar renders two unnamed navigation landmarks:

```tsx
// src/entrypoints/options/App.tsx:148 — current
<p className="...">Settings</p>
<nav className="mb-4 flex flex-col gap-0.5">...</nav>

<p className="...">Library</p>
<nav className="flex flex-col gap-0.5">...</nav>
```

Screen-reader landmark lists expose both as generic `navigation`, so users
cannot distinguish Settings from Library.

## Target

Reuse the visible labels exactly:

```tsx
// src/entrypoints/options/App.tsx — target
<p id="settings-nav-label" className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground">
  Settings
</p>
<nav aria-labelledby="settings-nav-label" className="mb-4 flex flex-col gap-0.5">
  {settingsSections.map(/* current body */)}
</nav>

<p id="library-nav-label" className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground">
  Library
</p>
<nav aria-labelledby="library-nav-label" className="flex flex-col gap-0.5">
  {librarySections.map(/* current body */)}
</nav>
```

Do not add duplicate hidden labels. Do not include the word `navigation` in the
label; the landmark role already supplies it.

## Repo conventions to follow

- Keep visible grouping copy as the accessible source.
- Extend the source-contract test in `src/entrypoints/options/App.test.ts`.
- Preserve `NavItem` and its existing `aria-current` behavior.

## Steps

1. Execute/reconcile plan 009 first because it also edits `options/App.tsx`.
2. Add the two IDs and matching `aria-labelledby` attributes.
3. Extend `options/App.test.ts` to require each ID and reference exactly once.
4. Re-read the diff. No sidebar layout or grouping change.

## Boundaries

- Do NOT change section groups, hashes, buttons, copy, or layout.
- Do NOT use `aria-label` when a visible label already exists.
- Add no dependency.
- STOP until plan 009 drift is reconciled; stop on other drift from `cf787c6`.

## Verification

- **Mechanical**:
  - `bun run test -- src/entrypoints/options/App.test.ts`
  - `bun run typecheck`
  - `bun run lint`
  - `bun run build`
  - `npx --yes react-doctor@latest . --scope changed` adds no issue and lowers no score.
- **Behavior check**: In the browser accessibility tree or screen-reader
  landmarks list, confirm `Settings, navigation` and `Library, navigation`.
  Tab order, selection, and `aria-current` must remain unchanged.
- **Done when**: both landmarks have unique visible names, behavior/layout is
  unchanged, and all checks pass.
