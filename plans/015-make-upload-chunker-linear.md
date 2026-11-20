# Plan 015: Make the cloud upload chunker copy each byte once

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 7456911 -- src/packages/cloud/lib/chunk.ts src/packages/cloud/lib/chunk.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `7456911`, 2026-11-16. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.

## Why this matters

Cloud uploads stream a file to Google Drive or Dropbox in 8 MiB chunks.
`streamInChunks` builds each chunk by allocating a new array that holds
everything accumulated so far plus the new network read, on every read. Network
reads are small (tens of KiB), so filling one 8 MiB chunk copies the same bytes
again and again. The estimate from reading the code is about 60 times more
copying than the data size, plus the same amount of short-lived garbage, in the
extension's service worker. After this plan each input byte is copied exactly
once into a preallocated chunk buffer. The chunk contract does not change.

## Current state

Files and roles:

- `src/packages/cloud/lib/chunk.ts` — `streamInChunks` (lines 30–78) and
  `readAll` (82–106). Private to the `cloud` package.
- `src/packages/cloud/lib/chunk.test.ts` — the co-located unit tests.
- Callers (do not edit): `src/packages/cloud/drive.ts:175` with
  `RESUMABLE_CHUNK` (8 MiB) and `src/packages/cloud/dropbox.ts:129` with
  `SESSION_CHUNK` (8 MiB).

The contract, quoted from the file header (`src/packages/cloud/lib/chunk.ts:1-14`):

> Guarantee: every chunk except the final one is exactly `chunkBytes` […]; the
> final chunk is the true remainder. `isLast` is reported only on that final
> chunk. An empty stream yields a single empty final chunk.
>
> Implemented by holding back one full chunk until the next read confirms more
> data follows — so the last full chunk is correctly flagged `isLast` even when
> the total is an exact multiple of `chunkBytes`.

The same header states the memory bound this plan must keep: "bounding memory
to ~`chunkBytes` regardless of total size (ADR-0013: X video is 20–512 MB —
never buffer the whole file in the service worker)".

The code today (`src/packages/cloud/lib/chunk.ts:21-78`):

```ts
/** Always copies into a fresh ArrayBuffer-backed array — keeps chunks usable as a
 *  fetch `BodyInit` regardless of the source view's backing buffer. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

export async function streamInChunks(
  body: ReadableStream<Uint8Array>,
  chunkBytes: number,
  onChunk: (chunk: Uint8Array<ArrayBuffer>, info: ChunkInfo) => Promise<void>,
): Promise<number> {
  const size = chunkBytes
  const reader = body.getReader()
  let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0)
  let held: Uint8Array<ArrayBuffer> | null = null // a full chunk not yet known to be the last
  let offset = 0
  let total = 0

  const emit = async (chunk: Uint8Array<ArrayBuffer>, isLast: boolean): Promise<void> => {
    await onChunk(chunk, { offset, isLast })
    offset += chunk.length
  }

  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- stream reads are inherently sequential
      const { value, done } = await reader.read()
      if (value !== undefined && value.length > 0) {
        buffer = concat(buffer, value)
        total += value.length
      }
      while (buffer.length >= size) {
        // oxlint-disable-next-line no-await-in-loop -- chunk sinks must run in offset order
        if (held !== null) await emit(held, false)
        held = buffer.subarray(0, size)
        buffer = buffer.subarray(size)
      }
      if (done) break
    }
  } finally {
    reader.releaseLock()
  }

  // Drain: the held full chunk (if any) precedes the remainder; the very last
  // emit carries isLast. remainder.length < size (possibly 0).
  if (buffer.length > 0) {
    if (held !== null) await emit(held, false)
    await emit(buffer, true)
  } else if (held !== null) {
    await emit(held, true)
  } else {
    await emit(new Uint8Array(0), true)
  }
  return total
}
```

The problem line is `buffer = concat(buffer, value)`: one full copy of the
accumulated buffer per read.

A key fact for the fix: `held` keeps a reference to a full chunk across later
reads. A single reused buffer would be overwritten while `held` still points at
it. The fix must therefore allocate a new buffer for each chunk.

Repo conventions that apply (from `AGENTS.md`):

- Do not add `oxlint-disable`, `eslint-disable`, `@ts-ignore`, or
  `@ts-expect-error`. The two `oxlint-disable-next-line no-await-in-loop` lines
  above already exist. Keep both, with their text unchanged, each directly
  above the `await` it covers.
