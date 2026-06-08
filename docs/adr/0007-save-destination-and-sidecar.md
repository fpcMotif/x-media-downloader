# ADR-0007 — Save destination: Downloads-relative templates + JSON sidecar

- **Status:** Accepted (2026-06-08)

## Context

`chrome.downloads.download({ filename })` writes **relative to the browser's
Downloads dir**: forward-slash subfolders are allowed, but absolute paths, empty
paths, and `..` back-references throw (grounding §d, ADR-0003). Users want
**user-directed directories** and auxiliary save options (a metadata file per
download, date buckets, per-tweet folders).

Three levers exist for "where + what extra is saved":

1. Richer **subfolder templates** — cheap; already supported by `renderFilename`
   (`{handle}/{tweetId}_{index}.{ext}`, `{date}/…`, etc.) under a relative-only
   sanitizer.
2. **Auxiliary sidecar metadata** — a per-item record of author/url/tweetId/type.
3. **Arbitrary absolute directory** — impossible via `chrome.downloads`; needs the
   File System Access API (gesture + document context, handle persisted via
   IndexedDB) or aria2 `--dir`.

## Decision

- **Naming stays template-driven and relative-only.** `core/download/destination.ts`
  reuses `renderFilename` (never re-implements sanitization) and exposes
  `planDownloads(...)`, which expands one `MediaItem` into the concrete set of
  downloads to perform.
- **Sidecar metadata is opt-in** (`sidecarMetadata` setting, default off). When on,
  `planDownloads` appends a `.json` sibling (`alice/123_0.jpg → alice/123_0.json`)
  delivered as a `data:application/json` URL through the **same** downloads path —
  **no extra host permissions**.
- **Arbitrary absolute directories are delegated to aria2 `--dir`** (ADR-0006), not
  to chrome.downloads. The File System Access API is **deferred** (its MV3 gesture/
  document-context constraints and IndexedDB-persisted handles need verification on
  a live target before committing).

## Consequences

- Users get per-author / per-date / per-tweet folder layouts today, plus an
  optional machine-readable sidecar — all within the lean `downloads` permission.
- True "pick any folder" is available only on the aria2 path; the Direct default
  remains Downloads-relative. This is a deliberate capability split, surfaced in
  the popup (the `--dir` field shows only when aria2 is selected).
- The sidecar rides the existing queue + strategy seam (it is a `SaveRequest` like
  any other), so it inherits concurrency limiting and retry.

## Alternatives considered

- **`saveAs: true` prompt per file** — unacceptable for bulk downloads.
- **File System Access API now** — promising for a true folder picker, but unverified
  under MV3; deferred to avoid shipping an unverified path.
- **ZIP-per-tweet / content-hash dedupe** — interesting auxiliary ideas, out of
  scope for this iteration.
