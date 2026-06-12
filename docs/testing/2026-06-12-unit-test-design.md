# Comprehensive Unit Test Design — 100% Coverage Goal

**Date:** 2026-06-12 · **Status:** Design only — no new tests implemented or run yet.
**Goal:** 100% statements / branches / functions / lines across `src/**/*.{ts,tsx}`.
The threshold is already enforced in `vitest.config.ts` (`coverage.thresholds: 100`),
so `vitest run --coverage` fails until every case below lands.

---

## 0. Scope and ground rules

- **Frontend** = popup (`src/entrypoints/popup/`) and the overlay content script
  (`src/entrypoints/overlay.content/`), both Preact.
- **Backend** = the extension's background service worker
  (`src/entrypoints/background.ts`) plus all of `src/core/**`. There is **no Convex
  in this codebase** (verified by repo-wide search). The equivalent "server actions"
  are `chrome.runtime` messages handled by the background SW and `chrome.storage`
  persistence — these are **simulated** with `wxt/testing/fake-browser`
  (`@webext-core/fake-browser`, already wired by the `WxtVitest` plugin) and verified
  end-to-end in the contract suite (§6). If a Convex backend is added later, the
  same contract-suite pattern applies: simulate the action with a fake transport,
  assert both the request the client sends and the response handling.
- **Harshness policy:** every suite includes adversarial inputs (path traversal,
  spoofed hosts, prototype-pollution payloads, clock skew, NaN/negative numbers,
  out-of-order async, detached DOM nodes). Where the current behavior is wrong or
  questionable, the test **pins the current behavior** and the case is cross-linked
  to a bug candidate in §7 — pinning first means the future fix is a deliberate,
  visible diff, not an accidental one.
- Existing tests (~120 cases) are kept; this document only catalogs the **new**
  cases. IDs are stable (`FN-N3` = filename, new case 3) so implementation tasks
  can reference them.

## 1. Test infrastructure

| Concern | Tool / approach |
|---|---|
| Chrome APIs (`storage`, `runtime`, `downloads`, `tabs`, `permissions`) | `fakeBrowser` from `wxt/testing/fake-browser` + `vi.spyOn` for APIs the fake doesn't model (`downloads.download`, `downloads.search`, `permissions.*`) |
| DOM | `happy-dom` (already configured); `document.elementsFromPoint` stubbed per test (happy-dom has no layout) |
| Timers (dwell 500 ms, popup 1 s poll, 1200/1500 ms feedback) | `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync` |
| Preact components | `@testing-library/preact` (added as devDependency) |
| aria2 daemon | in-memory `fetch` stub implementing JSON-RPC success/error/secret-check |
| Module-level mutable state (`background.ts`: `live`, `inFlight`, trace ring) | `vi.resetModules()` + dynamic `import()` per test so each test gets a fresh SW |
| Entrypoints | `defineContentScript`/`defineBackground` return their definition; tests call `def.main(fakeCtx)` with a stub `ContentScriptContext` (`addEventListener`, `requestAnimationFrame`, `onInvalidated`) and a mocked `createShadowRootUi` |
| Fixtures | extend `src/test/fixtures/` with: `user-media.json`, `tweet-no-rest-id.json`, `tweet-proto-pollution.json`, real-DOM HTML snippets (grid, quote card, lightbox) |

### Testability refactors required for 100% (no behavior change)

1. **`overlay.content/index.tsx`** — extract the pure helpers currently trapped in
   the module/`main()` closure into `overlay.content/hover.ts`: `bgAlpha`,
   `mediaAtPoint`, `previewSrcFromMedia`, `previewKeyFromMedia`, `keysForItem`,
   `rectOf`, and the `sendTracked` reply predicate (`r?.completed !== undefined &&
   r.completed === r.total`). The stateful controller is then tested through
   `def.main(fakeCtx)`; the helpers get direct unit tests (OV-N1, OV-N25).
2. **`popup/App.tsx`** — export `fmtRate`, `fmtBytes`, `fmtDuration`, `fmtStage`,
   `traceDetail` (pure formatters) for direct table-driven tests (POP-N10);
   component tests cover the rest.
3. **`background.ts`** — no extraction needed; everything is reachable through the
   two listeners. Keep it that way (the listeners ARE the public contract).

---

## 2. Core pure modules (`src/core/**`) — new cases

### 2.1 `core/schema` (SCH)

