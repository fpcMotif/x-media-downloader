import { convexTest } from 'convex-test'
import { makeFunctionReference } from 'convex/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import schema from './schema'
import type { Doc, Id } from './_generated/dataModel'

const claim = makeFunctionReference<'mutation', { id: Id<'relay_jobs'> }, Doc<'relay_jobs'> | null>(
  'relay:claim',
)
const checkpoint = makeFunctionReference<'mutation'>('relay:checkpoint')
const progress = { offset: 0, sourceBytes: 0, uploadedBytes: 0, peakRss: 0 }

const modules = import.meta.glob('./**/*.ts')
const submit = makeFunctionReference<'mutation'>('relay:submit')
const status = makeFunctionReference<'query'>('relay:status')
const control = makeFunctionReference<'mutation'>('relay:control')
const secret = 'relay-test-secret'
const input = {
  secret,
  deviceId: 'device',
  mediaId: 'image',
  sourceUrl: 'https://pbs.twimg.com/media/image.jpg',
  path: 'twitter/image.jpg',
  contentType: 'image/jpeg',
  budgetDay: '2026-09-20',
  estimatedBytes: 4,
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('SYNC_SHARED_SECRET', secret)
  vi.stubEnv('RELAY_ENABLED', 'true')
  vi.stubEnv('RELAY_DRIVE_CLIENT_ID', 'test-client')
  vi.stubEnv('RELAY_DRIVE_CLIENT_SECRET', 'test-secret')
  vi.stubEnv('RELAY_DRIVE_REFRESH_TOKEN', 'test-refresh')
  vi.stubEnv('RELAY_DRIVE_FOLDER_ID', 'test-folder')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it('authenticates durable idempotent acceptance and keeps sessions private', async () => {
  const t = convexTest(schema, modules)
  await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
  await expect(t.mutation(submit, { ...input, secret: 'wrong' })).rejects.toThrow()
  const first = await t.mutation(submit, input)
  const duplicate = await t.mutation(submit, input)
  expect(first).toMatchObject({ created: true })
  expect(duplicate).toEqual({ ...first, created: false })
  const budget = makeFunctionReference<'query'>('relay:budget')
  expect(await t.query(budget, { secret, deviceId: input.deviceId, day: input.budgetDay })).toEqual(
    { bytes: 4, count: 1 },
  )
  await expect(
    t.query(budget, { secret: 'wrong', deviceId: input.deviceId, day: input.budgetDay }),
  ).rejects.toThrow('bad or missing sync secret')
  const result = await t.query(status, { secret, deviceId: input.deviceId, mediaIds: ['image'] })
  expect(result).toEqual([
    expect.objectContaining({
      mediaId: 'image',
      status: 'queued',
      execution: 'convex',
      provider: 'gdrive',
    }),
  ])
  expect(JSON.stringify(result)).not.toMatch(/session|refresh|clientSecret/)
  expect(await t.run((ctx) => ctx.db.query('upload_jobs').collect())).toEqual([])
})

it('drains accepted jobs during provider pause and fences expired workers globally', async () => {
  const t = convexTest(schema, modules)
  await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
  const first = await t.mutation(submit, input)
  const second = await t.mutation(submit, { ...input, mediaId: 'second' })
  await t.mutation(control, { secret, enabled: true, accepting: false, connected: true })
  const owner = await t.mutation(claim, { id: first.id })
  expect(owner?.status).toBe('uploading')
  expect(await t.mutation(claim, { id: second.id })).toBeNull()
  vi.setSystemTime(Date.now() + 11 * 60 * 1000 + 1)
  const successor = await t.mutation(claim, { id: second.id })
  expect(successor?.fence).toBeGreaterThan(owner?.fence ?? 0)
  expect(
    await t.mutation(checkpoint, {
      id: first.id,
      fence: owner?.fence,
      progress,
      release: true,
      completed: true,
    }),
  ).toBe(false)
})

it('master disable prevents claims, while disconnect permanently revokes accepted authorization', async () => {
  const t = convexTest(schema, modules)
  await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
  const accepted = await t.mutation(submit, input)
  await t.mutation(control, { secret, enabled: false, accepting: true, connected: true })
  expect(await t.mutation(claim, { id: accepted.id })).toBeNull()
  await t.mutation(control, { secret, enabled: true, accepting: true, connected: false })
  await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
  expect(await t.mutation(claim, { id: accepted.id })).toBeNull()
  expect(await t.query(status, { secret, deviceId: 'device', mediaIds: ['image'] })).toEqual([
    expect.objectContaining({ status: 'failed', error: 'Backend Drive authorization revoked' }),
  ])
})

it('deployment disable stops claims and authorization at the next request boundary', async () => {
  const t = convexTest(schema, modules)
  await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
  const first = await t.mutation(submit, input)
  const owner = await t.mutation(claim, { id: first.id })
  const second = await t.mutation(submit, { ...input, mediaId: 'second' })
  vi.stubEnv('RELAY_ENABLED', 'false')
  expect(
    await t.query(makeFunctionReference<'query'>('relay:authorized'), {
      id: first.id,
      fence: owner?.fence,
    }),
  ).toBe(false)
  vi.setSystemTime(Date.now() + 11 * 60 * 1000 + 1)
  expect(await t.mutation(claim, { id: second.id })).toBeNull()
})

it('disconnect fences an in-flight completion even after reconnect', async () => {
  const t = convexTest(schema, modules)
  await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
  const accepted = await t.mutation(submit, input)
  const owner = await t.mutation(claim, { id: accepted.id })
  await t.mutation(control, { secret, enabled: false, accepting: false, connected: false })
  await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
  expect(
    await t.mutation(checkpoint, {
      id: accepted.id,
      fence: owner?.fence,
      progress,
      release: true,
      completed: true,
    }),
  ).toBe(false)
  expect(await t.query(status, { secret, deviceId: 'device', mediaIds: ['image'] })).not.toEqual([
    expect.objectContaining({ status: 'completed' }),
  ])
})

it('requires a positive byte reservation and caps transfer at the charged reservation', async () => {
  const t = convexTest(schema, modules)
  await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
  await expect(t.mutation(submit, { ...input, estimatedBytes: 0 })).rejects.toThrow(/budget/)
  const accepted = await t.mutation(submit, input)
  expect(await t.run((ctx) => ctx.db.get(accepted.id))).toMatchObject({ maxBytes: 4 })
})

it('caps failed attempts and ignores duplicate completion delivery', async () => {
  const t = convexTest(schema, modules)
  await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
  const accepted = await t.mutation(submit, input)
  for (let attempt = 0; attempt < 3; attempt++) {
    const owner = await t.mutation(claim, { id: accepted.id })
    expect(owner).not.toBeNull()
    expect(
      await t.mutation(checkpoint, {
        id: accepted.id,
        fence: owner?.fence,
        progress,
        release: true,
        completed: false,
        error: 'Transient provider failure',
      }),
    ).toBe(true)
    vi.setSystemTime(Date.now() + 30_000)
  }
  expect(await t.mutation(claim, { id: accepted.id })).toBeNull()
  expect(await t.query(status, { secret, deviceId: 'device', mediaIds: ['image'] })).toEqual([
    expect.objectContaining({ status: 'failed', failures: 3 }),
  ])
  const next = await t.mutation(submit, { ...input, mediaId: 'complete' })
  const owner = await t.mutation(claim, { id: next.id })
  const completion = {
    id: next.id,
    fence: owner?.fence,
    progress: { ...progress, fileId: 'drive-id', offset: 4, total: 4 },
    release: true,
    completed: true,
  }
  expect(await t.mutation(checkpoint, completion)).toBe(true)
  expect(await t.mutation(checkpoint, completion)).toBe(false)
})

it('rejects unsafe URLs and incomplete setup without accepting a job', async () => {
  const t = convexTest(schema, modules)
  await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
  await expect(
    t.mutation(submit, { ...input, sourceUrl: 'https://127.0.0.1/private' }),
  ).rejects.toThrow()
  vi.stubEnv('RELAY_DRIVE_REFRESH_TOKEN', '')
  await expect(t.mutation(submit, input)).rejects.toThrow(/configuration/)
  expect(await t.run((ctx) => ctx.db.query('relay_jobs').collect())).toEqual([])
})

it('preserves accepted status while disabled and rejects conflicting duplicate metadata', async () => {
  const t = convexTest(schema, modules)
  await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
  await t.mutation(submit, input)
  await expect(t.mutation(submit, { ...input, path: 'other.jpg' })).rejects.toThrow(/conflict/)
  await t.mutation(control, { secret, enabled: true, accepting: false, connected: true })
  vi.stubEnv('RELAY_ENABLED', 'false')
  expect(await t.query(status, { secret, deviceId: 'device', mediaIds: ['image'] })).toHaveLength(1)
  expect(await t.mutation(submit, input)).toMatchObject({ created: false })
  await expect(t.mutation(submit, { ...input, mediaId: 'new' })).rejects.toThrow()
})

it('authenticates and durably accepts bulk item submissions in a single mutation', async () => {
  const t = convexTest(schema, modules)
  const submitBatch = makeFunctionReference<'mutation'>('relay:submitBatch')
  await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
  const { secret: _s, ...baseItem } = input
  const items = [
    { ...baseItem, mediaId: 'batch-1', path: 'twitter/item1.jpg', estimatedBytes: 100 },
    { ...baseItem, mediaId: 'batch-2', path: 'twitter/item2.jpg', estimatedBytes: 200 },
    { ...baseItem, mediaId: 'batch-3', path: 'twitter/item3.jpg', estimatedBytes: 300 },
  ]
  await expect(t.mutation(submitBatch, { secret: 'wrong', items })).rejects.toThrow()
  const results = await t.mutation(submitBatch, { secret, items })
  expect(results).toHaveLength(3)
  expect(results).toEqual([
    expect.objectContaining({ mediaId: 'batch-1', created: true }),
    expect.objectContaining({ mediaId: 'batch-2', created: true }),
    expect.objectContaining({ mediaId: 'batch-3', created: true }),
  ])
  const dupeResults = await t.mutation(submitBatch, { secret, items })
  expect(dupeResults).toEqual([
    expect.objectContaining({ mediaId: 'batch-1', created: false }),
    expect.objectContaining({ mediaId: 'batch-2', created: false }),
    expect.objectContaining({ mediaId: 'batch-3', created: false }),
  ])
  const budget = makeFunctionReference<'query'>('relay:budget')
  expect(await t.query(budget, { secret, deviceId: input.deviceId, day: input.budgetDay })).toEqual(
    { bytes: 600, count: 3 },
  )
})
