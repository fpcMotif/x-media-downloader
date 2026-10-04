# ADR-0013 — Browser cloud uploads by default; opt-in Convex Drive execution

Browser uploads remain the default for Google Drive and Dropbox.
Cloud-only users may explicitly select an experimental Google Drive relay through their own Convex deployment.
The relay is implemented, but real provider transfers and resource costs remain unverified.

## Browser execution

Cloud upload is default-off and independent of Direct, Fetched, and aria2 disk strategies.
With `saveToDisk: true`, browser cloud uploads run alongside the local save.
With `saveToDisk: false`, there is no disk Save Request, sidecar, or Clear-on-complete.
Admission and filename planning still apply.

The durable browser UploadJob ledger owns retries and outcomes for browser-executed jobs.
Its optional Convex mirror is best-effort metadata only.
Pausing a provider prevents new jobs; accepted jobs remain owned by their original executor.
Cloud-only Download History remains queued until provider completion, and a successful retry can repair failed history.

Browser OAuth uses PKCE through `chrome.identity.launchWebAuthFlow` in the background worker.
Google's Web application client also requires a client secret for exchange and refresh.
That user-supplied secret resides in extension storage and is sent to Google's token endpoint.
Dropbox does not require a client secret for this flow.
The extension bundle contains no provisioned private credentials.

Google Drive currently uses the full Drive scope; Dropbox uses app-folder access.
Files follow the planned filename's directory structure, not an inferred author folder.
Public distribution still requires evaluating provider verification and token-storage risks.
The experimental relay is not a public multi-user OAuth service.

## Experimental server execution

`convexDriveEnabled` defaults to false.
The extension requires Cloud-only saving, deployment setup, backend authorization, Drive Upload enabled, and no active Dropbox destination.
An unavailable experimental path fails visibly; it never silently falls back to browser upload or disk saving.
Local+cloud and ordinary Dropbox behavior remain unchanged.

The browser submits only Media Item identity, source URL, planned path, content type, and originating device.
Size admission uses an authenticated backend HEAD probe rather than a browser source request.
The server accepts jobs idempotently by device and Media Item, rejecting conflicting source or target metadata.
Remote daily usage is charged atomically with new durable acceptance, keyed by originating device and local calendar day.
Remote admission combines that server tally with ordinary local usage, even after a lost acceptance response.
Ordinary downloads use retained local receipt accounting instead of querying Convex.
Every remote candidate requires a positive backend HEAD size, even when the user disables size filters.
Unknown sizes fail before submission; accepted byte charges also cap the job's maximum source size.
Changed or underestimated sources cannot upload beyond that reservation.
Retries and duplicate acceptance do not increment the tally; transfer telemetry separately records observed bytes.

Server UploadJobs live separately from the browser mirror.
Only authenticated submission authorizes execution; mirror updates cannot do so.
An extension receipt preserves execution ownership and the original deployment across settings changes and restarts.
It retains the original shared sync secret in local extension storage, never provider OAuth credentials.
Status and remote budget queries use each receipt's deployment and authentication, not the currently selected deployment.
Confirmed submission rejection releases the receipt; ambiguous acceptance remains fenced until retry or status confirms server ownership.
This conservative reservation prevents a lost acceptance response from creating a second browser transfer.
Accepted server jobs never enter the browser uploader or disk queue.
Download History reconciles queued, failed, retry, and completed states, including completion while the browser was closed.
Saved requires confirmed Drive completion, not durable queue acceptance.

Deployment-only OAuth credentials and the destination root are provisioned explicitly.
The worker never receives browser cookies or copies extension OAuth secrets.
Its source hosts and redirect policy are shared with the extension's public-media policy.
Private Drive session URLs, source validators, offsets, and leases stay in internal server state.
Authenticated public status excludes sessions and credentials.

## Transfer constraints

One global fenced lease permits one transfer worker at a time.
Each Node action processes at most one 8 MiB chunk with a 120-second local deadline.
The eleven-minute lease exceeds Convex's documented ten-minute action deadline.
A scheduled watchdog recovers an abandoned lease; every checkpoint checks the fencing token.

Drive file and folder identities are allocated and persisted before creation.
The worker reconciles the stable file identity before retrying ambiguous creation or completion.
It probes the private resumable session before continuation and trusts only Drive-confirmed offsets.
Large sources require valid HTTP Range responses, a consistent total, and a matching strong ETag.
Every partial continuation also verifies the original resolved URL and strong validator, including small sources.
Small non-ranged sources can finish within one chunk; unsafe larger continuations fail explicitly.
Streaming reads enforce byte limits even without a trustworthy Content-Length.

Default limits are 512 MiB per source, one hour of total job lifetime, and three failures.
Job lifetime is not an action timeout.
Provider pause closes admission but drains accepted jobs.
Master disable suspends requests at a safe boundary; disconnect invalidates accepted authorization permanently.
Turning off the experiment alone retains accepted status and does not change job ownership.

## Trade-offs and evidence

Full buffering would exceed memory for some videos, but bounded streaming does not require full buffering.
Memory limits alone therefore do not establish whether Convex can relay a particular video.
Per-chunk actions and checkpoints add invocation and database costs, which require actual usage measurements.
No arbitrary file-size, duration, source-access, or cost guarantee is made.

Convex tests substitute HTTP responses at the external boundary and verify persisted outcomes and Drive identity reconciliation.
They do not replace the required small-image, increasing-video, integrity, browser-closed, and reopen experiments.
See [cloud setup](../cloud-upload-setup.md) and [measured experiment status](../experiments/convex-drive-relay.md).