| ID | Case | Expectation |
|---|---|---|
| SCH-N1 | `{}` decodes to the full canonical default record | exact deep-equality on all 12 keys (template, 3, false, `direct`, `system`, true, `alt`, false, `http://localhost:6800/jsonrpc`, `''`, `''`, 8) |
| SCH-N2 | partial object | only missing keys defaulted; present keys untouched |
| SCH-N3 | wrong type per field (table-driven: `filenameTemplate:1`, `downloadConcurrency:'3'`, `authFallbackEnabled:'yes'`, `downloadStrategy:'torrent'`, `theme:'neon'`, `quickGrabModifier:'hyper'`, `sidecarMetadata:0`, `aria2Split:'8'`) | each decode fails |
| SCH-N4 | `downloadConcurrency` of `0`, `-3`, `2.5`, `Infinity`, `NaN` | **passes** schema (no bounds) — pin; → BC-1 |
| SCH-N5 | MediaItem: each required key missing (7-row table) | decode fails per row |
| SCH-N6 | MediaItem optionals (`previewUrl`, `width`, `height`, `bitrate`) absent vs present | round-trips exactly; absent keys stay absent |
| SCH-N7 | all 9 `Message` variants decode and narrow by `_tag` | existing tests cover 4; add `DetectRequest`, `MediaDetected`, `QueueUpdate`, `MetricsRequest`, `MetricsUpdate` |
| SCH-N8 | `Message` rejects: unknown `_tag`, missing `_tag`, `null`, `42`, `[]` | decode failure, no throw |
| SCH-N9 | `MetricsSnapshot` with/without `etaSeconds` and `events` | optional-key semantics preserved |
| SCH-N10 | excess properties on `Settings` input | pin actual Effect v4 Struct behavior (strip vs reject) with an explicit assertion |
| SCH-N11 | decode∘encode identity for one representative value per Message variant | structured-clone-safe shapes (what `sendMessage` actually carries) |

### 2.2 `core/settings` (SET) — the storage logic

| ID | Case | Expectation |
|---|---|---|
| SET-N1 | two sequential `set` patches on different keys | both persist (merge, not replace) |
| SET-N2 | `set` return value | equals a subsequent `get` |
| SET-N3 | `set` with an invalid value (`theme:'neon' as never`) | decode throws → **all settings reset to defaults and persisted** — pin; → BC-2 |
| SET-N4 | stored value `null` | defaults (`raw ?? {}` branch) |
| SET-N5 | stored value a primitive (`'garbage'`) | defaults (catch branch) |
| SET-N6 | `getSettings()` / `setSettings()` promise wrappers | resolve correctly (covers the `provide` helper) |
| SET-N7 | corrupt store, then `set(patch)` | result is `defaults + patch`, corrupt data healed |
| SET-N8 | `Promise.all([set(a), set(b)])` racing | final state is one of the two merged outcomes — pins ADR-0005's non-atomic read-modify-write |
| SET-N9 | `unwatch()` called twice; watch callback never sees a raw (undecoded) value | no throw; callback arg always passes `Settings` decode |

### 2.3 `core/errors` (ERR)

| ID | Case |
|---|---|
| ERR-N1 | `DownloadError`: `_tag === 'DownloadError'`, carries `id`+`reason`, `instanceof` works, catchable via `Effect.catchTag` |
| ERR-N2 | `DetectError`: same shape checks |

### 2.4 `core/download/filename` (FN) — security-sensitive

