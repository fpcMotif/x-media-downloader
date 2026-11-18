# Plan 040: Verify that the provider stored the bytes the extension sent

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan in
> `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/packages/cloud/drive.ts src/packages/cloud/dropbox.ts src/packages/cloud/lib/http.ts src/packages/cloud/types.ts`
> The command compares the working tree with the planning commit, so
> uncommitted changes show. Plans 037 and 039 edit these files and must land
> first. Their changes are expected. Compare the excerpts below with the live
> file and locate each edit by its quoted text. A quoted line that you cannot
> find is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/037-resume-browser-uploads.md (Parts A to D),
  plans/039-pause-on-auth-and-honor-retry-after.md
- **Category**: bug
- **Planned at**: commit `cee429a`, 2026-11-17 (working tree had uncommitted changes)
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/114

## Why this matters

An upload counts as succeeded when the provider answers 200. Nothing checks
that the stored file matches the source. If the media host closes the
connection early, the stream simply ends, and the extension commits a
truncated video as a complete file. The Drive adapter reports the byte count
it sent, not the size Drive stored. The Dropbox adapter trusts whatever
metadata comes back. Download History then shows a saved file that does not
play. After this plan a short source stream fails before the commit, Dropbox
rejects corrupted data on its side, and the stored size (and hash, where the
platform allows it) must match before a job succeeds.

## Provider facts (from official documentation, checked 2026-11-17)

Dropbox content hash,
<https://docs.dropboxapi.com/dropbox-api/docs/technical-reference/content-hash>:

1. "Split the file into blocks of 4 MB (4,194,304 or 4 * 1024 * 1024 bytes).
   The last block (if any) may be smaller than 4 MB."
2. "Compute the hash of each block using SHA-256."
3. "Concatenate the hash of all blocks in the binary format to form a single
   binary string."
4. "Compute the hash of the concatenated string using SHA-256. Output the
   resulting hash in hexadecimal format."

"Note there is no block for an empty file of zero length." The `FileMetadata`
object carries the server value in its `content_hash` property.

Dropbox request argument, on `files/upload`, `upload_session/append_v2`, and
`upload_session/finish`
(<https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/files/upload>):

- `content_hash`: "A hash of the file content uploaded in this call. If
  provided and the uploaded content does not match this hash, an error will
  be returned. Optional, but recommended to avoid committing data corrupted
  in transit."
- `UploadSessionFinishError` has a `content_hash_mismatch` variant.

Google Drive file fields,
<https://developers.google.com/workspace/drive/api/reference/rest/v3/files>:

- `size`: "Output only. Size in bytes of blobs and Google Workspace editor
  files." It arrives as a string.
- `sha256Checksum`: "The SHA256 checksum associated with this file, if
  available. This field is only populated for files with content stored in
  Google Drive". It is a hex string. "If available" means it can be absent.
- `md5Checksum` exists as well. WebCrypto has no MD5, so this plan does not
  use it.

Platform fact: `crypto.subtle.digest('SHA-256', bytes)` hashes one complete
buffer. WebCrypto has no incremental hashing. The Dropbox algorithm works
block by block, so it can be computed during a streamed upload. A plain
SHA-256 of a streamed Drive upload cannot.

Not confirmed: whether `upload_session/start` accepts `content_hash`. This
plan does not send it on `start`.

## Current state

Files:

- `src/packages/cloud/lib/http.ts` — `runUpload`. It reads the source and
  calls the `simple` or `streamed` sink.
- `src/packages/cloud/lib/source.ts` — `parseSource` reads `content-length`
  into `size`.
- `src/packages/cloud/drive.ts` — requests `fields=id` and returns the local
  byte count.
- `src/packages/cloud/dropbox.ts` — `dropboxSuccess` uses
  `meta.size ?? fallbackBytes`.
- Tests: `lib/http.test.ts`, `drive.test.ts`, `dropbox.test.ts`,
  `lib/upload-pipeline.e2e.test.ts` in `src/packages/cloud`.

`src/packages/cloud/lib/http.ts:96-104`:

