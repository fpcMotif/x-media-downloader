# Transfer recovery

## Purpose

A blocked durable transfer owns its media id. Recovery makes that block visible
and lets a person dismiss it. It never guesses whether a start ran.

## Surface

Options exposes `TransferRecoveryRequest` with two exact actions: `inspect` and
`forget`. It lists only id, kind, mode, time, and an already-known Chrome id.
It never exposes URLs, filenames, GIDs, RPC profiles, or secrets. Content
scripts cannot send this UI-only message.

There is no retry action. After `forget`, the person starts a fresh normal Save
from the post. That fresh request has a new projection id.

Prepared recovery says that no download call ran. It also says that queued
cloud upload stays queued. For unresolved rows, the typed `FORGET` confirmation
says that the old transfer may still run or have written files. Forgetting
never cancels aria2, deletes files, or clears a post.

## State

Non-Sweep `direct-prepared`, `fetched-prepared`, and `aria2-prepared` rows may
also be forgotten. They are shown only after a new Registry owner loads them
from storage. A live coordinator's prepared rows stay hidden and cannot be
forgotten. Sweep prepared rows stay hidden; receipt-led boot repair owns them.

Active, ready, retry, launch, armed, and terminal rows remain owned by the
Registry. Each grouped artifact has its own recovery row. Every stalled
artifact must be forgotten before that grouped save unlocks.

Forget first persists `forget-pending` with the exact recovery phase. It then
asks Clear to mark a linked member failed. Only that exact completion deletes
the Registry row. A failed Clear write leaves the duplicate lock and command
intact; the durable wake retries it. This is an explicit eligibility opt-out,
not terminal download evidence.

An aria2 prepared or unresolved claim retains its profile and GID while forget
is pending. New admission cannot reuse that endpoint/GID pair. Completion
prunes the profile only when no remaining row references it.

Cloud upload intent is a separate durable owner. Forget never removes or
changes it.

## Fetched leases

Forget never revokes a Fetched Blob lease. A forgotten active or ready lease
remains durable until exact Chrome terminal evidence releases it. An unowned
terminal `downloads.onChanged` releases only its matching Fetched lease; it
does not project history, sync, budget, saved state, or Clear.

At boot, an orphan `staging` lease is safe to discard because staging precedes
Chrome handoff. An orphan ready/active lease is released only after one exact
terminal Chrome match. Live, no-match, multi-match, missing-id, and search-error
leases remain retained. Safety beats lease availability.
