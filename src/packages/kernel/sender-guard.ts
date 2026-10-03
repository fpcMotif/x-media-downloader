import type { Message } from '@/packages/schema'
import { originsForAllAdapters } from '@/core/adapters/registry'

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
 *  - Internal UI (popup / options): our extension id on an extension-scheme
 *    origin — may send anything.
 *  - Content script (overlay on x.com / twitter.com / instagram / threads): our
 *    extension id, has a `tab`, on an allowed web origin — may send only
 *    {@link CONTENT_SCRIPT_TAGS}.
 * Everything else — a foreign extension id, a content script on another origin,
 * or a privileged (UI-only) tag arriving from a content script — is rejected.
 */

/** The message tags the overlay content script legitimately sends. Every other
 *  tag is UI-only and is accepted from internal popup/options surfaces only.
 *  Typed against `Message['_tag']` (not a bare `string`) so adding a new tag to
 *  the `Message` union forces a decision here — this exact hole (a tag silently
 *  missing from this set) dropped every Instagram/Threads overlay message with
 *  no error signal until 670d5a6 caught it live. See `expectReply` in
 *  `./messaging` for the caller-side half of that same invariant. */
export const CONTENT_SCRIPT_TAGS: ReadonlySet<Message['_tag']> = new Set([
  'DownloadRequest',
  'DownloadTraceEvent',
  'RecoverTweetMediaRequest',
  'SweepEnqueueRequest',
  // Tweet Harvest: the overlay flushes harvested tweet records off the tee. The
  // privileged capture tags (Summary/Export/Clear) stay UI-only — a content
  // script may PUSH captures but never trigger an export or wipe the store.
  'CaptureTweets',
  // Timeline "Saved ✓" sweep: the overlay asks which mounted tweets are already
  // downloaded. Read-only membership over the page's own tweet ids.
  'SavedStatusRequest',
  // Release diagnostics: the overlay relays one observed bookmark/like mutation
  // event off the MAIN-world tee. Never triggers a mutation itself — observe only.
  'ReleaseMutationEvent',
])

// Derived from the adapter registry (docs/adr/0019-platform-identity-derives-from-adapter-registry.md)
// so a new platform's origin is auto-allowed the moment its adapter is
// registered — no parallel edit here to forget. Mirrors wxt.config.ts's
// host_permissions page-origin list. This set was NOT updated when
// Instagram/Threads content scripts were added under the old literal-Set
// form, which silently dropped every overlay-to-background message from
// those tabs (DownloadRequest included) with no error signal — the listener
// returns false, so the caller sees an unanswered `reply: undefined`, not a
// rejection. That's the failure mode this derivation closes off.
const ALLOWED_CONTENT_SCRIPT_ORIGINS: ReadonlySet<string> = originsForAllAdapters()

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

/** Something hosted in a browser tab — a content script OR an extension page
 *  opened in a tab. Not a trust signal on its own; see {@link isExtensionPage}. */
function isContentScript(sender: MessageSenderLike): boolean {
  return sender.tab !== undefined && sender.tab !== null
}

/** Our own extension pages carry an extension-scheme origin the browser sets;
 *  a web page cannot forge one, and no page here is web-accessible, so no web
 *  origin can host an extension-origin frame. Matched on the RAW `origin`/`url`
 *  string, never on `URL.origin`: `chrome-extension:` is not a special scheme,
 *  so a spec-conformant `URL.origin` is the string `"null"` for it. */
const EXTENSION_SCHEME = /^(?:chrome|moz)-extension:\/\//

/**
 * An extension page of ours (popup, options, offscreen). The options page is
 * declared `open_in_tab`, so Chrome sets `sender.tab` on everything it sends —
 * the SAME shape a content script has. The origin scheme, not the tab, is what
 * separates internal UI from page script: keying off `tab` alone blocked every
 * options-page message (Cloud connect, sync test, clear history) at the guard,
 * and the caller only ever saw an unanswered reply.
 */
function isExtensionPage(sender: MessageSenderLike): boolean {
  return EXTENSION_SCHEME.test(sender.origin ?? '') || EXTENSION_SCHEME.test(sender.url ?? '')
}

/**
 * Whether `tag` from `sender` may be dispatched, given the extension's own id.
 * Fail-closed: an undefined sender, a foreign id, an off-origin content script,
 * or a UI-only tag from a content script all return false.
 */
export function isMessageAllowed(
  tag: Message['_tag'],
  sender: MessageSenderLike | undefined,
  ownId: string,
): boolean {
  if (sender === undefined || sender.id !== ownId) return false // not our extension
  if (isExtensionPage(sender)) return true // popup / options — options lives in a tab
  if (!isContentScript(sender)) return true // an extension context with no url (SW, popup)
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
