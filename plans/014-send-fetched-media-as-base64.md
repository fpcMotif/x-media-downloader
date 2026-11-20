# Plan 014: Send Fetched-mode media to the offscreen document as one base64 string

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 7456911 -- src/packages/download/fetched-strategy.ts src/packages/download/tests/fetched-strategy.test.ts src/entrypoints/offscreen/main.ts src/packages/kernel`
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
- **Scope note**: letting the offscreen document fetch the media itself is NOT
  in this plan. `docs/adr/0003-dual-download-strategy.md`
  records that the Fetched strategy fetches "the bytes in the SW to verify
  content-type". Moving the fetch would change that decision, so this plan
  only changes how the already-fetched bytes cross to the offscreen document.

## Why this matters

With the opt-in "Fetched" download strategy, the service worker downloads a
file into memory and hands it to an offscreen document, which turns it into a
blob URL. The hand-off uses `runtime.sendMessage`, which serializes messages as
JSON. The code converts the file to a plain array with one JavaScript number
per byte (`Array.from(bytes)`). For a file of N bytes that means an N-element
array on the sending side, a JSON text of roughly 3–4 characters per byte, and
an N-element array again on the receiving side, before the real copy is made.
The size cap is 96 MiB, so one large video can transiently use many hundreds of
megabytes in two processes and take seconds to serialize. After this plan the
bytes cross as one base64 string (1.33 characters per byte). By estimate from
the data shapes, not by measurement, that roughly halves peak memory for the
hand-off and removes the per-element array work. What reaches disk is unchanged
for files that could be sent before.

## Current state

Files and roles:

- `src/packages/download/fetched-strategy.ts` — the Fetched strategy and its
  ports. `makeOffscreenPort().saveBlob` (lines 267–281) sends the bytes.
- `src/entrypoints/offscreen/main.ts` — the offscreen document. It receives
  the message and builds the Blob (lines 18–33 and 46–57).
- `src/packages/download/tests/fetched-strategy.test.ts` — strategy and port
  tests. The `makeOffscreenPort` tests start at line 457.
- `src/packages/kernel/` — shared primitives with tests under
  `src/packages/kernel/tests/`. Both files above already import from it.

The sender (`src/packages/download/fetched-strategy.ts:228-236` and `:267-281`):

```ts
/** The client-side mirror of the offscreen document's `OffscreenSaveRequest`
 *  (src/entrypoints/offscreen/main.ts) — kept in sync by hand since the two
 *  sides of a `runtime.sendMessage` cannot literally share a type. */
interface OffscreenSaveRequestMessage {
  readonly _tag: 'OffscreenSaveRequest'
  readonly bytes: ReadonlyArray<number>
  readonly mimeType: string
  readonly filename: string
}
```

```ts
    saveBlob: async ({ bytes, mimeType, filename }) => {
      const res = await browser.runtime.sendMessage<
        OffscreenSaveRequestMessage,
        OffscreenSaveReply
      >({
        _tag: 'OffscreenSaveRequest',
        bytes: Array.from(bytes),
        mimeType,
        filename,
      })
      if (!hasDownloadId(res)) {
        throw new OffscreenSaveError({ message: res.error ?? 'offscreen save failed' })
      }
      return res.downloadId
    },
```

The receiver (`src/entrypoints/offscreen/main.ts:18-33` and `:46-57`):

```ts
type OffscreenSaveRequest = {
  readonly _tag: 'OffscreenSaveRequest'
  readonly bytes: ReadonlyArray<number>
  readonly mimeType: string
  readonly filename: string
}