- Every `as` needs an uppercase `SAFETY:` comment. This plan needs no `as`.
- `unknown` is banned in parameters, returns, and type aliases.
- Named constants, not magic numbers. `const` by default.
- Tests are vitest. Assertions live inside `it()`.

Comment rule: do not add, edit, or delete code comments, except a comment that
describes code this plan removes. A pre-edit hook (`doc-lock`) blocks other
comment changes. The JSDoc block on `concat` describes `concat` only, so it
leaves together with `concat`. Every other comment in the file stays
byte-for-byte, including `// a full chunk not yet known to be the last` and the
`// Drain: …` block. Do not edit any Markdown file except this plan's status
row in `plans/README.md`.

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

**In scope** (the only files you should modify):

- `src/packages/cloud/lib/chunk.ts`
- `src/packages/cloud/lib/chunk.test.ts`
- `plans/README.md` (only this plan's status row, in the "Performance plans (012–023)" table)

**Out of scope** (do NOT touch, even though they look related):

- `readAll` in the same file — it already collects parts and copies once.
- `src/packages/cloud/drive.ts`, `src/packages/cloud/dropbox.ts` — the callers.
  The `streamInChunks` signature and chunk contract must not change.
- The chunk sizes `RESUMABLE_CHUNK` and `SESSION_CHUNK`.
- `src/packages/kernel/fetch-service.ts` — it only mentions `streamInChunks` in a comment.

## Git workflow

- Branch: `advisor/015-make-upload-chunker-linear`
- Conventional commits. Example from this repo:
  `feat(relay): support Last-Modified validator, direct folder upload, and bump Convex to 1.46.0`.
  Use `perf(cloud): …` here.
- Do NOT push or open a PR.
- The working tree has uncommitted user changes, and some may be in this plan's
  in-scope files. Never revert or stash them.
- Before editing, run the drift check command from the top of this plan. Note
  every in-scope file it lists: those files already hold uncommitted changes.
- Do not commit a file that had uncommitted changes before you started. Make
  the plan's edits in it, leave them unstaged, and name that file in your final
  message.
- Commit only in-scope files that were clean before you started. Stage each by
  explicit path.

## Steps

### Step 1: Write the failing copy-count test and the content guard

In `src/packages/cloud/lib/chunk.test.ts`, add `vi` to the vitest import
(`import { describe, it, expect, vi } from 'vitest'`). Add the two tests from
"Test plan" inside the existing `describe('streamInChunks', …)` block. Reuse
the file's `streamOf` and `bytes` helpers.

**Verify**: `bun run test src/packages/cloud/lib/chunk.test.ts` → test 1
("copies each input byte once") FAILS with a copied-byte count far above 1000.
Test 2 passes. All older tests pass.

### Step 2: Replace the accumulate-and-concat loop

In `src/packages/cloud/lib/chunk.ts`:

1. Delete the `concat` function and its JSDoc block (lines 21–28).
2. Replace the body of `streamInChunks` with the shape below. The signature,
   `emit`, the `try`/`finally`, the two `oxlint-disable-next-line` lines, and
   the `// Drain: …` comment stay as they are.

```ts
  const size = chunkBytes
  const reader = body.getReader()
  let filling: Uint8Array<ArrayBuffer> | null = null
  let filled = 0
  let held: Uint8Array<ArrayBuffer> | null = null // a full chunk not yet known to be the last
  let offset = 0
  let total = 0

  const emit = async (chunk: Uint8Array<ArrayBuffer>, isLast: boolean): Promise<void> => {
    await onChunk(chunk, { offset, isLast })
    offset += chunk.length
  }

  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- stream reads are inherently sequential
      const { value, done } = await reader.read()
      if (value !== undefined && value.length > 0) {
        total += value.length
        let taken = 0
        while (taken < value.length) {
          filling ??= new Uint8Array(size)
          const take = Math.min(size - filled, value.length - taken)
          filling.set(value.subarray(taken, taken + take), filled)
          filled += take
          taken += take
          if (filled === size) {
            // oxlint-disable-next-line no-await-in-loop -- chunk sinks must run in offset order
            if (held !== null) await emit(held, false)
            held = filling
            filling = null
            filled = 0
          }
        }
      }
      if (done) break
    }
  } finally {
    reader.releaseLock()
  }

  // Drain: the held full chunk (if any) precedes the remainder; the very last
  // emit carries isLast. remainder.length < size (possibly 0).
  if (filling !== null && filled > 0) {
    if (held !== null) await emit(held, false)
    await emit(filling.subarray(0, filled), true)
  } else if (held !== null) {
    await emit(held, true)
  } else {
    await emit(new Uint8Array(0), true)
  }
  return total
```

Points that must hold in your result:

- A new `Uint8Array(size)` is allocated per chunk, lazily, on the first byte of
  that chunk. No buffer is ever reused after it became `held`.
- A full chunk is exactly `size` long. The remainder is `filling.subarray(0, filled)`.
- Each input byte goes through exactly one `set` call.
- At most two chunk buffers are alive at once (`held` and `filling`).

**Verify**: `bun run test src/packages/cloud/lib/chunk.test.ts` → all pass,
including both new tests.

### Step 3: Run the callers' tests and the gate

**Verify**: `bun run test src/packages/cloud/drive.test.ts src/packages/cloud/dropbox.test.ts src/packages/cloud/lib/upload-pipeline.e2e.test.ts`
→ all pass. Then `bun run check` → exit 0. Then `bun run build` → exit 0.

## Test plan

Add to `src/packages/cloud/lib/chunk.test.ts`, in the `streamInChunks` block.
Model the structure on the existing test "reassembles across arbitrary read
boundaries" (line 48).

1. **"copies each input byte once"** — fails before the change. The requirement
   is that total bytes copied equals total bytes read.
   - Build 1000 pieces of 1 byte each: `Array.from({ length: 1000 }, () => bytes(1))`.
   - Before calling `streamInChunks`, install
     `const setSpy = vi.spyOn(Uint8Array.prototype, 'set')`.
   - Run `streamInChunks(streamOf(pieces), 100, async () => {})`.
   - Sum the lengths of the first argument of every recorded call:
     `setSpy.mock.calls.reduce((sum, [source]) => sum + source.length, 0)`.
   - Call `setSpy.mockRestore()` before asserting.
   - Assert the sum is `1000`. (Before the change it is about 50,000, because
     each 1-byte read re-copies up to 100 accumulated bytes.)
   - If TypeScript rejects `source.length` because the first argument is typed
     `ArrayLike<number>`, that type already has `length`; no cast is needed.
2. **"a held chunk keeps its bytes while later reads arrive"** — passes before
   and after; it guards against reusing one buffer.
   - Stream `[bytes(100, 1), bytes(100, 2), bytes(50, 3)]` with chunk size 100.
   - In the sink, push the chunk object itself into an array (do not copy it).
   - After `streamInChunks` resolves, assert three chunks with lengths
     `[100, 100, 50]`, and that every byte of chunk 0 is `1`, of chunk 1 is `2`,
     of chunk 2 is `3` (for example `[...chunks[0]!].every((b) => b === 1)`).

Verification: `bun run test src/packages/cloud/lib/chunk.test.ts` → all pass,
including 2 new tests. The 6 existing `streamInChunks` tests and 2 `readAll`
tests still pass unchanged.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] `rg -n "function concat|concat\(" src/packages/cloud/lib/chunk.ts` returns no matches
- [ ] `rg -c "oxlint-disable-next-line" src/packages/cloud/lib/chunk.ts` prints `3` (two in `streamInChunks`, one in `readAll`, same as before)
- [ ] The test "copies each input byte once" exists and passes
- [ ] `git status --short` shows no modified file outside the in-scope list that was not already modified before you started
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `streamInChunks` in the live file does not match the excerpt above.
- Any existing test in `chunk.test.ts`, `drive.test.ts`, `dropbox.test.ts`, or
  `upload-pipeline.e2e.test.ts` fails after the change. The chunk contract must
  not move.
- `bun run lint` reports a new finding in `chunk.ts` that you can only clear
  with a new suppression comment. Report the finding instead.
- The `doc-lock` hook rejects the edit. Report its message. Do not reword or
  remove other comments to get past it.
- A caller passes `chunkBytes <= 0`. The current code does not handle that
  either; do not add handling in this plan.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Peak memory is unchanged in order of magnitude: at most two chunk buffers
  (16 MiB with today's 8 MiB chunk size), where the old code held the held
  chunk, the accumulating buffer, and a temporary copy.
- The final (remainder) chunk is a view over a `chunkBytes`-sized buffer. The
  old code also emitted views (`buffer.subarray(…)`), so sinks already accept
  them. A sink that reads `chunk.buffer` directly would see the whole backing
  buffer; a reviewer should confirm `drive.ts` and `dropbox.ts` pass the chunk
  itself as the request body and not `chunk.buffer`.
- The numbers in "Why this matters" come from reading the code, not from a
  profile. The copy-count test is the measured evidence.
- Not in this plan: upload concurrency and the upload ledger's storage writes.
