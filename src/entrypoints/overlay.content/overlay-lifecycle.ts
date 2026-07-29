import type { ContentSettingsSession } from '../../core/settings/content-client'
import type { MessageSenderLike } from '../../core/sender-guard'
import { dispatchOverlayMessage, type HandlerDeps, type OverlayMessageAuthority } from './handlers'
import type { EarlyMediaResponseBridge } from './early-media-response'
import { isMediaResponseForRoute, type MediaResponse } from './media-response-contract'

type RuntimeMessageHandler = (
  message: unknown,
  sender: MessageSenderLike | undefined,
  sendResponse: (response: unknown) => void,
) => boolean | void

interface RuntimeMessages {
  readonly addListener: (listener: RuntimeMessageHandler) => void
  readonly removeListener: (listener: RuntimeMessageHandler) => void
}

interface OverlayLifecycleDeps {
  readonly bridge: EarlyMediaResponseBridge
  readonly consumeMediaResponse: (response: MediaResponse) => void
  readonly runtimeMessages: RuntimeMessages
  readonly handleRuntimeMessage: RuntimeMessageHandler
  readonly settings: Pick<ContentSettingsSession, 'stop'>
}

/** Keeps the overlay's three external subscriptions in one invalidation owner. */
export const startOverlayLifecycle = ({
  bridge,
  consumeMediaResponse,
  runtimeMessages,
  handleRuntimeMessage,
  settings,
}: OverlayLifecycleDeps): { readonly stop: () => void } => {
  let stopped = false
  let stopBridge: (() => void) | undefined
  let runtimeAttached = false

  const stop = (): void => {
    if (stopped) return
    stopped = true
    try {
      settings.stop()
    } catch {
      // The extension context may already be gone during invalidation.
    }
    stopBridge?.()
    if (!runtimeAttached) return
    try {
      runtimeMessages.removeListener(handleRuntimeMessage)
    } catch {
      // The extension context may already be gone during invalidation.
    }
  }

  try {
    stopBridge = bridge.subscribe(consumeMediaResponse)
    runtimeAttached = true
    runtimeMessages.addListener(handleRuntimeMessage)
  } catch (error) {
    stop()
    throw error
  }

  return {
    stop,
  }
}

/** The route guard stays immediately before the overlay's JSON/detection consumer. */
export const makeRouteMediaResponseConsumer =
  (
    currentRoute: () => string,
    ingest: (response: MediaResponse) => void,
  ): ((response: MediaResponse) => void) =>
  (response) => {
    if (!isMediaResponseForRoute(response, currentRoute())) return
    ingest(response)
  }

/** Builds the one runtime listener whose transfer outcomes target local affordances. */
export const makeOverlayRuntimeMessageHandler =
  (deps: HandlerDeps, authority: OverlayMessageAuthority): RuntimeMessageHandler =>
  (message, sender, sendResponse) =>
    dispatchOverlayMessage(message, deps, sendResponse, sender, authority)
