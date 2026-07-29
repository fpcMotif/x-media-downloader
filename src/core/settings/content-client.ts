import { expectReply, safeSend } from '../messaging'
import {
  decodeSettingsChanged,
  decodeSettingsReadResponse,
  type ContentSettings,
  type SettingsReadRequest,
} from '../schema'
import { isFromExtensionWorker, type MessageSenderLike } from '../sender-guard'

/** The content script's one read-only request to the worker. */
export type ContentSettingsSender = (request: SettingsReadRequest) => Promise<unknown>

export type ContentSettingsReadResult =
  | { readonly status: 'available'; readonly settings: ContentSettings }
  | {
      readonly status: 'unavailable'
      readonly reason:
        | 'worker-unavailable'
        | 'context-invalidated'
        | 'send-failed'
        | 'unclaimed'
        | 'malformed-response'
      readonly detail?: unknown
    }

export type ContentSettingsListener = (
  message: unknown,
  sender: MessageSenderLike | undefined,
) => void

/** Runtime capability kept structural for a testable and narrow content bridge. */
export interface ContentSettingsRuntime {
  readonly ownId: string
  readonly addMessageListener: (listener: ContentSettingsListener) => void
  readonly removeMessageListener: (listener: ContentSettingsListener) => void
}

export interface ContentSettingsClient {
  readonly read: () => Promise<ContentSettingsReadResult>
  readonly watch: (onChange: (settings: ContentSettings) => void) => () => void
  readonly start: (onChange: (settings: ContentSettings) => void) => ContentSettingsSession
}

export interface ContentSettingsSession {
  readonly initial: Promise<ContentSettingsReadResult>
  readonly stop: () => void
}

/**
 * Content scripts cannot read `storage.local` once it is restricted to trusted
 * contexts. This bridge never manufactures defaults: callers get either a
 * verified worker snapshot or an explicit unavailable result.
 */
export const makeContentSettingsClient = (
  send: ContentSettingsSender,
  runtime: ContentSettingsRuntime,
): ContentSettingsClient => {
  const read = async (): Promise<ContentSettingsReadResult> => {
    const reply = expectReply(await safeSend(() => send({ _tag: 'SettingsReadRequest' })))
    switch (reply.status) {
      case 'context-invalidated':
        return { status: 'unavailable', reason: 'context-invalidated' }
      case 'error':
        return { status: 'unavailable', reason: 'send-failed', detail: reply.error }
      case 'unclaimed':
        return { status: 'unavailable', reason: 'unclaimed' }
      case 'ok': {
        const decoded = decodeSettingsReadResponse(reply.reply)
        if (decoded === undefined)
          return { status: 'unavailable', reason: 'malformed-response', detail: reply.reply }
        return decoded._tag === 'SettingsReadUnavailable'
          ? { status: 'unavailable', reason: 'worker-unavailable' }
          : { status: 'available', settings: decoded.settings }
      }
    }
  }

  const watch = (onChange: (settings: ContentSettings) => void): (() => void) => {
    const listener: ContentSettingsListener = (message, sender) => {
      if (!isFromExtensionWorker(sender, runtime.ownId)) return
      const changed = decodeSettingsChanged(message)
      if (changed !== undefined) onChange(changed.settings)
    }
    runtime.addMessageListener(listener)
    return () => runtime.removeMessageListener(listener)
  }

  return {
    read,
    watch,
    start: (onChange) => {
      let stopped = false
      let refreshEpoch = 0
      const refresh = (): Promise<ContentSettingsReadResult> => {
        const epoch = ++refreshEpoch
        return read().then((result) => {
          if (!stopped && epoch === refreshEpoch && result.status === 'available')
            onChange(result.settings)
          return result
        })
      }
      // A push is a wake, not truth. Pull the canonical worker snapshot so a
      // delayed broadcast cannot roll newer settings back.
      const unwatch = watch(() => {
        void refresh()
      })
      const initial = refresh()
      return {
        initial,
        stop: () => {
          if (stopped) return
          stopped = true
          refreshEpoch += 1
          unwatch()
        },
      }
    },
  }
}

const runtimeContentSettingsClient = makeContentSettingsClient(
  (request) => browser.runtime.sendMessage(request),
  {
    ownId: browser.runtime.id,
    addMessageListener: (listener) => browser.runtime.onMessage.addListener(listener),
    removeMessageListener: (listener) => browser.runtime.onMessage.removeListener(listener),
  },
)

/** Start a race-safe initial read plus verified worker change stream. */
export const startContentSettings = (
  onChange: (settings: ContentSettings) => void,
): ContentSettingsSession => runtimeContentSettingsClient.start(onChange)
