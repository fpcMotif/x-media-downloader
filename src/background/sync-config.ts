import type { Settings } from '../core/schema'
import { normalizeConvexDeploymentUrl } from '../core/sync/convex'

/** Shared Convex credentials. Product intents decide separately whether they use
 * this connection. */
export const hasConvexConnection = (s: Settings): boolean =>
  s.convexUrl !== '' && s.convexSyncSecret !== ''

/** Is Cloud Sync usable: enabled, with a deployment URL and a shared secret.
 *  Fail closed — the Convex deployment requires a shared secret (ADR-0009), so
 *  without one every POST would 401 and the outbox would fill undeliverably. */
export const isSyncConfigured = (s: Settings): boolean =>
  s.cloudSyncEnabled && hasConvexConnection(s)

/** Capture Mirror owns separate consent. It shares the connection and device
 * identity, but never inherits Media Sync's enabled flag. */
export const captureMirrorDestination = (s: Settings): string | undefined =>
  s.captureEnabled && s.captureMirrorEnabled && s.cloudDeviceId !== '' && s.convexSyncSecret !== ''
    ? normalizeConvexDeploymentUrl(s.convexUrl)
    : undefined

export const isCaptureMirrorConfigured = (s: Settings): boolean =>
  captureMirrorDestination(s) !== undefined