// Type guard for message validation
function isSaveRequest(message: JsonObject): message is OffscreenSaveRequest {
  return (
    message._tag === 'OffscreenSaveRequest' &&
    Array.isArray(message.bytes) &&
    isJsonString(message.mimeType) &&
    isJsonString(message.filename)
  )
}
```

```ts
  void (async () => {
    let objectUrl: string | null = null
    try {
      const blob = new Blob([Uint8Array.from(m.bytes)], { type: m.mimeType })
      objectUrl = URL.createObjectURL(blob)
      const downloadId = await browser.downloads.download({
        url: objectUrl,
        filename: m.filename,
        conflictAction: 'uniquify',
        saveAs: false,
      })
      sendResponse({ downloadId })
```

The cap and its comment (`src/packages/download/fetched-strategy.ts:17-24`):

```ts
/**
 * Above this body size the SW must NOT buffer the whole response: Fetched reads
 * the full body into a `Uint8Array` and then `Array.from`s it across the message
 * boundary to the offscreen doc (several multiples of the file size resident at
 * once), so a large video would OOM the worker. Over-cap payloads fall back to
 * the Direct strategy, which streams straight to disk with zero SW buffering.
 */
export const MAX_FETCHED_BYTES = 96 * 1024 * 1024 // 96 MiB
```

A second comment mentions the old transport (`fetched-strategy.ts:152-155`):

```ts
        // Belt-and-suspenders: a missing or under-reported content-length could
        // still hand us an over-cap body — prefer Direct over Array.from-messaging
        // it across to the offscreen document.
        if (direct !== undefined && bytes.length > maxBytes) return yield* direct.save(req)
```

An existing port test, to model new tests on
(`src/packages/download/tests/fetched-strategy.test.ts:462-479`):

```ts
  it('throws OffscreenSaveError when the offscreen response carries an error', async () => {
    // SAFETY: same partial-stub justification as `stubOffscreen` above — no real
    // `browser.offscreen` to spread, and this test never touches `Reason`.
    const offscreenStub: Partial<typeof browser.offscreen> = {
      hasDocument: async () => true,
      createDocument: async () => {},
      closeDocument: async () => {},
    }
    browser.offscreen = offscreenStub
    browser.runtime.sendMessage = async () => ({
      error: 'disk full',
    })

    const port = makeOffscreenPort()
    await expect(
      port.saveBlob({ bytes: new Uint8Array([1]), mimeType: 'image/jpeg', filename: 'a.jpg' }),
    ).rejects.toMatchObject({ _tag: 'OffscreenSaveError', message: 'disk full' })
  })
```

The repo has one existing base64 helper, for small OAuth values only
(`src/packages/cloud/oauth.ts:35-39`). Do not reuse it: it is base64url, it
strips padding, and it appends one character per byte.

Design constraints, quoted from `docs/adr/0003-dual-download-strategy.md`:

- "**Fetched** — `fetch()` the bytes in the SW to verify content-type / hash /
  repackage." The fetch stays in the service worker.
- "**base64 data-URI** instead of offscreen — ~64 MB cap, memory-heavy for
  video." That rejected alternative is a `data:` URL handed to
  `chrome.downloads`. This plan does not do that. The offscreen document still
  builds a Blob and a blob URL; base64 is only the message encoding.

Repo conventions that apply (from `AGENTS.md` and `src/packages/README.md`):

- No `oxlint-disable`, `eslint-disable`, `@ts-ignore`, or `@ts-expect-error`.
- Every `as` needs an uppercase `SAFETY:` comment. This plan needs no new `as`.
- `unknown` is banned in parameters, returns, and type aliases.
- Named constants, not magic numbers. Regex and constants at module top level.
- Code outside a package imports only the package's root files. A new root
  file in `src/packages/kernel/` is a new entry point. Tests in `tests/` import
  through root files. `bun run lint:boundaries` enforces this.
- Tests are vitest. Assertions live inside `it()`.

Comment rule: do not add, edit, or delete code comments, except a comment that
describes code this plan removes. A pre-edit hook (`doc-lock`) blocks other
comment changes. Two existing comments mention `Array.from` (lines 17–23 and
152–154 of `fetched-strategy.ts`). Leave both unchanged; "Maintenance notes"
records that they are now stale so a docs pass can fix them. Do not edit any
Markdown file except this plan's status row in `plans/README.md`. The target
code below deliberately has no new comments.

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

- `src/packages/kernel/base64.ts` (create)
- `src/packages/kernel/tests/base64.test.ts` (create)
- `src/packages/download/fetched-strategy.ts`
- `src/packages/download/tests/fetched-strategy.test.ts`
- `src/entrypoints/offscreen/main.ts`
- `plans/README.md` (only this plan's status row, in the "Performance plans (012–023)" table)

**Out of scope** (do NOT touch, even though they look related):

- `makeFetchedStrategy`, `FetchPort`, `makeFetchPort`, the content-type check,
  and the size-cap / Direct-fallback logic. The fetch stays in the service
  worker (ADR-0003).
- `MAX_FETCHED_BYTES` — keep 96 MiB.
- `OffscreenPort` — its `saveBlob` signature still takes `bytes: Uint8Array`.
- `ensureDocument` / `closeDocument` and the `offscreenSaves` refcount. Do not
  add an idle timer that keeps the document open: a suspended service worker
  would lose the timer and leave the document open with no owner.
- `src/packages/cloud/oauth.ts` — its base64url helper stays as it is.
- `src/packages/kernel/sender-guard.ts` — the sender check in `main.ts` stays.

## Git workflow

- Branch: `advisor/014-send-fetched-media-as-base64`
- Conventional commits. Example from this repo:
  `feat(relay): support Last-Modified validator, direct folder upload, and bump Convex to 1.46.0`.
  Use `perf(download): …` here.
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

### Step 1: Add a tested base64 codec to the kernel package

Create `src/packages/kernel/tests/base64.test.ts` with the tests in "Test
plan" items 1–4. Import from `'../base64'`, the same way
`src/packages/kernel/tests/backoff.test.ts` imports from `'../backoff'`.

**Verify**: `bun run test src/packages/kernel/tests/base64.test.ts` → FAILS
(module not found).

Then create `src/packages/kernel/base64.ts`:

```ts
const BINARY_STRING_CHUNK_BYTES = 0x8000

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let at = 0; at < bytes.length; at += BINARY_STRING_CHUNK_BYTES) {
    parts.push(String.fromCharCode(...bytes.subarray(at, at + BINARY_STRING_CHUNK_BYTES)))
  }
  return btoa(parts.join(''))
}

export function base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded)
  const out = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at += 1) out[at] = binary.charCodeAt(at)
  return out
}
```

The chunking exists because `String.fromCharCode(...allBytes)` throws
"Maximum call stack size exceeded" for large inputs. `0x8000` arguments per
call is safely below engine limits.

**Verify**: `bun run test src/packages/kernel/tests/base64.test.ts` → all pass.

### Step 2: Write the failing transport test

In `src/packages/download/tests/fetched-strategy.test.ts`, inside
`describe('makeOffscreenPort — OffscreenSaveError', …)` or the following
`describe('makeOffscreenPort', …)` block, add test 5 from "Test plan". Stub
`browser.offscreen` exactly as the existing test at line 462 does.

**Verify**: `bun run test src/packages/download/tests/fetched-strategy.test.ts`
→ the new test FAILS (the message carries `bytes: [0, 127, 128, 255]`, not
`bytesBase64`). All older tests pass.

### Step 3: Switch both sides of the message to base64

Do both edits in this step, so the two sides are never out of sync in a commit.

In `src/packages/download/fetched-strategy.ts`:

1. Add `import { bytesToBase64 } from '@/packages/kernel/base64'` next to the
   other `@/packages/kernel/...` imports.
2. In `OffscreenSaveRequestMessage`, replace the line
   `readonly bytes: ReadonlyArray<number>` with `readonly bytesBase64: string`.
   Leave the JSDoc above the interface unchanged.
3. In `saveBlob`, replace `bytes: Array.from(bytes),` with
   `bytesBase64: bytesToBase64(bytes),`.

In `src/entrypoints/offscreen/main.ts`:

1. Add `import { base64ToBytes } from '@/packages/kernel/base64'`.
2. In the `OffscreenSaveRequest` type, replace
   `readonly bytes: ReadonlyArray<number>` with `readonly bytesBase64: string`.
3. In `isSaveRequest`, replace `Array.isArray(message.bytes) &&` with
   `isJsonString(message.bytesBase64) &&`.
4. Replace `new Blob([Uint8Array.from(m.bytes)], { type: m.mimeType })` with
   `new Blob([base64ToBytes(m.bytesBase64)], { type: m.mimeType })`.

Do not change any comment in either file.

**Verify**: `bun run test src/packages/download/tests/fetched-strategy.test.ts`
→ all pass, including the new test. `bun run typecheck` → exit 0.
`rg -n "Array.from\(bytes\)|Uint8Array.from\(m\.bytes\)|message\.bytes\b" src/packages/download/fetched-strategy.ts src/entrypoints/offscreen/main.ts`
→ no matches.

### Step 4: Run the gate

**Verify**: `bun run check` → exit 0. `bun run build` → exit 0.

## Test plan

`src/packages/kernel/tests/base64.test.ts` (model on
`src/packages/kernel/tests/backoff.test.ts`). All four fail before the change
because the module does not exist.

1. **Known vector.** `bytesToBase64(new Uint8Array([0, 127, 128, 255]))` is
   `'AH+A/w=='`. `[...base64ToBytes('AH+A/w==')]` is `[0, 127, 128, 255]`.
   (This is standard base64 with padding, from RFC 4648's alphabet.)
2. **Every byte value survives a round trip.** Build a 256-byte array holding
   0..255. `base64ToBytes(bytesToBase64(all))` has the same length and values.
3. **Input longer than one chunk survives a round trip.** Build 70,000 bytes
   with `bytes[i] = i % 251`. Round trip and compare length and every value.
   (70,000 is above the 32,768-byte chunk, so it crosses a chunk boundary.)
4. **Empty input.** `bytesToBase64(new Uint8Array(0))` is `''`, and
   `base64ToBytes('')` has length 0.

`src/packages/download/tests/fetched-strategy.test.ts`:

5. **`saveBlob` sends the bytes as one base64 string, not a number array**
   (fails before the change). Replace `browser.runtime.sendMessage` with a
   `vi.fn` that resolves `{ downloadId: 7 }`. Call
   `port.saveBlob({ bytes: new Uint8Array([0, 127, 128, 255]), mimeType: 'image/jpeg', filename: 'a.jpg' })`.
   Expect the result to be `7`. Expect the mock to have been called once with
   exactly `{ _tag: 'OffscreenSaveRequest', bytesBase64: 'AH+A/w==', mimeType: 'image/jpeg', filename: 'a.jpg' }`
   (use `toHaveBeenCalledWith` with that object, so a leftover `bytes` key
   fails the test).

`src/entrypoints/offscreen/main.ts` has no unit tests. Its edit is verified by
typecheck, the `rg` check in Step 3, and the codec tests.

Verification: `bun run test src/packages/kernel/tests/base64.test.ts src/packages/download/tests/fetched-strategy.test.ts`
→ all pass, 5 new tests.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] `bun run lint:boundaries` exits 0
- [ ] The 5 new tests exist and pass
- [ ] `rg -n "Array.from\(bytes\)" src/packages/download/fetched-strategy.ts` returns no matches
- [ ] `rg -n "bytesBase64" src/packages/download/fetched-strategy.ts src/entrypoints/offscreen/main.ts` returns 5 matches (2 in the strategy file, 3 in the offscreen file)
- [ ] `git diff -U0 -- src | rg "^\+.*(oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error)"` returns no matches
- [ ] `git status --short` shows no modified file outside the in-scope list that was not already modified before you started
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `saveBlob` or `src/entrypoints/offscreen/main.ts` does not match the excerpts.
- `bun run lint` rejects `String.fromCharCode(...bytes.subarray(…))` (for
  example a no-spread rule) and you cannot satisfy it without a suppression
  comment or an `as` cast. Report the rule name.
- Another sender or receiver of `OffscreenSaveRequest` exists besides the two
  files above (`rg -n "OffscreenSaveRequest" src`). Both sides must change together.
- An existing test in `fetched-strategy.test.ts` asserts the `bytes` array
  shape of the message.
- You find yourself changing where the fetch happens, the size cap, or the
  document open/close logic. Those are out of scope.
- The `doc-lock` hook rejects an edit. Report which edit and its message.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The memory claim is an estimate from data shapes: a number array plus its
  JSON text on each side, against a one-byte-per-character base64 string on
  each side. Nobody profiled it. A reviewer who wants a number should save one
  ~90 MiB video in Fetched mode before and after and compare the service
  worker's and the offscreen document's peak memory in Chrome's task manager.
- Stale comments left on purpose (the comment lock forbids editing them here):
  `fetched-strategy.ts:17-23` and `:152-154` still say `Array.from`. A docs
  pass should reword them to "base64-encodes".
- Chrome 140 and later provide `Uint8Array.prototype.toBase64()` and
  `Uint8Array.fromBase64()`, which avoid the intermediate binary string. The
  build targets Chrome 120 and later, so this plan does not use them. When the
  minimum version rises, `src/packages/kernel/base64.ts` is the one place to change.
- Deferred, needs a decision first: the larger win is to stop moving bytes
  through messages at all, either by letting the offscreen document fetch the
  URL itself or by handing over a Blob through the Cache API or IndexedDB.
  The first option changes what ADR-0003 records, and both need a manual check
  in a real browser. They were left out for those reasons.
- Extension messages have a size ceiling. It is believed to be 64 MiB; this was
  not verified against Chrome's documentation. A file near the 96 MiB cap is
  about 128 MiB as base64 and may still fail to send. The number array already
  fails at a smaller file size today, so this plan does not make that worse.
- Open questions for the maintainer, not acted on here:
  1. `src/entrypoints/offscreen/main.ts:51` calls `browser.downloads.download`
     from the offscreen document. Chrome's documentation says offscreen
     documents can use only the `chrome.runtime` API. If that holds, this call
     fails and Fetched mode never saves. Verify in a real browser.
  2. `main.ts:61` revokes the blob URL in `finally`, as soon as
     `downloads.download` resolves. That promise resolves when the download
     starts, not when it finishes. Confirm large files finish writing.
- Deferred: keeping the offscreen document open between saves. It needs an
  owner that survives service-worker suspension (for example an alarm), which
  is a separate change.
