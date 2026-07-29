# Settings Writer design

**Date:** 2026-07-18

**Status:** Implemented; persistence amended 2026-07-28 by ADR-0005

## Problem

Before this change, ADR-0005 required one background Settings writer, but the
code had several:

- Popup and Options call the storage read/merge/write directly.
- Background boot seeding calls it directly.
- Cloud Upload serializes only its own writes.

Two contexts could read the same Settings snapshot, merge different patches,
then write in the opposite order. The last write lost the other patch.

## Chosen module

One background-owned Settings Writer is the only mutation seam.

```ts
interface SettingsWriter {
  update(patch: Readonly<Partial<Settings>>): Promise<Settings>
  updateWhen(
    guard: (current: Readonly<Settings>) => boolean,
    patch: Readonly<Partial<Settings>>,
  ): Promise<{ readonly applied: boolean; readonly settings: Settings }>
}
```

`update` is the common interface. `updateWhen` is background-only. It prevents a
slow Cloud refresh, folder lookup, OAuth flow, or revoke from restoring or
clearing a newer provider connection.

## Invariants

1. Only the background constructs the Settings Writer.
2. Every write enters its one FIFO queue.
3. Each queued change reads the latest durable Settings.
4. Merge, normalization, and validation happen before write.
5. Success returns the exact committed Settings.
6. Failure never reports success and never poisons later writes.
7. Content scripts can read/watch Settings but cannot send a patch.
8. A false `updateWhen` guard performs no write.
9. Same-field writes use arrival order. The storage revision belongs to durable
   migration and recovery. Normal UI writes do not expose conflicts.
10. Each provider lifecycle has a generation. Only the newest connect or
    disconnect may persist or start later byte egress.
11. UI patches cannot carry provider tokens, expiry, account, folder, persisted
    client ID, or the Cloud Sync device ID. The worker owns those fields.

## Seams and adapters

- Settings storage is local-substitutable: WXT storage in production; an
  in-memory record in writer tests.
- Runtime messaging is remote-but-owned: the UI adapter sends a typed patch;
  client tests inject a fake sender.
- WXT storage watches remain the observation seam. A watch is notification, not
  commit acknowledgement.

## Wire contract

`SettingsUpdateRequest` carries a string-keyed unknown record. The background:

1. rejects unknown keys;
2. accepts only UI-owned fields and validates their supplied values;
3. gives the typed patch to the writer;
4. creates a device ID when UI enables Sync and no ID exists;
5. replies with one exact, complete committed Settings snapshot or a bounded
   defined failure.

The sender guard keeps the request UI-only because it is absent from the
content-script allow-list.

## Rejected designs

- **Full Settings replacement:** stale UI snapshots still overwrite unrelated
  fields.
- **One queue per caller:** orders writes only within that caller.
- **Revision conflicts:** adds storage migration and conflict UI without a
  product need. Fresh-state patch merge already prevents unrelated-field loss.
  The later v1 storage revision is not an editing-conflict protocol. It marks
  canonical persistence state; Settings Recovery uses the raw fingerprint.
- **Write through storage watches:** watches observe; they do not acknowledge a
  commit.

## Verification

- Delay the first record write; queue a second patch; prove both survive.
- Reject one write; prove the next still commits.
- Reject unknown keys and invalid values without a write.
- Prove `updateWhen` is atomic and no-op when false.
- Race connect, disconnect, token refresh, folder lookup, and upload dispatch;
  prove the newest provider intent wins.
- Prove the runtime adapter rejects failed, missing, and malformed replies.
- Prove a content script cannot send `SettingsUpdateRequest`.
- Run focused tests, Effect diagnostics, full check, and production build.

## 2026-07-28 persistence amendment

The writer interface gained three deeper behaviors without adding another
mutation seam:

- decode one versioned Settings envelope and one legacy input shape;
- preserve bounded corrupt/unknown raw fields during named patches;
- inspect and confirm Settings Recovery through a bounded Options-only wire
  contract.

The runtime projection is fail-safe while recovery is pending: Direct stays
available; Cloud Sync, Cloud upload, Clear, and Capture Mirror pause. Repair
keeps valid known fields and defaults invalid fields. Reset restores defaults.
Neither action accepts raw Settings over the wire. A fingerprint binds the
confirmation to the inspected value inside the writer FIFO.