```ts
    const run =
      s.size !== null && s.size <= SIMPLE_MAX_BYTES
        ? Effect.gen(function* () {
            const bytes = yield* Effect.promise(() => readAll(s.body))
            return bytes.length === 0 ? EMPTY_SOURCE : yield* sinks.simple(bytes, s.contentType)
          })
        : sinks
            .streamed(s.body, s.size, s.contentType)
            .pipe(Effect.map(({ outcome, bytes }) => (bytes === 0 ? EMPTY_SOURCE : outcome)))
```

`src/packages/cloud/drive.ts` (two request URLs and the success values):

```ts
        const res = yield* http.fetch(`${UPLOAD_BASE}?uploadType=multipart&fields=id`, {
        const init = yield* http.fetch(`${UPLOAD_BASE}?uploadType=resumable&fields=id`, {
                fileId = (await jsonAs<{ id?: string }>(res)).id ?? null
```

`src/packages/cloud/dropbox.ts:47-56`:

```ts
const dropboxSuccess = (
  meta: FileMetadata,
  fallbackBytes: number,
  path: string,
): UploadOutcome => ({
  kind: 'success',
  bytes: meta.size ?? fallbackBytes,
  remotePath: meta.path_display ?? path,
  ...(meta.id !== undefined ? { remoteId: meta.id } : {}),
})
```

The Dropbox `streamed` sink ignores the source size:

```ts
        streamed: (body) =>
          sessionUpload(args.accessToken, body, path).pipe(
```

Both adapters send 8 MiB chunks (`RESUMABLE_CHUNK`, `SESSION_CHUNK`). 8 MiB
is exactly two Dropbox hash blocks.

Binding decisions:

- ADR-0013: the source fetch is the one sanctioned media egress, and the
  extension never fakes a save. A mismatch must end as a real `failure`
  outcome.
- ADR-0017: `fetchPromise` serves the chunker sink, and orchestration stays
  Promise based. Hashing inside the sink uses plain `await`.
- The extension never deletes a user's file at a provider. A file that fails
  verification stays where it is.

Repo rules (root `AGENTS.md`): no `oxlint-disable`, `eslint-disable`,
`@ts-ignore`, `@ts-expect-error`. No new `as` casts. Name numeric constants.
No new dependency.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Typecheck | `bun run typecheck` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Format check | `bun run fmt:check` | exit 0 |
| Boundaries | `bun run lint:boundaries` | exit 0 |
| Focused tests | `bun run test <path>` | all pass |
| Full gate | `bun run check` | exit 0 |
| Build | `bun run build` | exit 0 |

If the format check fails, run `bunx oxfmt --write <files you changed>`.
Package manager is bun. Never use npm or npx. No step calls a real provider.

## Scope

**In scope** (the only files you may modify):

- `src/packages/cloud/lib/content-hash.ts` (create)
- `src/packages/cloud/lib/content-hash.test.ts` (create)
- `src/packages/cloud/lib/http.ts`
- `src/packages/cloud/lib/http.test.ts`
- `src/packages/cloud/drive.ts`
- `src/packages/cloud/drive.test.ts`
- `src/packages/cloud/dropbox.ts`
- `src/packages/cloud/dropbox.test.ts`

**Out of scope** (do NOT touch):

- `src/packages/cloud/lib/chunk.ts`. Plan 015 finished it.
- A streaming SHA-256 or MD5 implementation, and any new package. See
  "Maintenance notes".
- Deleting or overwriting a provider file after a mismatch.
- The Convex relay in `backend/`.
- `src/packages/cloud/upload-job.ts` and `src/background/cloud-upload.ts`. A
  mismatch is an ordinary `failure` outcome, which they already handle.
- Every Markdown file except the `plans/README.md` status row.

## Git workflow

- Branch: `advisor/040-verify-uploaded-bytes`.
- Conventional commits, for example
  `fix(cloud): fail an upload whose stored size differs from the source`.
- The working tree may hold uncommitted changes that are not yours. Never
  revert them and never stash them. Before you start, run
  `git status --short` on each in-scope path. If a file already shows
  changes, make your edits but do not commit that file. Report it as edited
  and uncommitted. Stage only by explicit path.
