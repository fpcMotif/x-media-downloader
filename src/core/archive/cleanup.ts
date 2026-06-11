import type { ArchiveSource } from './capture'

/**
 * Bookmark/like removal (ADR-0010): replays exactly the `DeleteBookmark` /
 * `UnfavoriteTweet` GraphQL mutations X's own web app makes, from inside the X
 * tab (same-origin, the `ct0` cookie carries auth) so no `cookies` permission
 * and no header smuggling. Opt-in; failures are tolerated, never retried.
 */

export type CleanupOp = 'DeleteBookmark' | 'UnfavoriteTweet'

export interface CleanupRequest {
  readonly tweetId: string
  readonly source: ArchiveSource
  readonly op: CleanupOp
  readonly url: string
  readonly body: string
}

/**
 * Public web GraphQL queryIds for the cleanup mutations. These rotate rarely;
 * isolating them here means a rotation degrades to "bookmark kept" (the
 * mutation 404s, `run` returns false), never data loss. Update from a live
 * x.com session if removal starts failing.
 */
export const CLEANUP_QUERY_IDS: Record<CleanupOp, string> = {
  DeleteBookmark: 'Wlmlj2-xzyS1GN3a6cj-mQ',
  UnfavoriteTweet: 'ZYKSe-w7KEslx3JhSIk5LA',
}

/** The public web bearer token X ships in its own bundle (not a secret). */
const WEB_BEARER =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'

const OP_FOR: Record<ArchiveSource, CleanupOp> = {
  bookmarks: 'DeleteBookmark',
  likes: 'UnfavoriteTweet',
}

export function buildCleanupRequest(tweetId: string, source: ArchiveSource): CleanupRequest {
  const op = OP_FOR[source]
  const queryId = CLEANUP_QUERY_IDS[op]
  return {
    tweetId,
    source,
    op,
    url: `https://x.com/i/api/graphql/${queryId}/${op}`,
    body: JSON.stringify({ variables: { tweet_id: tweetId }, queryId }),
  }
}

/** Extract the `ct0` CSRF token from a `document.cookie` string. */
export function csrfFromCookie(cookie: string): string | null {
  const m = /(?:^|;\s*)ct0=([^;]+)/.exec(cookie)
  return m && m[1] ? decodeURIComponent(m[1]) : null
}

export function cleanupHeaders(csrf: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-csrf-token': csrf,
    authorization: WEB_BEARER,
  }
}

/** A GraphQL mutation succeeded when it returned `data` and no errors. */
export function isCleanupSuccess(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  const b = body as { data?: unknown; errors?: unknown }
  if (typeof b.data !== 'object' || b.data === null) return false
  if (Array.isArray(b.errors) && b.errors.length > 0) return false
  return true
}

/**
 * Fetch-injected cleanup port. `run` resolves `false` on any failure (missing
 * csrf, network error, GraphQL error) and never throws — a kept bookmark is
 * always preferable to a thrown job.
 */
export function makeCleanupPort(deps: {
  readonly fetchImpl: typeof fetch
  readonly getCookie: () => string
}): { readonly run: (req: CleanupRequest) => Promise<boolean> } {
  return {
    run: async (req) => {
      const csrf = csrfFromCookie(deps.getCookie())
      if (csrf === null) return false
      try {
        const res = await deps.fetchImpl(req.url, {
          method: 'POST',
          credentials: 'include',
          headers: cleanupHeaders(csrf),
          body: req.body,
        })
        if (!res.ok) return false
        const json: unknown = await res.json()
        return isCleanupSuccess(json)
      } catch {
        return false
      }
    },
  }
}
