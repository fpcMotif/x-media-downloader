import type { BackgroundRequest } from './schema'
import { originsForAllPlatforms } from './adapters/catalog'

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
 *  - Internal UI (popup / options): our extension id and extension URL — may send
 *    anything. Options may carry a `tab` when `open_in_tab` is enabled.
 *  - Content script (overlay on x.com / twitter.com / instagram / threads): our
 *    extension id, has a `tab`, on an allowed origin — may send only
 *    {@link CONTENT_SCRIPT_TAGS}.
 * Everything else — a foreign extension id, a content script on another origin,
 * or a privileged (UI-only) tag arriving from a content script — is rejected.
 */

/** The message tags the overlay content script legitimately sends. Every other
 *  tag is UI-only and is accepted from internal popup/options surfaces only.
 *  Typed against `BackgroundRequest['_tag']` (not a bare `string`) so adding a new tag to
 *  the request union forces a decision here — this exact hole (a tag silently
 *  missing from this set) dropped every Instagram/Threads overlay message with
 *  no error signal until 670d5a6 caught it live. See `expectReply` in
 *  `./messaging` for the caller-side half of that same invariant. */
export const CONTENT_SCRIPT_TAGS: ReadonlySet<BackgroundRequest['_tag']> = new Set([
  // Content storage is restricted to trusted extension contexts. The overlay
  // gets its snapshot only through this read-only worker bridge.
  'SettingsReadRequest',
  'DownloadRequest',
  'DownloadTraceEvent',
  'RecoverTweetMediaRequest',
  'SweepEnqueueRequest',
  // Read-only wake-up hint for durable Clear retries. The background still
  // rechecks ledger, settings, and this sender tab before it can target anything.
  'ClearVisibilityPulse',
  // Tweet Harvest: the overlay flushes harvested tweet records off the tee. The
  // privileged capture tags (Summary/Export/Clear) stay UI-only — a content
  // script may PUSH captures but never trigger an export or wipe the store.
  'CaptureEpochRequest',
  'CaptureTweets',
  // Timeline "Saved ✓" sweep: the overlay asks which mounted tweets are already
  // downloaded. Read-only membership over the page's own tweet ids.
  'SavedStatusRequest',
])

// Derived from the Platform Catalog (ADR-0019), so a new platform's origin is
// auto-allowed when its descriptor is registered — no parallel edit here to
// forget. Mirrors wxt.config.ts's
// host_permissions page-origin list. This set was NOT updated when
// Instagram/Threads content scripts were added under the old literal-Set
// form, which silently dropped every overlay-to-background message from
// those tabs (DownloadRequest included) with no error signal — the listener
// returns false, so the caller sees an unanswered `reply: undefined`, not a
// rejection. That's the failure mode this derivation closes off.
const ALLOWED_CONTENT_SCRIPT_ORIGINS: ReadonlySet<string> = originsForAllPlatforms()

/** The `chrome.runtime.MessageSender` fields this guard inspects (structural). */
export interface MessageSenderLike {
  readonly id?: string | undefined
  readonly tab?: unknown
  readonly documentId?: string | undefined
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

/** A tab narrows the sender to content script or tabbed extension document. */
function isContentScript(sender: MessageSenderLike): boolean {
  return sender.tab !== undefined && sender.tab !== null
}

/** Chrome gives an options page opened in a tab both `tab` and an extension URL.
 * The URL, not tab presence, distinguishes it from a page-world content script. */
function isOwnExtensionDocument(sender: MessageSenderLike, ownId: string): boolean {
  for (const raw of [sender.origin, sender.url]) {
    if (raw === undefined || raw === '') continue
    try {
      const url = new URL(raw)
      if (url.protocol === 'chrome-extension:' && url.hostname === ownId) return true
      // Firefox uses an internal UUID host; sender.id already proves ownership.
      if (url.protocol === 'moz-extension:') return true
    } catch {
      // Try the other sender field.
    }
  }
  return false
}

/**
 * Whether `tag` from `sender` may be dispatched, given the extension's own id.
 * Fail-closed: an undefined sender, a foreign id, an off-origin content script,
 * or a UI-only tag from a content script all return false.
 */
export function isMessageAllowed(
  tag: BackgroundRequest['_tag'],
  sender: MessageSenderLike | undefined,
  ownId: string,
): boolean {
  if (sender === undefined || sender.id !== ownId) return false // not our extension
  if (!isContentScript(sender) || isOwnExtensionDocument(sender, ownId)) return true
  const origin = originOf(sender)
  if (origin === null || !ALLOWED_CONTENT_SCRIPT_ORIGINS.has(origin)) return false
  return CONTENT_SCRIPT_TAGS.has(tag) // content scripts: only their own tags
}

/**
 * True iff the sender is the extension's own background worker: its id, no tab,
 * and no document id. The offscreen Blob sink accepts only the background-owned
 * Fetched transfer gateway. Popup and options pages have document ids, so they
 * cannot drive the sink through same-origin `runtime.sendMessage` broadcasts.
 */
export function isFromExtensionWorker(
  sender: MessageSenderLike | undefined,
  ownId: string,
): boolean {
  if (sender === undefined || sender.id !== ownId) return false
  return !isContentScript(sender) && sender.documentId === undefined
}