| ID | Case | Expectation |
|---|---|---|
| FN-N1 | unknown word token `{nope}` | renders empty |
| FN-N2 | non-word token `{a-b}` | left **literal** incl. braces (regex is `\w+`; braces aren't in ILLEGAL) — pin; → BC-3 |
| FN-N3 | handle containing `/` (`'a/b'`) | becomes a real subfolder (substitution happens before split) — pin: each segment still sanitized, traversal impossible |
| FN-N4 | handle `'..'`, `'../..'`, `'....//..'` | collapsed/stripped; output never contains `..` |
| FN-N5 | template of only separators/illegal (`'///'`, `':*?'`) | fallback `${tweetId}_${index}.${ext}` |
| FN-N6 | leading `/` template | leading empty segment filtered → relative path |
| FN-N7 | control chars `\x00`/`\x1f` stripped; interior space kept; edge spaces trimmed | exact output |
| FN-N8 | backslash payload `..\\..\\evil` | `\` stripped — no Windows traversal |
| FN-N9 | `'a..b'` → `'a.b'`; `'....'` → segment dropped | exact output |
| FN-N10 | `{date}` with no `date` arg, template `'{date}_x.{ext}'` | renders `'_x.jpg'` (dangling separator kept) — pin |
| FN-N11 | emoji / CJK handle | preserved verbatim |
| FN-N12 | `index` 0 and 9999 | `'0'`, `'9999'` |
| FN-N13 | trailing dot/space in final segment (`'name. '` after trim → `'name.'`) | **not** stripped — Windows-invalid, pin; → BC-4 |
| FN-N14 | token repeated (`'{ext}.{ext}'`) | substituted both times |

### 2.5 `core/resolver` (RS)

| ID | Case | Expectation |
|---|---|---|
| RS-N1 | `id_str` missing | id falls back to URL basename; dedupe works on that basename across entries |
| RS-N2 | `extFromUrl` with query (`…/a.jpg?name=large`) → `jpg`; no dot in path → fallback | exact ext |
| RS-N3 | `upgradePhotoUrl`: unparseable URL returned unchanged; already `name=orig` idempotent; `format=webp`→`jpg`; `format=png` untouched; unrelated params preserved | 5 assertions |
| RS-N4 | `pickVideoVariant`: empty array → null; single bitrate-less mp4 chosen; **equal bitrates → first wins** (strict `>`) | pin tie-break |
| RS-N5 | photo `media_url_https` with query and no path dot | ext falls back to `'jpg'` |
| RS-N6 | empty `media` array | `[]` |
| RS-N7 | variant without `bitrate` | `'bitrate' in item === false` (key truly absent, not `undefined`) |
| RS-N8 | photo and video sharing one `id_str` | deduped across types, first wins |
| RS-N9 | `previewUrl === media_url_https` for photo, video, and gif | all three types |

### 2.6 `core/selection` (SEL)

| ID | Case |
|---|---|
| SEL-N1 | `selectTweet` with absent tweetId → set unchanged, no throw |
| SEL-N2 | `selectTweet` unions with prior picks (existing picks survive) |
| SEL-N3 | `selectThread` never matches groups whose `threadId` is `undefined` (mixed registry) |
| SEL-N4 | `selectTweet`/`selectThread` immutability — input `Selection` unchanged |
| SEL-N5 | duplicate id **within one group** resolves once, indices stay contiguous |
| SEL-N6 | double toggle returns to empty; each call returns a fresh `Set` instance |
| SEL-N7 | two `emptySelection()` results don't share the underlying `Set` |
| SEL-N8 | `resolveSelection` preserves every other MediaItem field, rewrites only `index` |

### 2.7 `core/quickgrab` (QG)

| ID | Case |
|---|---|
| QG-N1 | `syncModifierFromFlags` returns the **same reference** when idle & not held, and when active & held (no spurious re-renders) |
| QG-N2 | `pressModifier` on already-active state returns the same reference |
| QG-N3 | `markGrabbed` on an already-grabbed key returns the same reference |
| QG-N4 | `canGrab`: false for a grabbed key while active, true for a sibling key |
| QG-N5 | `isModifierKey` rejects near-misses: `'AltGraph'`, `'a'`, `''`, `'ALT'` |
| QG-N6 | `releaseModifier()` returns the `idleQuickGrab` constant (identity) |
| QG-N7 | full lifecycle property: press → grab k1 → grab k2 → release → press: `canGrab(k1)` true again, grabbed set empty |

### 2.8 `core/download/metrics` (MET)

| ID | Case | Expectation |
|---|---|---|
| MET-N1 | `extendTotal` preserves `items`/`outcomes`/`timeline` references and `startedAt` | identity checks |
| MET-N2 | ETA boundary `bytesTotal === bytesReceived` | `etaSeconds` key absent |
| MET-N3 | bytes outstanding but bps 0 | `etaSeconds` absent |
| MET-N4 | timeline point exactly at `t === now - 5000` | chosen as ref (`<=` boundary) |
| MET-N5 | all items terminal | `active === 0` while `items` non-empty; bytes still summed |
| MET-N6 | outcome for an id with no sample (aria2 / start-failure path) | counted; `active` unaffected |
| MET-N7 | `'complete'` then `'failed'` for the same id | second ignored (cross-outcome idempotency) |
| MET-N8 | `samplesFromSearch`: empty rows / empty map; `t` propagated verbatim | `[]`; exact `t` |
| MET-N9 | `outcomeFromState(undefined)` | `null` |
| MET-N10 | 10 000 samples on one id | timeline length 10 000 — **unbounded growth pinned**; → BC-5 |
| MET-N11 | `snapshot` with `now < startedAt` (clock skew) | negative `elapsedMs` — pin; → BC-6 |
| MET-N12 | exactly 2 points inside the window | rate = Δagg / Δt |
| MET-N13 | `recordRetry` with an id never sampled | still increments (id unused) — pin |

### 2.9 `core/download/aria2` (AR)

| ID | Case |
|---|---|
| AR-N1 | `aria2OriginPattern`: https URL keeps `https:`; IP-literal host; URL without explicit port |
| AR-N2 | `buildJsonRpcBody` never mutates the caller's `params` array; secret with `:`/unicode concatenated verbatim as `token:<secret>` |
| AR-N3 | `makeAria2RpcPort`: `fetch` rejection propagates; non-JSON body (`res.json()` throws) rejects; `error` present **and** `result` present → error wins |
| AR-N4 | port + secret end-to-end: request body has `params[0] === 'token:s3cret'` before `[urls, options]` |
| AR-N5 | `makeAria2Strategy` passes `buildAria2Options` output to the port (spy on args; dir present and absent) |
| AR-N6 | strategy failure: `DownloadError` carries `req.id` and `String(cause)` for a non-Error cause |

### 2.10 `core/download/strategy` (ST)

| ID | Case |
|---|---|
| ST-N1 | routing is case-sensitive: `'DATA:application/json,…'` goes to **primary** — pin (our sidecars are always lowercase) |
| ST-N2 | error from the routed-to strategy surfaces unchanged through the router |
| ST-N3 | direct strategy: rejection with a string cause → `reason === String(cause)` |
| ST-N4 | `downloads.download` resolving `0` (falsy id) still yields `{kind:'browser', id:0}` |

### 2.11 `core/download/queue` (QU)

| ID | Case | Expectation |
|---|---|---|
| QU-N1 | empty request array | `{completed:0, failed:0, total:0, outcomes:[]}` |
| QU-N2 | persistent failure with default retries | `save` called exactly 4× (1 + 3 retries); outcome `ok:false`, no `handle` |
| QU-N3 | `retries: 0` | single attempt |
| QU-N4 | mixed success/failure | `outcomes` order matches `requests` order |
| QU-N5 | one failing request doesn't interrupt or fail siblings | isolation under concurrency |
| QU-N6 | `concurrency: 1` with deferred saves | strictly serial, start order = request order |
| QU-N7 | handles propagated per kind (browser `id`, aria2 `gid`) | exact handles in outcomes |
| QU-N8 | concurrency > requests.length | works, all complete |
| QU-N9 | transient failure then success | `save` called 2×, outcome `ok:true` |

### 2.12 `core/download/destination` (DST)

| ID | Case | Expectation |
|---|---|---|
| DST-N1 | `sidecarFilename` adversarial: `'v1.0/file'` → `'v1.0/file.json'` (dot in dir, none in base); `'a/.env'` → `'a/.json'` — pin the hidden-file oddity |
| DST-N2 | `buildSidecar`: `capturedAt` only; both ctx fields; ctx object with explicitly-`undefined` fields → keys absent |
| DST-N3 | `sidecarDataUrl` with emoji + quotes + newlines round-trips via `decodeURIComponent`+`JSON.parse`; prefix is exactly `data:application/json;charset=utf-8,`; payload pretty-printed (2-space) |
| DST-N4 | `planDownloads` with subfolder template: sidecar id `${item.id}.json`, sidecar filename is the sibling inside the same subfolder |
| DST-N5 | `ctx` flows through `planDownloads` into the sidecar payload |

### 2.13 `core/adapters/x` (XAD) + `core/adapters/x/dom` (DOM)

| ID | Case | Expectation |
|---|---|---|
| XAD-N1 | tweetId from `legacy.id_str` when `rest_id` absent; numeric `rest_id` stringified | exact ids |
| XAD-N2 | media-bearing node with neither id | skipped (empty-string guard) |
| XAD-N3 | duplicate tweet nodes (e.g. TweetDetail + quoted reference) | deduped by tweetId, first wins |
| XAD-N4 | no `screen_name` anywhere under the node | `handle === ''` |
| XAD-N5 | walk robustness: arrays of arrays, `null` nodes, primitives, `media` non-array, `legacy` non-object, 100-level nesting | no throw, correct extraction |
| XAD-N6 | payload with `__proto__`/`constructor.prototype` keys | extraction works AND `Object.prototype` is untouched afterwards (prototype-pollution guard) |
| XAD-N7 | `contextFromPath` table: 15-char handle ok, 16-char rejected, hyphenated handle rejected, `/photo/1`→index 0, `/photo/0`→clamped 0, `/i/status/123` (no `web/`) matches with empty handle |
| XAD-N8 | `resolveImageElement`: empty `currentSrc` falls back to `src` |
| XAD-N9 | index counting excludes photos belonging to a different tweet inside the same `article` (quote case) |
| XAD-N10 | `detectRenderedImageElements`: empty document → `[]`; two imgs with the same media key → one item |
| XAD-N11 | `detectFromDom`: img without `src` → item with `url:''`, `ext:'jpg'`, id `${tweetId}-${index}` — pin |
| XAD-N12 | lightbox path `/i/web/status/9/photo/2`, no article | `index:1`, `handle:''` |
| DOM-N1 | bare `twimg.com` host **rejected** by `mediaKeyFromUrl` (`endsWith('.twimg.com')` excludes the apex); `video.twimg.com` **accepted** for keying — pin the asymmetry vs `isGrabbablePhotoUrl` |
| DOM-N2 | trailing-slash path and `/` path | `null` (empty basename) |
| DOM-N3 | multi-dot basename `a.b.c` | key `'a.b'` |
| DOM-N4 | `/medias/x` and bare `/media` (no trailing slash) | rejected by `isGrabbablePhotoUrl` |
| DOM-N5 | `isGrabbableMediaPreviewUrl`: each thumb section (`tweet_video_thumb`, `ext_tw_video_thumb`, `amplify_video_thumb`) deep path accepted; `tweet_video` rejected |
| DOM-N6 | `extFromImgUrl`: `format=PNG` → `'png'`; `format=` (empty) falls through to path; unparseable → `'jpg'` |
| DOM-N7 | `groupByTweet`: same item id under two different tweetIds → second dropped entirely (id-level dedupe precedes grouping) — pin |

---

## 3. MAIN-world tee (`inject/tee.ts` + `inject.content.ts`) (TEE)

`tee.ts` additions:

| ID | Case | Expectation |
|---|---|---|
| TEE-N1 | `/i/api/graphql/x/TweetDetailFoo` | **accepted** (substring match has no trailing boundary) — pin; → BC-8 |
| TEE-N2 | `/i/api/graphql/x/XTweetDetail` | rejected (leading `/` required) |
| TEE-N3 | every one of the 12 MEDIA_OPS | accepted (table-driven, no op silently dropped by a future edit) |

`inject.content.ts` — invoke `def.main()` in happy-dom with stubbed
`XMLHttpRequest.prototype.open` / `window.fetch`; restore in `afterEach`:

| ID | Case | Expectation |
|---|---|---|
| TEE-N4 | XHR, matching URL, status 200 | one `xmd:media-response` CustomEvent with `{path: pathname, body: responseText}` |
| TEE-N5 | XHR, matching URL, status 404 | no event |
| TEE-N6 | XHR with a `URL` object argument | matched (String coercion) |
| TEE-N7 | XHR with invalid `responseURL` | `new URL` throws → caught, no event, no page break |
| TEE-N8 | XHR, non-matching URL | no listener attached, original `open` still called with all args (incl. async flag) |
| TEE-N9 | fetch, string input, `ok` response | event with pathname resolved against `location.origin` (relative URL case included) |
| TEE-N10 | fetch with `URL` object and with `Request` object inputs | both matched via `href`/`.url` |
| TEE-N11 | fetch `ok:false` | no event |
| TEE-N12 | `res.clone().text()` rejecting | swallowed, no unhandled rejection |
| TEE-N13 | page receives the **identical** Response object the original fetch produced | `===` on resolution |
| TEE-N14 | original fetch **rejecting** (network error) | rejection propagates unchanged; no event; no unhandled rejection |

---

## 4. Background service worker (`background.ts`) (BG) — the "backend actions", simulated

Harness: `vi.resetModules()` + dynamic import per test; capture the two listeners
off `fakeBrowser`; drive them directly (`onMessage` invoked with
`(message, sender, sendResponse)`; `onChanged` with a delta). `downloads.download`
and `downloads.search` are spies; settings pre-seeded via `fakeBrowser.storage.local`.

| ID | Case | Expectation |
|---|---|---|
| BG-N1 | undecodable message (`{_tag:'Nope'}`, `null`, `'hi'`) | listener returns `false`, `sendResponse` never called, no throw |
| BG-N2 | decodable-but-unhandled tags (`DetectRequest`, `MediaDetected`, `QueueUpdate`, `MetricsUpdate`) | returns `false` |
| BG-N3 | `DownloadRequest`, 1 item, defaults | `downloads.download` called once with template-rendered filename + `conflictAction:'uniquify'`; reply `{_tag:'QueueUpdate', completed:1, total:1}`; listener returned `true` |
| BG-N4 | `sidecarMetadata: true` | two downloads: media URL + `data:application/json…` sibling `.json` |
| BG-N5 | duplicate request while first still in flight | second reply `{completed:0, total:0}`, **no** second `downloads.download`; after `onChanged` complete for the first, the same item downloads again (lock released) |
| BG-N6 | 2 items, 1 already in flight | only the new one fires |
| BG-N7 | `downloadStrategy:'aria2'` | fetch hits `aria2RpcUrl` with JSON-RPC envelope (+`token:` when secret set); gid outcome treated as terminal `external-complete`, `inFlight` released immediately; a `data:` sidecar in the same batch goes to `downloads.download` (scheme routing) |
| BG-N8 | `downloadStrategy:'fetched'` | behaves exactly like direct — pin; → BC-9 |
| BG-N9 | `downloads.download` rejecting persistently | 4 attempts (queue retry), outcome failed, snapshot persisted with `failed:1`, lock released |
| BG-N10 | fresh batch seeds metrics | `session:metrics` snapshot persisted with `total = requests`, `concurrencyCap = downloadConcurrency` |
| BG-N11 | second batch while first **active** | `extendTotal` (totals add, cap = max), `requestIdByDownloadId` retained; second batch when first **settled** → fresh accumulator, map cleared, late `onChanged` for an old downloadId ignored |
| BG-N12 | `onChanged` in-progress delta for a known id | `downloads.search` polled, sample recorded, snapshot persisted, no outcome |
| BG-N13 | `onChanged` `state.current:'complete'` | completed++, lock + `requestStartedAt` cleaned |
| BG-N14 | `onChanged` `'interrupted'` | failed++ |
| BG-N15 | `onChanged` for unknown downloadId, or before any batch (`live === null`) | no `search` call, no persistence |
| BG-N16 | `downloads.search` throwing | swallowed; the terminal outcome is still processed |
| BG-N17 | `MetricsRequest`: persisted snapshot returned verbatim; nothing persisted → ZERO snapshot (with trace events when present) | both branches |
| BG-N18 | 15 `DownloadTraceEvent`s | ring buffer holds the **last 12**; optional fields included only when present; each reply `{ok:true}` |
| BG-N19 | `ClearDownloadMonitorRequest` while `active > 0` | `{ok:false, reason:'active-downloads'}`, nothing cleared |
| BG-N20 | `ClearDownloadMonitorRequest` when idle with stale locks | clears `live`/locks/maps/trace, `session:metrics` set `null`, `clearedLocks` = stale count; the request's `clearStaleLocks` field is **ignored** — pin; → BC-10 |
| BG-N21 | trace label assembly (console spy) | `elapsedMs:0` renders `'0ms'` (string is truthy); absent fields omitted from the label |
| BG-N22 | `downloadConcurrency:1` with deferred download resolutions | strictly serial end-to-end |
| BG-N23 | all items fail to start | reply `{completed:0, total:n}`; metrics show `failed:n, active:0` |

---

## 5. Frontend

### 5.1 Overlay content script (`overlay.content/index.tsx`) (OV)

Harness: `def.main(fakeCtx)` with mocked `createShadowRootUi` (calls `onMount`
synchronously with a host div); `document.elementsFromPoint` stubbed; fake timers
for the 500 ms dwell; `fakeBrowser.runtime.sendMessage` spied for replies.

| ID | Case | Expectation |
|---|---|---|
| OV-N1 | `mediaAtPoint` occlusion table (after the §1 extraction): no media → null; topmost img returned; `XMD-OVERLAY` above → null; transparent ancestor **containing** the media → passes; `[aria-modal]`/`[role=dialog]` not containing media → null, containing → passes; bg alpha `0.5` → blocked, `0.49` → passes, `transparent` → passes, keyword (`red`) → blocked; `<video>` recognized | exhaustive branch coverage of `bgAlpha` + loop |
| OV-N2 | **fail-closed**: mousemove with modifier held *before* settings resolve | nothing arms (`qgEnabled` starts false) |
| OV-N3 | happy path: settings on → alt-hover media → `charging` ring with media rect → advance 500 ms → `DownloadRequest` sent with the byKey item → reply `{completed:1,total:1}` → phase `saved` | full lifecycle with fake timers |
| OV-N4 | reply mismatch (`completed:0,total:1`) and `sendMessage` rejection | phase `failed`; rejection swallowed |
| OV-N5 | pointer leaves media at 400 ms | dwell cancelled, nothing sent |
| OV-N6 | dwell-expiry guards: media detached; `src` swapped (key mismatch); `elementsFromPoint` no longer contains media (scrolled away) | each → grabUi cleared, nothing sent |
| OV-N7 | hover key not in `byKey`, not DOM-resolvable (video poster without tee data) | `no-item-for-hover` trace sent, no DownloadRequest |
| OV-N8 | second hover of the same key during one press | `noted` badge, no send; after keyup→keydown, grabbable again |
| OV-N9 | keydown auto-repeat while held | grabbed set not reset, no re-arm |
| OV-N10 | keydown with no prior mousemove (`pointerSeen` false) | no phantom arm at (0,0) |
| OV-N11 | release matrix: keyup of the configured modifier / window `blur` / document `mouseleave` | ring removed + cursor style removed / released / hover cleared; keyup of an unrelated key ignored |
| OV-N12 | modifier-flag sync: mousemove with `altKey:true` arms without any keydown; next mousemove without the flag releases (self-healing swallowed keyup) | both directions |
| OV-N13 | settings change mid-press (modifier alt→shift) | disarmed immediately; shift now arms, alt doesn't |
| OV-N14 | `quickGrabEnabled:false` via `watchSettings` | hover and keydown fully inert |
| OV-N15 | cursor `<style>`: appended once on activation (selector covers media + 3 thumb hosts + 3 poster hosts), removed on release, never duplicated across repeated activations | DOM assertions |
| OV-N16 | `xmd:media-response` with the TweetDetail fixture | items in `byId`; video items reachable via **both** url-key and previewUrl-key in `byKey`; invalid JSON body swallowed |
| OV-N17 | same detection delivered twice | `added === 0`, no extra render |
| OV-N18 | launcher: absent when `byId` empty; shows count; click sends one `DownloadRequest` with all items; `send([])` no-ops | component behavior through the host |
| OV-N19 | rendered-media scan: `queueRenderedMediaScan` coalesces (two calls → one rAF → one scan); scroll triggers it | `ctx.requestAnimationFrame` spy |
| OV-N20 | scroll with same media+key but shifted rect | rect refreshed, dwell **not** reset; different media under pointer → re-arm; grab inactive → rescan only |
| OV-N21 | `wxt:locationchange` | releaseAll + hover cleared + rescan queued |
| OV-N22 | `ClearDetectedMediaRequest`: clears maps/dwell/cursor/grab, replies `{cleared, rescanned}`; `rescanVisible:true` repopulates from DOM and counts; unrelated message → handler returns without responding |
| OV-N23 | `ctx.onInvalidated` | dwell cleared, cursor removed, runtime listener removed (a later message is not handled) |
| OV-N24 | video hover: preview key from `poster`, falling back to `currentSrc`/`src` when no poster | both branches of `previewSrcFromMedia` |
| OV-N25 | background dedup reply `{completed:0, total:0}` to a quick grab | treated as success → `saved` badge — pin; → BC-11 |

### 5.2 Popup (`popup/App.tsx`, `popup/main.tsx`) (POP)

Harness: `@testing-library/preact`, `fakeBrowser` (spies for `tabs.query`,
`tabs.sendMessage`, `permissions.contains/request`, `runtime.sendMessage`),
fake timers for the 1 s poll and 1200/1500 ms feedback.

| ID | Case | Expectation |
|---|---|---|
| POP-N1 | before settings resolve | `Loading...` shell |
| POP-N2 | defaults render: template input value, concurrency 3, `direct` radio checked, quick-grab checked + modifier select visible, no aria2 fields | snapshot of control state |
| POP-N3 | tab detection: `x.com` and `twitter.com` URLs → "Ready on this X tab" + button enabled; other URL → disabled; `tabs.query` rejecting → caught, disabled; zero tabs → `activeTabId` undefined, disabled | 4 branches |
| POP-N4 | edit template → `setSettings` persisted (assert via storage), "Saved" pill shows, reverts after 1200 ms | fake timers |
| POP-N5 | concurrency input harsh values: `'0'` → **1** (`Number(v)||1`, zero is falsy); `''` → 1; `'abc'` → 1; `'-2'` → **−2 persisted** | pin; → BC-1 |
| POP-N6 | switch to aria2: RPC/secret/dir fields + split input appear; `permissions.contains` queried with `aria2OriginPattern(rpcUrl)`; `false` → "Grant localhost access" button → click → `permissions.request`; `true` → success line | full grant flow |
| POP-N7 | unparseable RPC URL | no permission query, no grant button (`aria2Granted` null) |
| POP-N8 | quick-grab unchecked hides the modifier select; selecting `meta` persists |
| POP-N9 | metrics poll: `MetricsRequest` sent at mount and every 1000 ms; unmount clears the interval; monitor hidden when `total:0` & no events; "Waiting for download" when events exist but `total:0`; pct clamped to 100 when `done > total`; ETA `-` vs `ceil`; Failed/Retries rows only when > 0; bytes "received / total" vs received-only | the whole monitor matrix |
| POP-N10 | formatter tables (after §1 export): `fmtRate(0/-1)`→`-`, `999_999`→`'1000 KB/s'` (pin), `1_000_000`→`'1.0 MB/s'`; `fmtBytes` 0/999/1000/1_000_000; `fmtDuration` 999→`999ms`, 1000→`1.0s`, 9999→`10.0s` (pin), 10_000→`10s`, 59_999→`60s` (pin), 60_000→`1m 0s`, **119_500→`1m 60s`** — pin; → BC-12; `fmtStage('browser-complete')`→`'Browser Complete'`, `''`→`''`; `traceDetail` with no parts → `event.source`, with parts → `' · '` join |
| POP-N11 | "Find new media": sends `ClearDetectedMediaRequest{rescanVisible:true}` to the active tab id; feedback "Media refreshed" for 1500 ms; `tabs.sendMessage` rejection swallowed (no feedback, no crash) |
| POP-N12 | "Clear monitor": rendered only with a monitor; disabled + title while `active>0`; `{ok:true}` → metrics cleared + feedback; `{ok:false}` → unchanged; rejection → null-safe |
| POP-N13 | event log renders newest-first (`toReversed`), one `<li>` per event, stage formatted; absent when no events |
| POP-N14 | `main.tsx`: with `#app` present → fallback children replaced, App rendered; without `#app` → no throw (both branches via `vi.resetModules` + DOM setup) |

---

## 6. Contract suite (CT) — simulated cross-layer actions

These are the "simulate the action and check it" tests: every message that crosses
a process boundary is produced by the real sender code and consumed by the real
receiver code over the fake browser, so the two sides can never drift apart silently.

| ID | Case |
|---|---|
| CT-1 | every payload the overlay sends (`DownloadRequest`, `DownloadTraceEvent`) decodes against the `Message` schema the background uses — table generated from the senders |
| CT-2 | **full pipeline**: tee fixture JSON → `detectFromJson` → overlay `send()` → background `onMessage` → `downloads.download` spy → synthetic `onChanged` complete → `MetricsRequest` → snapshot shows `1/1` → popup renders `100%` |
| CT-3 | quick-grab trace events emitted by the overlay arrive in the background ring buffer and come back in `MetricsRequest.events` |
| CT-4 | popup's `ClearDetectedMediaRequest` → overlay handler → response decodes as `ClearDetectedMediaResponse` with correct counts |
| CT-5 | popup `setSettings` → storage watch → overlay `applySettings` (live re-configuration round trip, incl. the disarm side-effect) |
| CT-6 | aria2 end-to-end against a simulated daemon: a `fetch` stub validating method/envelope/secret and returning gid / JSON-RPC error / malformed body — background reports completed / failed accordingly |

---

## 7. Bug candidates surfaced by this design (pin first, then fix deliberately)

| ID | Where | Issue | Pinning test |
|---|---|---|---|
| BC-1 | `Settings` schema + popup | numeric settings unbounded: negative/`NaN`/fractional concurrency & split pass schema; popup's `Number(v)||1` turns `0` into 1 but lets `-2` through | SCH-N4, POP-N5 |
| BC-2 | `SettingsService.set` | an invalid patch makes `decode` fall back to **defaults**, silently wiping every user customization (instead of rejecting the patch) | SET-N3 |
| BC-3 | `renderFilename` | non-word tokens keep literal `{}` in filenames | FN-N2 |
| BC-4 | `renderFilename` | trailing dots/spaces and Windows reserved names (`CON`, `NUL`) not sanitized | FN-N13 |
| BC-5 | `metrics` | timeline grows unboundedly per sample (long batches = memory growth, O(n) ref scan per snapshot) | MET-N10 |
| BC-6 | `metrics.snapshot` | clock skew yields negative `elapsedMs` | MET-N11 |
| BC-8 | `isGraphqlMediaUrl` | op match has no trailing boundary (`TweetDetailFoo` accepted) | TEE-N1 |
| BC-9 | `chooseStrategy` | `'fetched'` silently behaves as `direct` while the popup advertises it as "Verify files" | BG-N8 |
| BC-10 | background | `ClearDownloadMonitorRequest.clearStaleLocks` is defined in the schema but ignored by the handler | BG-N20 |
| BC-11 | overlay `sendTracked` | a dedup reply (`0/0`) renders the `saved` badge; `noted` would be honest | OV-N25 |
| BC-12 | popup `fmtDuration` | seconds rounding produces `1m 60s` at ≥ 59.5 s remainders | POP-N10 |

## 8. Coverage matrix and exit criteria

| File | Existing tests | New cases | Notes |
|---|---|---|---|
| core/schema | 8 | 11 | |
| core/settings | 5 | 9 | storage logic |
| core/errors | 0 | 2 | currently 0% |
| core/quickgrab | 12 | 7 | |
| core/selection | 12 | 8 | |
| core/resolver | 11 | 9 | |
| core/download/filename | 3 | 14 | security-sensitive |
| core/download/strategy | 3 | 4 | |
| core/download/queue | 4 | 9 | |
| core/download/aria2 | 10 | 6 | |
| core/download/destination | 8 | 5 | |
| core/download/metrics | 19 | 13 | |
| core/adapters/x | 16 | 12 | |
| core/adapters/x/dom | 12 | 7 | |
| entrypoints/inject/tee.ts | 3 | 3 | |
| entrypoints/inject.content.ts | 0 | 11 | currently 0% |
| entrypoints/background.ts | 0 | 23 | currently 0% — the backend |
| entrypoints/overlay.content | 0 | 25 | currently 0% — needs §1 refactor |
| entrypoints/popup/App.tsx | 0 (3 CSS) | 14 | needs §1 export refactor |
| entrypoints/popup/main.tsx | 0 | 1 | |
| contract suite | 0 | 6 | new `src/test/contract/` |
| **Total** | **~126** | **~199** | |

**Exit criteria**

1. `vitest run --coverage` passes with the 100/100/100/100 thresholds already set
   in `vitest.config.ts` (provider `v8`, `@vitest/coverage-v8` installed).
2. No `istanbul ignore` / `v8 ignore` comments — unreachable code is removed, not
   excluded; files excluded from coverage need a justification in this doc.
3. Every BC-* row has either a fix commit or an explicitly accepted pin.
4. Suite stays fast (< 30 s): no real network, no real timers, no sleeps.

**Suggested implementation order** (each phase independently shippable):
1. Pure-core gap fill (§2) — no refactors needed.
2. Tee + background (§3, §4) — fake-browser harness.
3. Testability refactors (§1) + overlay/popup suites (§5).
4. Contract suite (§6), then turn on `--coverage` in CI's `check` script.
