import type { ArchiveSource } from './capture'

/**
 * Optional remote mirror of saved keys (ADR-0010). Follows the byte-free,
 * fire-and-forget pattern of the cloud PRs: a Cloudflare Worker (PR #1/#2) or a
 * Convex deployment (ADR-0009). The local ledger stays the source of truth —
 * a sync failure never blocks or fails a download.
 */

export type ArchiveSyncKind = 'off' | 'cloudflare' | 'convex'

export interface RemoteSyncConfig {
  readonly kind: ArchiveSyncKind
  readonly url: string
  readonly secret: string
}

export interface SavedEntryPayload {
  readonly key: string
  readonly tweetId: string
  readonly source: ArchiveSource
  readonly savedAt: number
}

export interface SyncRequest {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string
}

/**
 * Build the HTTP request that mirrors `entries`, or `null` when there is
 * nothing to send (sync off, no url, or no entries).
 */
export function buildSyncRequest(
  cfg: RemoteSyncConfig,
  entries: ReadonlyArray<SavedEntryPayload>,
): SyncRequest | null {
  if (cfg.kind === 'off' || cfg.url.trim() === '' || entries.length === 0) return null
  const base = cfg.url.replace(/\/+$/, '')
  const headers: Record<string, string> = { 'content-type': 'application/json' }

  if (cfg.kind === 'cloudflare') {
    if (cfg.secret !== '') headers.authorization = `Bearer ${cfg.secret}`
    return { url: `${base}/saved`, headers, body: JSON.stringify({ entries }) }
  }
  // convex: public HTTP mutation envelope (ADR-0009).
  const args = cfg.secret !== '' ? { entries, secret: cfg.secret } : { entries }
  return {
    url: `${base}/api/mutation`,
    headers,
    body: JSON.stringify({ path: 'archive:recordSaved', args, format: 'json' }),
  }
}

/**
 * Fetch-injected remote port. `record` is fire-and-forget: it swallows every
 * rejection and non-OK response and always resolves void.
 */
export function makeRemoteLedgerPort(
  cfg: RemoteSyncConfig,
  fetchImpl: typeof fetch,
): { readonly record: (entries: ReadonlyArray<SavedEntryPayload>) => Promise<void> } {
  return {
    record: async (entries) => {
      const req = buildSyncRequest(cfg, entries)
      if (req === null) return
      try {
        await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: req.body })
      } catch {
        /* fire-and-forget: the local ledger is the source of truth */
      }
    },
  }
}
