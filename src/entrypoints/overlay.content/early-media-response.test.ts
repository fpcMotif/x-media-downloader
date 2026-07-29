import { describe, expect, it } from 'vitest'
import {
  MAX_EARLY_MEDIA_RESPONSE_BYTES,
  MAX_EARLY_MEDIA_RESPONSES,
  installEarlyMediaResponseBridge,
  makeEarlyMediaResponseBridge,
} from './early-media-response'

const emit = (target: EventTarget, path: string, body = '{}', route = '/route'): void => {
  target.dispatchEvent(new CustomEvent('xmd:media-response', { detail: { path, body, route } }))
}

const drain = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const noop = (): void => {}

describe('early media-response bridge', () => {
  it('delivers early and live tee events asynchronously exactly once', async () => {
    const target = new EventTarget()
    const bridge = makeEarlyMediaResponseBridge(target)
    const received: string[] = []

    emit(target, '/before-ui')
    const stop = bridge.subscribe((response) => received.push(response.path))
    emit(target, '/after-ui')

    expect(received).toEqual([])
    await drain()
    expect(received).toEqual(['/before-ui', '/after-ui'])
    stop()
  })

  it('does not schedule a self-resuming drain for an empty subscription', () => {
    const tasks: Array<() => void> = []
    const bridge = makeEarlyMediaResponseBridge(new EventTarget(), (task) => tasks.push(task))

    bridge.subscribe(() => {})
    expect(tasks).toEqual([])
  })

  it('stops scheduling once a bounded queued batch drains', () => {
    const target = new EventTarget()
    const tasks: Array<() => void> = []
    const bridge = makeEarlyMediaResponseBridge(target, (task) => tasks.push(task))
    const received: string[] = []
    bridge.subscribe((response) => received.push(response.path))

    emit(target, '/one')
    expect(tasks).toHaveLength(1)
    tasks.shift()?.()

    expect(received).toEqual(['/one'])
    expect(tasks).toEqual([])
  })

  it('keeps one aggregate-byte and count cap before a subscriber can parse a response', async () => {
    const target = new EventTarget()
    const bridge = makeEarlyMediaResponseBridge(target)
    const received: string[] = []

    for (let index = 0; index < MAX_EARLY_MEDIA_RESPONSES + 1; index += 1)
      emit(target, `/count-${index}`)
    bridge.subscribe((response) => received.push(response.path))

    await drain()
    expect(received).toEqual(
      Array.from({ length: MAX_EARLY_MEDIA_RESPONSES }, (_, index) => `/count-${index}`),
    )

    const byteTarget = new EventTarget()
    const byteBridge = makeEarlyMediaResponseBridge(byteTarget)
    const firstBytes = Math.floor(MAX_EARLY_MEDIA_RESPONSE_BYTES / 2)
    emit(byteTarget, '/fits', 'a'.repeat(firstBytes))
    emit(byteTarget, '/over-budget', 'a'.repeat(MAX_EARLY_MEDIA_RESPONSE_BYTES - firstBytes + 1))
    byteBridge.subscribe((response) => received.push(response.path))

    await drain()
    expect(received).toContain('/fits')
    expect(received).not.toContain('/over-budget')

    const liveTarget = new EventTarget()
    const liveBridge = makeEarlyMediaResponseBridge(liveTarget)
    const liveReceived: string[] = []
    liveBridge.subscribe((response) => liveReceived.push(response.path))
    for (let index = 0; index < MAX_EARLY_MEDIA_RESPONSES + 1; index += 1)
      emit(liveTarget, `/live-${index}`)

    await drain()
    expect(liveReceived).toEqual(
      Array.from({ length: MAX_EARLY_MEDIA_RESPONSES }, (_, index) => `/live-${index}`),
    )
  })

  it('retains each small response up to the concurrent tee-count cap', async () => {
    const target = new EventTarget()
    const bridge = makeEarlyMediaResponseBridge(target)
    const received: string[] = []

    for (let index = 0; index < MAX_EARLY_MEDIA_RESPONSES; index += 1)
      emit(target, `/capture-${index}`)
    bridge.subscribe((response) => received.push(response.path))

    await drain()
    expect(received).toEqual(
      Array.from({ length: MAX_EARLY_MEDIA_RESPONSES }, (_, index) => `/capture-${index}`),
    )
  })

  it('does not let an old overlay subscription receive or stop a later route subscriber', async () => {
    const target = new EventTarget()
    const bridge = makeEarlyMediaResponseBridge(target)
    const first: string[] = []
    const second: string[] = []
    const stopFirst = bridge.subscribe((response) => first.push(response.path))

    emit(target, '/first')
    await drain()
    const stopSecond = bridge.subscribe((response) => second.push(response.path))
    stopFirst()
    emit(target, '/second')
    await drain()
    stopSecond()
    emit(target, '/between-overlays')
    bridge.subscribe((response) => second.push(response.path))
    await drain()

    expect(first).toEqual(['/first'])
    expect(second).toEqual(['/second', '/between-overlays'])
  })

  it('defers reentrant events to a later drain and never calls an unsubscribed listener', async () => {
    const target = new EventTarget()
    const bridge = makeEarlyMediaResponseBridge(target)
    const first: string[] = []
    const second: string[] = []
    let stopFirst = noop
    stopFirst = bridge.subscribe((response) => {
      first.push(response.path)
      if (response.path === '/first') {
        emit(target, '/reentrant')
        stopFirst()
      }
    })

    emit(target, '/first')
    await Promise.resolve()
    expect(first).toEqual(['/first'])

    bridge.subscribe((response) => second.push(response.path))
    await drain()
    expect(first).toEqual(['/first'])
    expect(second).toEqual(['/reentrant'])
  })

  it('shares its document-start listener with later overlay startup', () => {
    const target = new EventTarget()

    expect(installEarlyMediaResponseBridge(target)).toBe(installEarlyMediaResponseBridge(target))
  })
})