- Do NOT push. Do NOT open a PR.

## Comment rule

A `doc-lock` hook can block edits that add or change comments or Markdown.
Write no new comments. Keep every existing comment as written. If the hook
rejects an edit, STOP and report the rejection text.

## Steps

### Step 1: Add the hash helpers

Create `src/packages/cloud/lib/content-hash.test.ts` first. Compute the
expected values in the test with `node:crypto` `createHash('sha256')`, which
is independent of the code under test:

1. `sha256Hex(new Uint8Array(0))` equals
   `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
2. `sha256Hex` of the bytes of `'abc'` equals the `node:crypto` digest.
3. `dropboxContentHash` of 10 bytes equals
   `sha256(sha256(bytes))` computed with `node:crypto` (one block).
4. `dropboxContentHash` of a 9 MiB buffer with a repeating pattern equals a
   reference built in the test: split at 4,194,304 bytes, hash each block,
   concatenate the three binary digests, hash again, hex encode.
5. `dropboxContentHash(new Uint8Array(0))` equals the SHA-256 of an empty
   input (value from case 1).
6. A hasher from `makeDropboxHasher()` fed the same 9 MiB as one 8 MiB chunk
   and one 1 MiB chunk returns, from `digest()`, the same value as case 4.
7. Each `update(chunk)` call returns `dropboxContentHash(chunk)`.

Then create `src/packages/cloud/lib/content-hash.ts`:

```ts
export const DROPBOX_BLOCK_BYTES = 4 * 1024 * 1024

const toHex = (digest: ArrayBuffer): string =>
  Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')

