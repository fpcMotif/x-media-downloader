import { describe, expect, it, vi } from 'vitest'
import type { HandlerDeps } from './handlers'
import type { MediaResponse } from './media-response-contract'
import {
  makeOverlayRuntimeMessageHandler,
  makeRouteMediaResponseConsumer,
  startOverlayLifecycle,
} from './overlay-lifecycle'

const response = (route = '/home'): MediaResponse => ({ path: '/media', body: '{}', route })
type RuntimeMessageHandler = ReturnType<typeof makeOverlayRuntimeMessageHandler>
type BridgeSubscribe = (listener: (response: MediaResponse) => void) => () => void

const makeBridge = () => {
  let listener: ((next: MediaResponse) => void) | undefined
  const unsubscribe = vi.fn<() => void>(() => {
    listener = undefined
  })
  return {
    bridge: {
      subscribe: vi.fn<BridgeSubscribe>((next) => {
        listener = next
        return unsubscribe
      }),
    },
    emit: (next: MediaResponse) => listener?.(next),
    unsubscribe,
  }
}

const makeRuntime = () => {
  let listener: RuntimeMessageHandler | undefined
  return {
    messages: {
      addListener: vi.fn<(next: RuntimeMessageHandler) => void>((next) => {
        listener = next
      }),
      removeListener: vi.fn<(next: RuntimeMessageHandler) => void>((next) => {
        if (listener === next) listener = undefined
      }),
    },
    receive: (
      message: unknown,
      sender: { id?: string; tab?: unknown; url?: string; documentId?: string } | undefined,
    ): boolean | void => listener?.(message, sender, () => {}),
  }
}

describe('overlay lifecycle composition', () => {
  it('subscribes once, then tears down the bridge, settings, and runtime listener', () => {
    const bridge = makeBridge()
    const runtime = makeRuntime()
    const settings = { stop: vi.fn<() => void>() }
    const consume = vi.fn<(response: MediaResponse) => void>()
    const runtimeMessage = vi.fn<RuntimeMessageHandler>()
    const lifecycle = startOverlayLifecycle({
      bridge: bridge.bridge,
      consumeMediaResponse: consume,
      runtimeMessages: runtime.messages,
      handleRuntimeMessage: runtimeMessage,
      settings,
    })

    bridge.emit(response())
    expect(consume).toHaveBeenCalledWith(response())
    expect(runtime.messages.addListener).toHaveBeenCalledWith(runtimeMessage)

    lifecycle.stop()
    lifecycle.stop()
    bridge.emit(response())

    expect(bridge.unsubscribe).toHaveBeenCalledOnce()
    expect(settings.stop).toHaveBeenCalledOnce()
    expect(runtime.messages.removeListener).toHaveBeenCalledWith(runtimeMessage)
    expect(consume).toHaveBeenCalledOnce()
  })

  it('rolls back the bridge and settings when the runtime listener cannot mount', () => {
    const bridge = makeBridge()
    const settings = { stop: vi.fn<() => void>() }
    const runtimeMessages = {
      addListener: vi.fn<(next: RuntimeMessageHandler) => void>(() => {
        throw new Error('context invalidated')
      }),
      removeListener: vi.fn<(next: RuntimeMessageHandler) => void>(),
    }

    expect(() =>
      startOverlayLifecycle({
        bridge: bridge.bridge,
        consumeMediaResponse: () => {},
        runtimeMessages,
        handleRuntimeMessage: () => {},
        settings,
      }),
    ).toThrow('context invalidated')

    expect(bridge.unsubscribe).toHaveBeenCalledOnce()
    expect(settings.stop).toHaveBeenCalledOnce()
    expect(runtimeMessages.removeListener).toHaveBeenCalledOnce()
  })

  it('rejects a bridge response from a stale SPA route before JSON ingestion', () => {
    let route = '/home'
    const ingest = vi.fn<(response: MediaResponse) => void>()
    const consume = makeRouteMediaResponseConsumer(() => route, ingest)
    const bridge = makeBridge()
    const runtime = makeRuntime()
    startOverlayLifecycle({
      bridge: bridge.bridge,
      consumeMediaResponse: consume,
      runtimeMessages: runtime.messages,
      handleRuntimeMessage: () => {},
      settings: { stop: () => {} },
    })

    bridge.emit(response('/previous'))
    route = '/next'
    bridge.emit(response('/next'))

    expect(ingest).toHaveBeenCalledExactlyOnceWith(response('/next'))
  })

  it('routes a verified transfer outcome to the affordance that owns it', () => {
    const onTransferOutcome = vi.fn<HandlerDeps['onTransferOutcome']>(() => true)
    const runtime = makeRuntime()
    startOverlayLifecycle({
      bridge: makeBridge().bridge,
      consumeMediaResponse: () => {},
      runtimeMessages: runtime.messages,
      handleRuntimeMessage: makeOverlayRuntimeMessageHandler(
        { onTransferOutcome } as unknown as HandlerDeps,
        { extensionId: 'ours', popupUrl: 'chrome-extension://ours/popup.html' },
      ),
      settings: { stop: () => {} },
    })

    expect(
      runtime.receive(
        { _tag: 'TransferOutcome', requestId: 'owned', outcome: 'complete', at: 1 },
        { id: 'ours' },
      ),
    ).toBe(false)
    expect(onTransferOutcome).toHaveBeenCalledExactlyOnceWith('owned', 'complete')

    runtime.receive(
      { _tag: 'TransferOutcome', requestId: 'forged', outcome: 'failed', at: 1 },
      { id: 'foreign' },
    )
    expect(onTransferOutcome).toHaveBeenCalledOnce()
  })
})
