/**
 * Fail-closed shared-secret authorization (ADR-0009 hardening), shared by sync.ts
 * and uploads.ts. The deployment MUST set `SYNC_SHARED_SECRET` and the caller MUST
 * present a matching `secret`. The message strings are load-bearing — the client
 * classifies sync failures by message (src/core/sync/status.ts), so keep them stable.
 */
export function assertSecret(secret: string): void {
  const required = process.env.SYNC_SHARED_SECRET
  if (required === undefined || required === '') {
    throw new Error('unauthorized: deployment has no SYNC_SHARED_SECRET configured')
  }
  if (secret !== required) {
    throw new Error('unauthorized: bad or missing sync secret')
  }
}
