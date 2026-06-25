/**
 * The content-script ⇄ background runtime channel, and how it dies.
 *
 * A content script outlives its extension context whenever the extension is
 * reloaded, updated, or disabled while the tab stays open (a `wxt dev` rebuild,
 * a Chrome auto-update, a manual reload). The channel is then dead — but this is
 * NOT a download failure, it is a stale tab that needs a refresh.
 *
 * Two failure shapes matter, and the obvious `sendMessage(...).catch(...)` misses
 * the first one:
 *   1. Chrome throws SYNCHRONOUSLY, while the `browser.runtime.sendMessage(...)`
 *      sub-expression is still evaluating — before any `.then/.catch` is attached.
 *      A trailing `.catch` therefore never runs; the throw escapes and (in an async
 *      IIFE) leaves the caller's UI stuck. Two wordings occur here: an explicit
 *      `Extension context invalidated`, or — once `browser.runtime` itself is gone
 *      (as the teardown path's `browser.runtime?.` guard attests) — a plain
 *      `TypeError: Cannot read properties of undefined (reading 'sendMessage')`.
 *   2. When only the service worker was evicted (context still valid), the send
 *      REJECTS asynchronously instead — that a `.catch` would see.
 * `safeSend` funnels all of these into one typed outcome and never throws.
 */

const DEAD_CONTEXT =
  /extension context invalidated|context invalidated|message port closed|receiving end does not exist|must be loaded in a web extension environment|cannot read prop\w+ of (?:undefined|null) \(reading '(?:sendMessage|runtime)'\)/i

/** Whether an error means the extension context is gone (reload needed), not a real failure. */
export const isContextInvalidatedError = (err: unknown): boolean =>
  DEAD_CONTEXT.test(err instanceof Error ? err.message : String(err))

export type SendOutcome<R> =
  | { readonly status: 'ok'; readonly reply: R }
  | { readonly status: 'context-invalidated' }
  | { readonly status: 'error'; readonly error: unknown }

/**
 * Run a message-send thunk, capturing BOTH the synchronous context-invalidated
 * throw and any async rejection into a single outcome. Pass a thunk (not an
 * already-started promise) so a throw at call time lands inside the `try`.
 */
export const safeSend = async <R>(send: () => Promise<R>): Promise<SendOutcome<R>> => {
  try {
    return { status: 'ok', reply: await send() }
  } catch (error) {
    return isContextInvalidatedError(error)
      ? { status: 'context-invalidated' }
      : { status: 'error', error }
  }
}
