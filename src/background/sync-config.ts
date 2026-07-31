import type { Settings } from '@/packages/schema'

/** Is Cloud Sync usable: enabled, with a deployment URL and a shared secret.
 *  Fail closed — the Convex deployment requires a shared secret (ADR-0009), so
 *  without one every POST would 401 and the outbox would fill undeliverably.
 *  One source of truth shared by the outbox drain, the upload mirror, and boot. */
export const isSyncConfigured = (s: Settings): boolean =>
  s.cloudSyncEnabled && s.convexUrl !== '' && s.convexSyncSecret !== ''
