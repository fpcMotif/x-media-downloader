import { describe, expect, it, vi } from 'vitest'
import { makePopupActions, type PopupActionDeps, type PopupIntent } from './popup-actions'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const makeHarness = (over: Partial<PopupActionDeps> & { readonly reply?: unknown } = {}) => {
  let now = 100
  const timers: Array<{ readonly task: () => void; cancelled: boolean }> = []
  const sendMessage = vi.fn<PopupActionDeps['tabs']['sendMessage']>(async () => over.reply)
  const markDone = vi.fn<PopupActionDeps['markDone']>(async () => {})
  const deps: PopupActionDeps = {
    tabs: {
      query: async () => [{ id: 7, url: 'https://x.com/user/likes' }],
      sendMessage,
      ...over.tabs,
    },
    clock: {
      now: () => now,
      after: (_ms, task) => {
        const timer = { task, cancelled: false }
        timers.push(timer)
        return () => {
          timer.cancelled = true
        }
      },
      ...over.clock,
    },
    tabContext: () => 'x-list',
    markDone,
    ...over,
  }
  return {
    actions: makePopupActions(deps),
    sendMessage,
    markDone,
    expire: () => {
      now += 6000
      for (const timer of timers) if (!timer.cancelled) timer.task()
    },
  }
}

describe('makePopupActions', () => {
  it.each([
    {
      intent: { kind: 'download-page', releaseAfter: true } as const,
      tag: 'DrainPageRequest',
      reply: { _tag: 'DrainPageResponse', ok: true, count: 3 },
      work: 3,
    },
    {
      intent: { kind: 'sweep-list', releaseAfter: false } as const,
      tag: 'SweepPageRequest',
      reply: { _tag: 'SweepPageResponse', ok: true, queued: 2, skipped: 1 },
      work: 2,
    },
  ])('owns $intent.kind and sends its exact request', async ({ intent, tag, reply, work }) => {
    const h = makeHarness({ reply })

    await expect(h.actions.run(intent)).resolves.toEqual({
      kind: 'completed',
      action: intent.kind,
      work,
    })

    expect(h.sendMessage).toHaveBeenCalledWith(7, { _tag: tag })
    expect(h.actions.inspect().notices.download?.kind).toBe('result')
    expect(h.markDone).toHaveBeenCalledOnce()
  })

  it('gates list sweep before sending', async () => {
    const h = makeHarness({
      tabContext: () => 'x',
      reply: { _tag: 'SweepPageResponse', ok: true, queued: 1, skipped: 0 },
    })

    await expect(h.actions.run({ kind: 'sweep-list', releaseAfter: false })).resolves.toEqual({
      kind: 'inapplicable',
      action: 'sweep-list',
    })
    expect(h.sendMessage).not.toHaveBeenCalled()
  })

  it.each([
    null,
    { _tag: 'DrainPageResponse', ok: true, count: -1 },
    { _tag: 'DrainPageResponse', ok: true, count: 1, extra: true },
    { _tag: 'SweepPageResponse', ok: false, queued: 1, skipped: 0, reason: 'unauthorized' },
  ])('rejects malformed or impossible replies %#', async (reply) => {
    const h = makeHarness({ reply })
    const intent: PopupIntent =
      typeof reply === 'object' &&
      reply !== null &&
      Reflect.get(reply, '_tag') === 'SweepPageResponse'
        ? { kind: 'sweep-list', releaseAfter: false }
        : { kind: 'download-page', releaseAfter: false }

    await expect(h.actions.run(intent)).resolves.toMatchObject({
      kind: 'failed',
      error: 'invalid-response',
    })
    expect(h.actions.inspect().notices.download).toMatchObject({
      kind: 'actionable-error',
      expiresAt: null,
    })
  })

  it('reports committed Sweep work when a later batch loses context', async () => {
    const h = makeHarness({
      reply: {
        _tag: 'SweepPageResponse',
        ok: false,
        queued: 1,
        skipped: 1,
        reason: 'context',
      },
    })

    await expect(h.actions.run({ kind: 'sweep-list', releaseAfter: true })).resolves.toEqual({
      kind: 'partial',
      action: 'sweep-list',
      work: 1,
      error: 'stale-context',
    })
    expect(h.actions.inspect().notices.download).toMatchObject({
      kind: 'actionable-error',
      expiresAt: null,
    })
    expect(h.actions.inspect().notices.download?.text).toContain('Queued 1 post')
  })

  it('allows only one page action at a time', async () => {
    const pending = deferred<unknown>()
    const h = makeHarness({
      tabs: {
        query: async () => [{ id: 7, url: 'https://x.com/user/likes' }],
        sendMessage: vi.fn<PopupActionDeps['tabs']['sendMessage']>(() => pending.promise),
      },
    })
    const first = h.actions.run({ kind: 'download-page', releaseAfter: false })

    await expect(h.actions.run({ kind: 'sweep-list', releaseAfter: false })).resolves.toEqual({
      kind: 'busy',
      action: 'sweep-list',
      active: 'download-page',
    })

    pending.resolve({ _tag: 'DrainPageResponse', ok: true, count: 1 })
    await first
    expect(h.actions.inspect().active).toBeNull()
  })

  it('expires result notices but retains actionable errors', async () => {
    const success = makeHarness({
      reply: { _tag: 'DrainPageResponse', ok: true, count: 1 },
    })
    await success.actions.run({ kind: 'download-page', releaseAfter: false })
    success.expire()
    expect(success.actions.inspect().notices.download).toBeNull()

    const failure = makeHarness({
      tabs: {
        query: async () => {
          throw new Error('tabs unavailable')
        },
        sendMessage: async () => undefined,
      },
    })
    await failure.actions.run({ kind: 'download-page', releaseAfter: false })
    failure.expire()
    expect(failure.actions.inspect().notices.download?.kind).toBe('actionable-error')
  })

  it('disposal clears state and ignores later work', async () => {
    const h = makeHarness({ reply: { _tag: 'DrainPageResponse', ok: true, count: 1 } })
    h.actions.dispose()

    await expect(h.actions.run({ kind: 'download-page', releaseAfter: false })).resolves.toEqual({
      kind: 'inapplicable',
      action: 'download-page',
    })
    expect(h.sendMessage).not.toHaveBeenCalled()
  })
})
