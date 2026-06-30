/**
 * Sender authorization for the background service worker's `runtime.onMessage`
 * router. That router triggers downloads, OAuth flows, cloud byte egress, and
 * destructive clears — so a message from an untrusted sender must be dropped
 * before dispatch. Foreign extensions reach `runtime.onMessageExternal` (which
 * this extension never registers), not `onMessage`, and `externally_connectable`
 * is unset — so neither another extension nor a web page can reach these routers.
 * The surface they actually govern is the extension's OWN content scripts
 * injected into x.com / twitter.com, confined to {@link CONTENT_SCRIPT_TAGS}.
 *
 * Two trust tiers, validated against the real `sendMessage` call sites:
 *  - Internal UI (popup / options): our extension id, no `tab` — may send anything.
 *  - Content script (overlay on x.com / twitter.com): our extension id, has a
 *    `tab`, on an allowed origin — may send only {@link CONTENT_SCRIPT_TAGS}.
 * Everything else — a foreign extension id, a content script on another origin,
 * or a privileged (UI-only) tag arriving from a content script — is rejected.
 */

/** The message tags the overlay content script legitimately sends. Every other
 *  tag is UI-only and is accepted from internal popup/options surfaces only. */
export const CONTENT_SCRIPT_TAGS: ReadonlySet<string> = new Set([
  'DownloadRequest',
  'DownloadTraceEvent',
  'RecoverTweetMediaRequest',
  'SweepEnqueueRequest',
  // Tweet Harvest: the overlay flushes harvested tweet records off the tee. The
  // privileged capture tags (Summary/Export/Clear) stay UI-only — a content
  // script may PUSH captures but never trigger an export or wipe the store.
  'CaptureTweets',
])

const ALLOWED_CONTENT_SCRIPT_ORIGINS: ReadonlySet<string> = new Set([
  'https://x.com',
  'https://twitter.com',
])

/** The `chrome.runtime.MessageSender` fields this guard inspects (structural). */
export interface MessageSenderLike {
  readonly id?: string | undefined
  readonly tab?: unknown
  readonly url?: string | undefined
  readonly origin?: string | undefined
}

/** Sender origin, preferring `origin`, falling back to parsing `url`; null if neither yields one. */
function originOf(sender: MessageSenderLike): string | null {
  if (sender.origin !== undefined && sender.origin !== '') return sender.origin
  if (sender.url === undefined || sender.url === '') return null
  try {
    return new URL(sender.url).origin
  } catch {
    return null
  }
}

/** A content script carries a `tab`; internal UI (popup/options) does not. */
function isContentScript(sender: MessageSenderLike): boolean {
  return sender.tab !== undefined && sender.tab !== null
}

/**
 * Whether `tag` from `sender` may be dispatched, given the extension's own id.
 * Fail-closed: an undefined sender, a foreign id, an off-origin content script,
 * or a UI-only tag from a content script all return false.
 */
export function isMessageAllowed(
  tag: string,
  sender: MessageSenderLike | undefined,
  ownId: string,
): boolean {
  if (sender === undefined || sender.id !== ownId) return false // not our extension
  if (!isContentScript(sender)) return true // internal UI may send any tag
  const origin = originOf(sender)
  if (origin === null || !ALLOWED_CONTENT_SCRIPT_ORIGINS.has(origin)) return false
  return CONTENT_SCRIPT_TAGS.has(tag) // content scripts: only their own tags
}

/**
 * True iff the sender is the extension's OWN background service worker (or an
 * extension page) — our id AND no `tab`. For surfaces whose sole legitimate
 * caller is the background worker: the offscreen download sink, whose only sender
 * is `makeOffscreenPort.saveBlob` (which runs in the SW). Content scripts share
 * the extension id but carry a `tab`, and `runtime.sendMessage` is a same-origin
 * broadcast that an open offscreen document also receives — so an id-only check
 * would let a content script drive the sink. Reject anything carrying a `tab`.
 */
export function isFromExtensionWorker(
  sender: MessageSenderLike | undefined,
  ownId: string,
): boolean {
  if (sender === undefined || sender.id !== ownId) return false
  return !isContentScript(sender)
}
