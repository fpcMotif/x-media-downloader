import { describe, it, expect } from 'vitest'
import { Effect, type Layer } from 'effect'
import { outcomeEvent, queuedEvent, type SyncEvent } from './events'
import {
  append,
  decodeOutbox,
  emptyOutbox,
  isReady,
  markDrained,
  markFailed,
  takeBatch,
  type OutboxState,
} from './outbox'
import { makeConvexHttpPort, type ConvexPort } from './convex'
import { classifySyncError, describeSyncOk } from './status'
import { makeFetchServiceLive, type FetchService } from '../fetch-service'

/**
 * End-to-end metadata sync (ADR-0009): the REAL outbox reducer feeds the REAL
 * Convex HTTP port (an Effect over the shared `FetchService`, ADR-0017), backed by
 * a tiny in-memory deployment that reproduces `sync:recordEvents` idempotency
 * (dedupe by eventId). Proves the extension side drains exactly-once over an
 * at-least-once channel, backs off on failure, and resumes. Only `fetch` and the
 * clock are injected.
 */

type MediaItem = {
  id: string
  tweetId: string
  handle: string
  type: 'photo' | 'video' | 'gif'
  url: string
  ext: string
  index: number
}

const item = (over: Partial<MediaItem> = {}): MediaItem => ({
  id: 'req-1',
  tweetId: '100',
  handle: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/AAA',
  ext: 'jpg',
  index: 0,
  ...over,
})

/** A fake Convex deployment that mirrors `sync:recordEvents` semantics. Returns the
 *  fetch backing a `FetchService` layer, plus its store for assertions. */
function fakeDeployment(opts: { secret?: string; failTimes?: number; http503?: boolean } = {}) {
  const store = new Map<string, SyncEvent>()
  let remainingFailures = opts.failTimes ?? 0
  const requiredSecret = opts.secret
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    if (remainingFailures > 0) {
      remainingFailures -= 1
      if (opts.http503) return new Response('', { status: 503 })
      return new Response('', { status: 200 }) // network ok but...
    }
    const { args } = JSON.parse(String(init?.body)) as {
      args: { events: SyncEvent[]; secret?: string }
    }
    if (requiredSecret !== undefined && args.secret !== requiredSecret) {
      return new Response(
        JSON.stringify({
          status: 'error',
          errorMessage: 'unauthorized: bad or missing sync secret',
        }),
        { status: 200 },
      )
    }
    let inserted = 0
    for (const e of args.events) {
      if (store.has(e.eventId)) continue
      store.set(e.eventId, e)
      inserted += 1
    }
    return new Response(
      JSON.stringify({ status: 'success', value: { received: args.events.length, inserted } }),
      { status: 200 },
    )
  }) as unknown as typeof fetch
  return { layer: makeFetchServiceLive(fetchImpl), store }
}

const sendBatch = (
  port: ConvexPort,
  layer: Layer.Layer<FetchService>,
  events: unknown[],
  secret: string,
): Promise<unknown> =>
  Effect.runPromise(
    port.mutation('sync:recordEvents', { events, secret }).pipe(Effect.provide(layer)),
  )

/** One drain attempt against the port; updates outbox + returns what happened. */
async function drainOnce(
  state: OutboxState,
  port: ConvexPort,
  layer: Layer.Layer<FetchService>,
  secret: string,
  now: number,
): Promise<{ state: OutboxState; ok: boolean; error?: unknown }> {
  if (!isReady(state, now)) return { state, ok: false }
  const batch = takeBatch(state)
  if (batch.length === 0) return { state, ok: true }
  try {
    await sendBatch(port, layer, batch as unknown[], secret)
    return {
      state: markDrained(
        state,
        batch.map((e) => e.eventId),
      ),
      ok: true,
    }
  } catch (error) {
    return { state: markFailed(state, now), ok: false, error }
  }
}

const port = makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' })

describe('sync pipeline (e2e: events × outbox × convex port × idempotent backend)', () => {
  it('queues a download lifecycle and drains it exactly-once to the deployment', async () => {
    const i = item()
    let state = append(emptyOutbox, [queuedEvent(i, 'dev-1', 1_000)])
    state = append(state, [outcomeEvent(i.id, 'completed', 'dev-1', 2_000)])
    expect(state.pending).toHaveLength(2)

    const dep = fakeDeployment({ secret: 's3cret' })
    const r = await drainOnce(state, port, dep.layer, 's3cret', 3_000)
    expect(r.ok).toBe(true)
    expect(r.state.pending).toHaveLength(0)
    expect(dep.store.size).toBe(2)
    expect([...dep.store.keys()]).toEqual(['dev-1/req-1/queued', 'dev-1/req-1/completed'])
  })

  it('is exactly-once even if the same batch is delivered twice (at-least-once channel)', async () => {
    const i = item()
    const state = append(emptyOutbox, [queuedEvent(i, 'dev-1', 1_000)])
    const dep = fakeDeployment({ secret: 's' })

    const first = await drainOnce(state, port, dep.layer, 's', 2_000)
    await sendBatch(port, dep.layer, state.pending as unknown[], 's') // buggy re-send: no-op server-side
    expect(first.state.pending).toHaveLength(0)
    expect(dep.store.size).toBe(1) // deduped by eventId
  })

  it('backs off on a failed drain and resumes once ready', async () => {
    const i = item()
    const state = append(emptyOutbox, [queuedEvent(i, 'dev-1', 1_000)])
    const dep = fakeDeployment({ secret: 's', failTimes: 1, http503: true })

    const failed = await drainOnce(state, port, dep.layer, 's', 2_000)
    expect(failed.ok).toBe(false)
    expect(failed.state.consecutiveFailures).toBe(1)
    expect(failed.state.pending).toHaveLength(1) // not dropped
    expect(classifySyncError(failed.error)).toMatch(/try again shortly/)

    expect(isReady(failed.state, failed.state.nextAttemptAt - 1)).toBe(false)

    const ok = await drainOnce(failed.state, port, dep.layer, 's', failed.state.nextAttemptAt)
    expect(ok.ok).toBe(true)
    expect(ok.state.consecutiveFailures).toBe(0)
    expect(dep.store.size).toBe(1)
    expect(describeSyncOk(ok.state.pending.length)).toMatch(/working/)
  })

  it('surfaces an actionable message when the shared secret is rejected', async () => {
    const i = item()
    const state = append(emptyOutbox, [queuedEvent(i, 'dev-1', 1_000)])
    const dep = fakeDeployment({ secret: 'right' })

    const r = await drainOnce(state, port, dep.layer, 'WRONG', 2_000)
    expect(r.ok).toBe(false)
    expect(classifySyncError(r.error)).toMatch(/Secret rejected/)
    expect(dep.store.size).toBe(0)
  })

  it('round-trips the outbox through persistence (decode) without losing pending work', async () => {
    const i = item()
    const state = append(emptyOutbox, [queuedEvent(i, 'dev-1', 1_000)])
    const persisted = JSON.parse(JSON.stringify(state))
    const restored = decodeOutbox(persisted)
    expect(restored.pending).toHaveLength(1)

    const dep = fakeDeployment({ secret: 's' })
    const r = await drainOnce(restored, port, dep.layer, 's', 2_000)
    expect(r.ok).toBe(true)
    expect(dep.store.size).toBe(1)
  })
})
