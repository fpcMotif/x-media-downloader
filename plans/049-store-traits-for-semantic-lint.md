# Plan 049: The Traits semantic linter checks three stored rules

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan in
> `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `ls -a .agents/traits` and `traits ls`.
> Both printed nothing when this plan was written. If either lists a trait,
> read it before you write a file with the same name.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none. Run it after 046–048 for a quieter first report.
- **Category**: dx
- **Planned at**: commit `2089ed0`, 2026-11-20
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/123

## Why this matters

The owner wants a semantic linter to hold three rules that a syntax linter
cannot judge: no effect that only derives state, no `null` or `undefined`
where a precise type can say what absence means, and no effect without an
external system behind it. The `traits` CLI (version 0.5.9) is installed, but
the repository stores no trait. `traits check --dry-run` on 27 UI files
reported "0 traits, 0 Jev requests", so the linter checks nothing today.

## Current state

- `traits` is on `PATH`. `traits check` sends file chunks to a decision model
  and prints a verdict per trait: pass, unsure, check, or fix.
- A trait is one Markdown file at `.agents/traits/<name>.md`. Its frontmatter
  requires `name`, `subject`, `requirement`, and `purpose`. `applicability`
  and `guidance` are optional. Any other frontmatter key is rejected. The
  Markdown body holds examples.
- `.agents/traits/` exists and is empty. There is no `traits.ts` at the
  repository root. Without one, Traits uses the TypeSafe decision model and
  reads its key from the `TYPESAFE_API_KEY` environment variable.
- `TYPESAFE_API_KEY` was not set in the shell that wrote this plan.
- This repository is a Preact browser extension. UI code lives in
  `src/entrypoints/popup`, `src/entrypoints/options`, and `src/components`.
- Effect's `Option` and `_tag` unions are the house way to model absence, for
  example `pageScope` returns `Option`.
- Three boundaries legitimately produce `null` or `undefined`: DOM APIs,
  `browser.*` extension APIs, and JSON from the Convex backend
  (`Schema.NullOr` in `src/packages/cloud/upload-job.ts`).

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| List traits | `traits ls` | three names |
| Dry run | `traits check --dry-run --include 'src/entrypoints/popup/**/*.tsx' --include 'src/entrypoints/options/**/*.tsx' --include 'src/components/**/*.tsx'` | "3 traits" and a non-zero request count |
| Real run | same command without `--dry-run`, plus `--fail-on never` | exit 0 and a findings list |

## Scope

**In scope**:

- `.agents/traits/effect-needs-external-system.md` (create)
- `.agents/traits/precise-absence.md` (create)
- `.agents/traits/named-ui-state.md` (create)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- Any source file. This plan only stores rules and reports findings.
- `package.json`, `hk.pkl`, and the `check` script. Wiring Traits into the
  gate is an owner decision, because every run costs model calls.
- `traits.ts`. Create it only if the owner names a provider other than the
  default.
- Never write an API key into any file, command line in this plan, or report.

## Git workflow

- Branch: `advisor/049-store-traits-for-semantic-lint`
- One commit. Message: `chore(traits): store effect and absence traits`.
- Do NOT push or open a PR unless the operator told you to.

## Steps

### Step 1: Confirm the key is available

Run `[ -n "$TYPESAFE_API_KEY" ] && echo set || echo unset`.

If it prints `unset`, write the three files in Steps 2–4, run the dry run in
Step 5, and then STOP. Report that the real run waits for the owner to export
`TYPESAFE_API_KEY`. Do not ask for the key value.

### Step 2: Create `.agents/traits/effect-needs-external-system.md`

```markdown
---
name: effect-needs-external-system
subject: useEffect calls in Preact components and hooks.
requirement: >
  An effect exists only to synchronize with a system outside the component: a
  timer, a DOM or window listener, a browser extension API, a network or
  message call, or imperative focus. An effect whose body only reads props or
  state and calls a state setter must be replaced by a value derived during
  render, a key that remounts the child, or code in the event handler that
  caused the change.
purpose: Remove extra renders and stale frames caused by state-syncing effects.
applicability: Files under src/entrypoints/popup, src/entrypoints/options, and src/components.
guidance: >
  Mount-time data loads go through useLoaded from src/components/use-loaded.ts.
  Host-permission checks go through useOriginGrant from
  src/components/use-origin-grant.ts. An effect that subscribes must return a
  cleanup.
---

## Violates

    useEffect(() => {
      setDraft(clientId)
    }, [clientId])