const sha256 = (bytes: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> =>
  crypto.subtle.digest('SHA-256', bytes)

export const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  toHex(await sha256(bytes))

const blockDigests = (bytes: Uint8Array<ArrayBuffer>): Promise<Array<ArrayBuffer>> =>
  Promise.all(
    Array.from({ length: Math.ceil(bytes.length / DROPBOX_BLOCK_BYTES) }, (_unused, index) =>
      sha256(bytes.subarray(index * DROPBOX_BLOCK_BYTES, (index + 1) * DROPBOX_BLOCK_BYTES)),
    ),
  )

const hashOfDigests = async (digests: ReadonlyArray<ArrayBuffer>): Promise<string> => {
  const joined = new Uint8Array(digests.reduce((total, digest) => total + digest.byteLength, 0))
  digests.reduce((offset, digest) => {
    joined.set(new Uint8Array(digest), offset)
    return offset + digest.byteLength
  }, 0)
  return sha256Hex(joined)
}

export const dropboxContentHash = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  hashOfDigests(await blockDigests(bytes))

export const makeDropboxHasher = () => {
  const all: Array<ArrayBuffer> = []
  return {
    update: async (chunk: Uint8Array<ArrayBuffer>): Promise<string> => {
      const digests = await blockDigests(chunk)
      all.push(...digests)
      return hashOfDigests(digests)
    },
    digest: (): Promise<string> => hashOfDigests(all),
  }
}
```

The hasher is correct only when every chunk except the last is a multiple of
`DROPBOX_BLOCK_BYTES`. If `bytes.subarray` does not type-check as
`Uint8Array<ArrayBuffer>`, widen the helper parameter types to `Uint8Array`
and keep `crypto.subtle.digest` happy without a cast. If that is not
possible, STOP.

**Verify**: `bun run test src/packages/cloud/lib/content-hash.test.ts` → 7
pass. `bun run typecheck` → exit 0.

### Step 2: Fail a short source before the commit

Tests first.

In `lib/http.test.ts`:

1. Buffered path: a source that declares `size: 10` and yields 6 bytes
   returns a failure outcome whose reason contains
   `source ended early: 6 of 10 bytes`. The `simple` sink is not called.

In `drive.test.ts` and `dropbox.test.ts`, modeled on each file's streamed
upload test:

2. A source with `content-length` of 20 MiB that yields only 12 MiB ends in
   a failure outcome whose reason contains `source ended early`. For
   Dropbox, assert that no `upload_session/finish` request was sent. For
   Drive, assert that no PUT carried a total in `content-range` (no request
   whose `content-range` ends in a number after the slash).
3. A source with no `content-length` uploads as today.

**Verify**: the new tests FAIL before the source edit.

Implementation:

- `lib/http.ts`: add
  `export const shortSource = (provider: string, got: number, want: number): CloudHttpError => new CloudHttpError({ provider, status: 0, body: \`source ended early: ${got} of ${want} bytes\` })`.
  In the buffered branch of `runUpload`, after `readAll`, when
  `bytes.length !== s.size`, return
  `{ kind: 'failure', reason: \`source ended early: ${bytes.length} of ${s.size} bytes\` }`.
- `drive.ts`, in the resumable sink: when `info.isLast` and
  `meta.totalBytes !== null` and
  `info.offset + chunk.length !== meta.totalBytes`, throw
  `shortSource('drive', info.offset + chunk.length, meta.totalBytes)` before
  the PUT.
- `dropbox.ts`: change the `streamed` sink to `(body, size) =>` and pass
  `size` to `sessionUpload`. In its sink, when `info.isLast` and
  `size !== null` and the end offset differs from `size`, throw
  `shortSource('dropbox', <end offset>, size)` before the request. Apply the
  same check before the single-chunk `finish` call after the stream.

A source that sends more bytes than declared is caught by the same
inequality.

**Verify**: `bun run test src/packages/cloud` → all pass.

### Step 3: Let Dropbox verify every call and compare the committed file

Tests first, in `dropbox.test.ts`:

1. Buffered upload: the `dropbox-api-arg` header of `files/upload` contains
   `"content_hash":"<dropboxContentHash of the bytes>"`.
2. Streamed upload: each `append_v2` and the `finish` request carries the
   `content_hash` of that request's body.
3. The `finish` answer's `content_hash` equals the whole-file hash: success.
4. The `finish` answer's `content_hash` differs: failure outcome whose reason
   contains `content hash mismatch`.
5. The answer's `size` differs from the bytes sent: failure outcome whose
   reason contains `size mismatch`.
6. An answer without `content_hash` and without `size` succeeds, as today.

Implementation in `dropbox.ts`:

- Add `content_hash?: string` to the `FileMetadata` type.
- `simpleUpload`: compute `dropboxContentHash(bytes)` and add
  `content_hash` to the API argument.
- `sessionUpload`: create one `makeDropboxHasher()` per upload. Call
  `update(chunk)` for every chunk, including the chunk sent with `start`.
  Add the returned per-chunk hash as `content_hash` to the `append_v2` and
  `finish` arguments. Do not add it to `start`.
- Add a pure function
  `verifyDropbox(meta: FileMetadata, sentBytes: number, localHash: string): string | null`
  that returns `'dropbox size mismatch: stored X, sent Y'`,
  `'dropbox content hash mismatch'`, or `null`. It skips a check whose
  metadata field is absent.
- In both success paths, call `verifyDropbox`. On a non-null result, fail
  with `new CloudHttpError({ provider: 'dropbox', status: 0, body: <result> })`.
- If plan 037 Part E is in place and this attempt resumed from an offset
  above zero, the hasher did not see the first bytes. Skip the whole-file
  hash comparison for that attempt and keep the size comparison.

Add a test that `SESSION_CHUNK % DROPBOX_BLOCK_BYTES === 0`. Export
`SESSION_CHUNK` if it is not exported.

**Verify**: `bun run test src/packages/cloud/dropbox.test.ts` → all pass.

### Step 4: Compare what Drive stored

Tests first, in `drive.test.ts`:

1. Both create requests ask for `fields=id,size,sha256Checksum`. If plan 037
   Part C changed these URLs, assert on the `fields` parameter only.
2. Buffered upload, answer `size` equals the bytes sent and `sha256Checksum`
   equals `sha256Hex(bytes)`: success.
3. Buffered upload, `sha256Checksum` differs: failure outcome whose reason
   contains `checksum mismatch`.
4. Buffered or streamed upload, `size` differs: failure outcome whose reason
   contains `size mismatch`.
5. An answer with only `id` succeeds.
6. After a mismatch, `input.onResume` was called with `{}`. This applies
   only when plan 037 Part C is in place.

Implementation in `drive.ts`:

- Replace `fields=id` with `fields=id,size,sha256Checksum` in the multipart
  URL and the resumable start URL.
- Read the answer as `{ id?: string; size?: string; sha256Checksum?: string }`.
- Add a pure function
  `verifyDrive(stored: { size?: string; sha256Checksum?: string }, sentBytes: number, localSha256: string | null): string | null`.
  It returns `'drive size mismatch: stored X, sent Y'`,
  `'drive checksum mismatch'`, or `null`. It skips a check whose field is
  absent or whose local value is `null`.
- Buffered path: pass `await sha256Hex(bytes)`. Streamed path: pass `null`.
- On a non-null result: call `input.onResume?.({})` when that callback
  exists, then fail with
  `new CloudHttpError({ provider: 'drive', status: 0, body: <result> })`.
  Dropping the stored identity makes the next attempt create a new file
  instead of accepting the bad one.

**Verify**: `bun run test src/packages/cloud/drive.test.ts` → all pass.

### Step 5: Full gate

**Verify**: `bun run check` → exit 0. `bun run build` → exit 0.

## Test plan

- `lib/content-hash.test.ts`: seven cases. The oracle is the Dropbox
  algorithm text, implemented a second time in the test with `node:crypto`.
- `lib/http.test.ts`: one case. `drive.test.ts`: eight cases.
  `dropbox.test.ts`: nine cases. Patterns: the existing buffered and
  streamed tests in each file.
- Each new test must be seen failing before its source edit.
- `lib/upload-pipeline.e2e.test.ts` must pass unchanged. If its provider
  stubs reject the new `content_hash` argument or the new `fields` value,
  update the stubs only.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] `rg -n "fields=id&|fields=id\`|fields=id'" src/packages/cloud/drive.ts` shows no create request that asks for `id` alone
- [ ] `rg -n "content_hash" src/packages/cloud/dropbox.ts` shows the argument on `files/upload`, `append_v2`, and `finish`
- [ ] `rg -n "source ended early" src/packages/cloud` shows the buffered check and the shared helper
- [ ] All tests in the test plan exist and pass
- [ ] `git diff --stat -- package.json bun.lock` shows no change made by this plan
- [ ] `git status --short` shows only in-scope files as newly changed
- [ ] `plans/README.md` status row updated, or the status reported in the reply

## STOP conditions

Stop and report if:

- Plans 037 (Parts A to D) and 039 are not marked DONE in `plans/README.md`.
- A quoted line in "Current state" cannot be found and plans 037 or 039 do
  not explain the difference.
- The test runtime has no `crypto.subtle`.
- The hash helpers cannot be typed without a cast.
- A chunk other than the last is not a multiple of 4 MiB.
- A step seems to need a streaming hash library or any new dependency.
- A step seems to need a delete or overwrite call at a provider.
- A verification fails twice after one reasonable fix.
- The fix appears to need a file outside the in-scope list.

## Maintenance notes

- **Owner decision, not planned**: a streamed Drive upload (larger than
  8 MiB) gets a size check only. A full hash needs incremental SHA-256 or
  MD5, which WebCrypto does not offer. The options are a small vendored
  hasher or a new dependency. Either choice belongs to the owner.
- A file that fails verification after the commit stays at the provider. The
  retry uploads again. On Dropbox the retry then meets a path conflict and is
  renamed by the fallback from plan 037 Part D. The user may see two files,
  one of them bad. Per-call `content_hash` makes this case rare, because
  Dropbox rejects corrupt data before the commit.
- Hashing adds CPU work of one SHA-256 pass over each chunk. Nothing was
  measured. If large uploads slow down, measure before changing the design.
- The buffered Drive path hashes at most 8 MiB.
- If the chunk size ever changes, it must stay a multiple of 4 MiB. The test
  from Step 3 guards that.
- Reviewer: check that every mismatch produces a `failure` outcome and never
  a `success`, and that no secret, token, or session URL appears in a
  mismatch reason.
