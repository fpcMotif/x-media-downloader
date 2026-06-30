# ADR-0017 — The cloud byte path as Effect services on a shared runtime

- **Status:** Accepted (2026-06-30)
- **Builds on:** [ADR-0004](0004-effect-v4-beta-core.md) (Effect v4 core), [ADR-0013](0013-client-side-cloud-byte-upload.md) (client-side cloud byte upload).

## Context

The cloud byte path (`src/core/cloud/`) threaded its dependencies by hand: a `DriveDeps` bag (`{ accessToken, rootFolderId, fetchImpl, fetchSource, folderCache: Map }`) passed through `makeDriveDestination` per upload, with the orchestrator owning the `Map` cache and the SSRF-guarded source fetch. Two asks drove a rewrite:

- **(a)** move the injected `fetch` from a plain parameter to a Layer-provided **`FetchService`**, so the dependency is tracked in the Effect `R` channel and swapped by a Layer in tests;
- **(d)** decompose `DriveDeps` into composed Layers, modelling the across-SW-life folder cache as a `Ref`.

The orchestrator around this (the `UploadJob` ledger, the serialized queues, the backoff alarms) is Promise-based and stays that way — only the byte adapters move into Effect.

## Decision

**Model the cloud byte path as three services plus a per-provider uploader, run on one `ManagedRuntime` built once per SW life. The orchestrator keeps a `Promise<UploadOutcome>` boundary.**

### Services (`src/core/cloud/`)

- **`FetchService`** (`src/core/fetch-service.ts`, shared across every port) — `{ fetch: (url, init?) => Effect<Response, FetchError>; fetchPromise: typeof fetch }`. `fetch` is used inside Effect; `fetchPromise` is the same `globalThis`-bound fetch handed to `streamInChunks`' sink, so the streamed path reuses the chunker verbatim (no Effect/Promise bridge). Bound once at layer build (`bindFetch`), preserving the MV3 brand-check (guarded by `fetch-service.test.ts`). `FetchError` is tagged — a rejected fetch is a value, never a defect.
- **`SourceFetch`** — `{ fetch: (url) => Effect<Response, FetchError> }`, a one-line wrap of the existing `guardedFetch` (the twimg allow-list + per-hop redirect revalidation, reused as-is).
- **`FolderCache`** — `{ get, set }` over a private `Ref<Record<string,string>>` (`Layer.effect`, the `Ref` created once → lives for the runtime's life).

### Uploaders

`runUpload` (`http.ts`) is the Effect template: it owns the parsed-source early return, the simple-vs-streamed size dispatch, the empty-source guards, and the failure→`UploadOutcome` mapping (`catchTag('CloudHttpError')` carries the numeric status; `catchCause` maps the rest by message). `DriveUploader`/`DropboxUploader` are `Context.Service`s whose layers depend on the services above and expose `upload(args, input): Effect<UploadOutcome>` (`E = never`, `R = never` — services resolved once when the layer builds). `accessToken`/`rootFolderId` are per-upload **arguments**, not Layer-ified.

### Runtime (the one Promise boundary)

`makeCloudUpload` builds `ManagedRuntime.make(mergeAll(DriveUploaderLive, DropboxUploaderLive).pipe(Layer.provide(makeCloudServicesLive(fetchImpl))))` once. Each upload runs `runtime.runPromise(...)`, which never rejects (`E = never`). The folder cache `Ref` persists across uploads for the SW life; an SW recycle rebuilds the runtime → a fresh cache, exactly as the old `Map` did. The **Cloud Provider** record (`provider.ts`) keeps provider identity (oauth/fields/revoke/host patterns); the orchestrator dispatches Drive-vs-Dropbox once, resolving + persisting the Drive root folder before the first upload.

## Consequences

- Real (a)+(d): `fetch` is `R`-tracked and Layer-swappable; the folder cache is a lifetime-correct `Ref`; failures are typed (`CloudHttpError` carries `status`).
- The byte adapters are net **shorter** and the streaming/SSRF/never-throw invariants are preserved (`streamInChunks` and `guardedFetch` reused verbatim; `runPromise` never rejects).
- Tests provide stub `FetchService`/`SourceFetch` layers and a real `FolderCacheLive` on a per-test runtime — the same wiring the SW uses.
- **Every fetch port adopts `FetchService`.** Beyond the byte path, the **aria2** RPC port, the **Convex** HTTP port, and the **OAuth** token endpoints all read `FetchService` from `R` (no `fetchImpl` thread) and surface their existing tagged errors (`Aria2RpcError`, `Convex*Error`, `OAuthError`) in the Effect channel. Each is run at its caller's natural seam: aria2 inside the already-Effect download `save` (`FetchService` provided at `chooseStrategy`); Convex/OAuth on the cloud runtime (`mirrorUploadJob`/`ensureAccessToken`/`runOAuthConnect`) or a layer at the sync outbox. The win there is `R`-tracking + Layer-swapped tests + linear port bodies; the durable orchestration (the serial queues, the `drainOutbox`/`drainUploadJobs` loops, alarms) stays Promise and crosses to Effect only at a `runPromise` airlock, where a tagged error reverts to a rejection the existing `try/catch` already handles.

## Alternatives considered

- **Effect-ify `runUpload`/streaming fully (a pure chunk loop).** Rejected: it duplicates the already-clean `streamInChunks` for no functional gain. Keeping the chunker Promise and feeding it `fetchPromise` is simpler and reuses tested code.
- **`DriveUploader` resolving services per upload / a runtime per upload.** Rejected: the folder cache `Ref` must persist across uploads, so the runtime is built once at the SW-life composition root.
- **Effect-ify the durable orchestration too** (`drainOutbox`/`drainUploadJobs`/serial queues/alarms). Rejected: those are storage-RMW loops with backoff and fencing-token leases — Effect-ifying them buys nothing the `runPromise` airlock doesn't, at real regression risk. Effect lives at the port layer; Promise stays at the orchestration layer.