## Satisfies

    <CloudProviderRow key={clientId} clientId={clientId} />

    useEffect(() => {
      const id = setInterval(tick, TICK_MS)
      return () => clearInterval(id)
    }, [tick])
```

### Step 3: Create `.agents/traits/precise-absence.md`

```markdown
---
name: precise-absence
subject: Type annotations that include null or undefined.
requirement: >
  A function signature, exported type, or state type must not use `| null` or
  `| undefined` to mean "no value". It states what absence means: an Effect
  Option for a value that may be missing, a `_tag` union when there are
  distinct reasons or phases, or a named string-literal member such as 'none'
  or 'unknown'.
purpose: Make every reader handle each case by name instead of guessing what null means.
applicability: >
  First-party TypeScript under src. Does not apply to the line that receives a
  value from a DOM API, a browser.* extension API, or decoded backend JSON,
  provided the value is converted before it leaves that function.
guidance: >
  Convert at the boundary with Option.fromNullishOr or an explicit check.
  Schema.NullOr is correct for a wire format that carries JSON null. Do not
  convert an Option back with Option.getOrNull or Option.getOrUndefined just
  to pass it on.
---

## Violates

    const [granted, setGranted] = useState<boolean | null>(null)

    export function sizeReason(sizeBytes: number | null): SkipReason | null

## Satisfies

    type OriginGrant = 'unknown' | 'granted' | 'denied'

    export function sizeReason(sizeBytes: Option.Option<number>): Option.Option<SkipReason>
```

Before you save this file, confirm the helper name. Run
`export CODEDB_NO_HOOKS=1; rg -n 'Option\.fromNull' src | head -5`. If the codebase
uses a different `Option.fromNull…` name, write that name in `guidance`. If it
uses none, remove the helper name and keep "convert at the boundary with an
explicit check".

### Step 4: Create `.agents/traits/named-ui-state.md`

```markdown
---
name: named-ui-state
subject: useState declarations in Preact components and hooks.
requirement: >
  Component state that has phases declares them as a tagged union or a
  string-literal union. A loading, idle, empty, or failed phase is a named
  member, never null, undefined, or a boolean paired with a nullable value.
purpose: Stop one null from standing for loading, failure, and empty at once.
applicability: Files under src/entrypoints/popup, src/entrypoints/options, and src/components.
guidance: >
  Use Loaded<T> from src/components/use-loaded.ts for anything fetched.
---

## Violates

    const [summary, setSummary] = useState<CaptureSummary | null>(null)

## Satisfies

    const summaryLoad = useLoaded(loadArchiveSummary)
```

If plan 047 is not DONE, `src/components/use-loaded.ts` does not exist. Then
drop the `guidance` line from this file and the `useLoaded` sentence from the
first file, and say so in your report.

### Step 5: Dry run

Run the dry-run command from the table.

**Verify**: the last line reports `3 traits` and more than 0 Jev requests.
`traits ls` prints the three names. If a frontmatter key is rejected, fix the
file. Do not add keys.

### Step 6: Real run and report

Run the real command with `--fail-on never --json` and save the output
outside the repository. Then report, per trait, the count of `fix` and
`check` verdicts and the `file:line` of each `fix`. Do not edit source to
clear them. Each confirmed `fix` becomes input for plans 046–048 and 050.

**Verify**: the command exits 0 and the JSON parses.

## Test plan

No unit test. The dry run proves the traits load and match files. The real
run proves the model call works.

## Done criteria

ALL must hold:

- [ ] `traits ls` prints `effect-needs-external-system`, `precise-absence`, `named-ui-state`
- [ ] The dry run reports `3 traits` and a non-zero request count
- [ ] The real run exited 0 and its verdict counts are in the report, or the
      plan is marked BLOCKED with "TYPESAFE_API_KEY unset"
- [ ] `git status --short` shows only the three trait files and `plans/README.md`
- [ ] No key value appears in any file or in the report

## STOP conditions

Stop and report if:

- `TYPESAFE_API_KEY` is unset (after the dry run, see Step 1).
- `traits check` exits 2. Report the message. Do not install packages to fix
  it.
- The dry run would send more than 500 requests. Report the number and let
  the owner narrow the `--include` globs.

## Maintenance notes

- `traits check` with no `--include` checks changed files only. That is the
  cheap form for a pre-commit hook, if the owner wants one in `hk.pkl`.
- Model verdicts are probabilities, not proof. A reviewer reads the code
  before acting on a `fix`.
- When a rule changes, edit the trait file. The file is the source of truth.
