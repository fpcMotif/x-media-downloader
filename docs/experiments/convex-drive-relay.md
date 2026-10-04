# Convex-to-Drive experiment evidence

## At a glance

Browser cloud uploads consume local bandwidth and stop when the browser closes.
The implemented default-off experiment submits metadata and runs bounded Drive transfers through the user's Convex deployment.
Live feasibility remains unverified because the identified deployment lacks the required Drive configuration.

## Live boundary

The inspected target is `dev:content-mongoose-243`, at `https://content-mongoose-243.convex.cloud`.
Inspection was read-only and emitted variable names and presence only.
`SYNC_SHARED_SECRET` is present.
`RELAY_ENABLED`, `RELAY_DRIVE_CLIENT_ID`, `RELAY_DRIVE_CLIENT_SECRET`, `RELAY_DRIVE_REFRESH_TOKEN`, and `RELAY_DRIVE_FOLDER_ID` are missing.
Optional byte, lifetime, and retry variables are also absent.

No backend deployment, Drive mutation, credential copy, or provider upload occurred during this implementation run.
The proposed isolated destination is `XMD issue-96 relay experiment`.
Deployment approval and explicit provisioning are prerequisites for the live experiment.

| Required observation | Result |
| --- | --- |
| Small image transferred into Drive | Not run: deployment credentials missing |
| Increasing video sizes | Not run |
| 512 MiB source, if cap permits | Not run; default cap permits exactly 512 MiB |
| Drive file ID and byte-length comparison | Not run |
| Source-versus-Drive content integrity | Not run |
| Browser closed after durable acceptance | Not run |
| History after reopening | Tested with substituted HTTP only; not observed live |
| Source-host server access | Not measured |
| Transfer elapsed time | Not measured |
| Actual bytes relayed | Not measured |
| Actual retries | Not measured |
| Convex usage and billing | Not measured |
| Peak Node memory | Not measured live |

## Local evidence

Convex tests exercise authenticated submission through persisted public status and substituted Drive HTTP responses.
They verify stable identity after an ambiguous final response and recovery from a partially received 8 MiB chunk.
The recovered bytes match the fixture; no second Drive file identity is allocated.

Other tests cover duplicate and conflicting submissions, missing configuration, global fencing, lease expiry, and retry exhaustion.
They cover provider pause, master disable, disconnect, oversized headers, oversized streams, expired sources, and unsafe redirects.
A regression test refuses partial recovery of a small source when its original strong validator is absent.
Extension tests cover metadata-only queue submission, absent disk requests, browser-upload exclusion, retained ownership, and offline history reconciliation.
Recovery regressions cover deployment disable, disconnect during completion, and confirmed submission rejection, including Convex HTTP 560 errors.
They also cover origin-bound status credentials, offline ordinary-download budgets, mandatory remote size admission, and reservation-bounded transfers.
Ambiguous submissions remain reserved; later authentication failure does not release their ownership.

Validation results for this implementation:

- Extension suite: 147 files and 2,383 tests passed.
- Backend suite: five files and 75 tests passed, including 19 relay tests.
- Backend TypeScript check passed.
- Production extension build passed; output size was 841.97 kB.
- Package boundaries passed across 345 modules and 1,171 dependencies.
- Environment reference audit and sensitive-value scan passed.
- `bun run check` passed formatting, lint, environment audit, and WXT preparation, then failed at TypeScript.
- Its 250 TypeScript diagnostics exactly match baseline `00616277` after normalizing source positions.

The existing `/virtual:stylex.css` build warning remains.
Browser visual inspection was not performed during this implementation run.

These are controlled tests, not live provider measurements.
Passing tests cannot establish Convex outbound-streaming behavior, Google authorization, real source access, or billing suitability.

## Measurement procedure after provisioning

1. Obtain approval for the exact development deployment, schema/function diff, isolated Drive folder, and approved source URLs.
2. Start with one small image from an allowed public media host and record its byte length and SHA-256.
3. Submit through the extension and record durable acceptance before closing the browser.
4. Observe authenticated server status independently until terminal completion or explicit failure.
5. Retrieve the resulting Drive file using its returned ID, not an action's success response alone.
6. Compare Drive byte length and downloaded SHA-256 against the source.
7. Reopen the browser and verify Download History and Saved state reconcile without disk or browser transfer.
8. Repeat with progressively larger approved videos; include 512 MiB only when both source and configured cap permit it.
9. Record source host, elapsed time, chunk count, failures, confirmed offsets, peak RSS, and observed deployment usage.
10. Stop on unexplained duplication, integrity mismatch, unsafe source behavior, or approaching account quotas.

Use only approved source URLs; do not widen the source allowlist to make a fixture convenient.
Do not record private session URLs, OAuth values, shared secrets, or credential-bearing command output.

## Limits and interpretation

The chunk target is 8 MiB, with one globally leased worker.
Each action has a 120-second local deadline, below the documented ten-minute Convex action limit.
The eleven-minute fencing lease prevents replacement execution before that platform deadline expires.
The default 512 MiB byte cap, one-hour job lifetime, and three-failure limit are configuration, not proven throughput limits.
Remote admission requires a positive backend HEAD size; unavailable sizes fail before acceptance.
The accepted size caps the job's source bytes, preventing an underestimated source from exceeding its daily reservation.
Retransmission bandwidth remains separate from accepted-byte accounting.
Ordinary downloads use local receipt accounting without depending on a reachable deployment.
Retained shared sync secrets remain sensitive local storage and require the same protection as existing sync settings.

Public status records source bytes read, acknowledged upload-call bytes, failure count, accepted time, update time, and sampled peak RSS.
Transport failures can make acknowledged-call counters undercount actual transmitted bytes.
A peak RSS sample is not a continuous peak-memory trace.
Dashboard invocation and bandwidth measurements must therefore accompany application counters.

A 512 MiB file needs at least 64 chunks: this is an estimate, excluding partial retries and metadata requests.
Each chunk incurs an action, authorization checks, and transactional checkpoints.
Do not infer actual billing from file size alone.

Current platform references were fetched during implementation:

- [Convex actions](https://docs.convex.dev/functions/actions): external fetch support and action timeout.
- [Convex limits](https://docs.convex.dev/production/state/limits): runtime and usage limits depend on the deployment plan.
- [Drive uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads): resumable sessions and confirmed Range semantics.

Drive documents 256 KiB chunk multiples, expiring resumable sessions, and pre-generated IDs for idempotent creation.
HTTP action response limits alone do not establish Node outbound-transfer feasibility.
Full-file memory estimates likewise do not prove streaming video impossible.

## Recommendation

Keep the feature default-off and label it experimental.
Do not claim live success, arbitrary video support, or a cost advantage until the measurement procedure completes.
Reassess the per-chunk scheduling and checkpoint cost using actual deployment usage before broadening the experiment.
