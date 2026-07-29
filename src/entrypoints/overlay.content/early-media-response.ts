import { MAX_TEE_BODY_BYTES, MAX_TEE_CAPTURES_IN_FLIGHT } from '../../core/tee-contract'
import { utf8ByteLengthAtMost } from '../../core/wire/utf8'
import { decodeMediaResponseEvent, type MediaResponse } from './media-response-contract'

/** Keep the document-start handoff no larger than the tee's single-body ingress cap. */
export const MAX_EARLY_MEDIA_RESPONSE_BYTES = MAX_TEE_BODY_BYTES
/** A second cap prevents a burst of small responses from growing the handoff. */
export const MAX_EARLY_MEDIA_RESPONSES = MAX_TEE_CAPTURES_IN_FLIGHT

export interface EarlyMediaResponseBridge {
  subscribe(listener: (response: MediaResponse) => void): () => void
}

type StoredResponse = MediaResponse & { readonly bodyBytes: number }
type ScheduleMicrotask = (task: () => void) => void

const deliver = (listener: (response: MediaResponse) => void, response: MediaResponse): void => {
  try {
    listener(response)
  } catch {
    // A page event must never make the page-visible listener throw.
  }
}

/**
 * Owns the one ISOLATED-world document listener. Every page event enters one
 * tiny FIFO before an overlay can parse it. The document-start singleton keeps
 * that bound across early startup, live traffic, and overlay replacement.
 */
export const makeEarlyMediaResponseBridge = (
  target: EventTarget,
  scheduleMicrotask: ScheduleMicrotask = queueMicrotask,
): EarlyMediaResponseBridge => {
  const pending: StoredResponse[] = []
  let pendingBytes = 0
  let listener: ((response: MediaResponse) => void) | undefined
  let drainScheduled = false

  const scheduleDrain = (): void => {
    if (listener === undefined || pending.length === 0 || drainScheduled) return
    drainScheduled = true
    scheduleMicrotask(() => {
      drainScheduled = false
      const activeListener = listener
      if (activeListener === undefined) return
      // Snapshot the batch: a listener may synchronously emit another page event
      // or replace itself. Those responses wait for the next microtask.
      const batchSize = pending.length
      for (let index = 0; index < batchSize; index += 1) {
        if (listener !== activeListener) break
        const response = pending.shift()
        if (response === undefined) break
        pendingBytes -= response.bodyBytes
        deliver(activeListener, response)
      }
      scheduleDrain()
    })
  }

  target.addEventListener('xmd:media-response', (event) => {
    // Once the FIFO is full, forged events cannot force any further validation
    // work, JSON.parse, or adapter detection until a bounded drain makes room.
    if (pending.length >= MAX_EARLY_MEDIA_RESPONSES) return
    const response = decodeMediaResponseEvent(event)
    if (!response) return

    const bodyBytes = utf8ByteLengthAtMost(response.body, MAX_EARLY_MEDIA_RESPONSE_BYTES)
    if (bodyBytes === undefined || bodyBytes > MAX_EARLY_MEDIA_RESPONSE_BYTES - pendingBytes) return
    pending.push({ ...response, bodyBytes })
    pendingBytes += bodyBytes
    scheduleDrain()
  })

  return {
    subscribe(nextListener) {
      listener = nextListener
      scheduleDrain()
      return () => {
        if (listener === nextListener) listener = undefined
      }
    },
  }
}

const bridgeSlot = Symbol.for('xmd.early-media-response-bridge')

type BridgeSlot = { readonly target: EventTarget; readonly bridge: EarlyMediaResponseBridge }

/** Shares the document-start listener between separately bundled WXT entrypoints. */
export const installEarlyMediaResponseBridge = (target: EventTarget): EarlyMediaResponseBridge => {
  const scope = globalThis as typeof globalThis & { [key: symbol]: unknown }
  const existing = scope[bridgeSlot] as BridgeSlot | undefined
  if (existing?.target === target) return existing.bridge

  const bridge = makeEarlyMediaResponseBridge(target)
  scope[bridgeSlot] = { target, bridge } satisfies BridgeSlot
  return bridge
}
