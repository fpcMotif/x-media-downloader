import { describe, it, expect, vi } from 'vitest'
import { buildSyncRequest, makeRemoteLedgerPort } from './remote'
import type { RemoteSyncConfig, SavedEntryPayload } from './remote'

const entries: ReadonlyArray<SavedEntryPayload> = [
  { key: 'pbs.twimg.com/media/AbC', tweetId: '123', source: 'bookmarks', savedAt: 100 },
  { key: 'tweet:123:record', tweetId: '123', source: 'bookmarks', savedAt: 100 },
]

const cfg = (over: Partial<RemoteSyncConfig> = {}): RemoteSyncConfig => ({
  kind: 'cloudflare',
  url: 'https://worker.example.dev',
  secret: 'sk-1',
  ...over,
})

describe('buildSyncRequest — null guards', () => {
  it('returns null when kind is off', () => {
    expect(buildSyncRequest(cfg({ kind: 'off' }), entries)).toBeNull()
  })

  it('returns null when the url is blank', () => {
    expect(buildSyncRequest(cfg({ url: '' }), entries)).toBeNull()
    expect(buildSyncRequest(cfg({ url: '   ' }), entries)).toBeNull()
  })

  it('returns null when there are no entries', () => {
    expect(buildSyncRequest(cfg(), [])).toBeNull()
  })
})

describe('buildSyncRequest — cloudflare', () => {
  it('POSTs {base}/saved with a Bearer secret and body {entries}', () => {
    const req = buildSyncRequest(cfg(), entries)!
    expect(req).not.toBeNull()
    expect(req.url).toBe('https://worker.example.dev/saved')
    const auth = req.headers['authorization'] ?? req.headers['Authorization']
    expect(auth).toBe('Bearer sk-1')
    expect(JSON.parse(req.body)).toEqual({ entries })
  })

  it('strips exactly one trailing slash from the base url', () => {
    const req = buildSyncRequest(cfg({ url: 'https://worker.example.dev/' }), entries)!
    expect(req.url).toBe('https://worker.example.dev/saved')
  })

  it('omits the authorization header when the secret is empty', () => {
    const req = buildSyncRequest(cfg({ secret: '' }), entries)!
    expect('authorization' in req.headers).toBe(false)
    expect('Authorization' in req.headers).toBe(false)
  })
})

describe('buildSyncRequest — convex', () => {
  it('POSTs {base}/api/mutation with the recordSaved envelope and secret in args', () => {
    const req = buildSyncRequest(
      cfg({ kind: 'convex', url: 'https://my.convex.cloud', secret: 's3cret' }),
      entries,
    )!
    expect(req.url).toBe('https://my.convex.cloud/api/mutation')
    const body = JSON.parse(req.body)
    expect(body.path).toBe('archive:recordSaved')
    expect(body.format).toBe('json')
    expect(body.args).toEqual({ entries, secret: 's3cret' })
  })

  it('omits the secret from args when it is empty (args = {entries})', () => {
    const req = buildSyncRequest(
      cfg({ kind: 'convex', url: 'https://my.convex.cloud/', secret: '' }),
      entries,
    )!
    expect(req.url).toBe('https://my.convex.cloud/api/mutation')
    const body = JSON.parse(req.body)
    expect(body.args).toEqual({ entries })
    expect('secret' in body.args).toBe(false)
  })

  it('does not put the convex secret in an authorization header', () => {
    const req = buildSyncRequest(
      cfg({ kind: 'convex', url: 'https://my.convex.cloud', secret: 's3cret' }),
      entries,
    )!
    expect('authorization' in req.headers).toBe(false)
    expect('Authorization' in req.headers).toBe(false)
  })
})

describe('makeRemoteLedgerPort.record — fire-and-forget', () => {
  it('POSTs the built request when sync is configured', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({ ok: true, status: 200 } as Response)
    const port = makeRemoteLedgerPort(cfg(), fetchImpl as unknown as typeof fetch)
    await port.record(entries)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://worker.example.dev/saved')
    expect((init as RequestInit).method).toBe('POST')
  })

  it('does not call fetch when there is nothing to sync (sync off)', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const port = makeRemoteLedgerPort(cfg({ kind: 'off' }), fetchImpl as unknown as typeof fetch)
    await expect(port.record(entries)).resolves.toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not call fetch for an empty entries batch', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const port = makeRemoteLedgerPort(cfg(), fetchImpl as unknown as typeof fetch)
    await expect(port.record([])).resolves.toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('swallows a rejecting fetch (resolves void, never throws)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
    const port = makeRemoteLedgerPort(cfg(), fetchImpl as unknown as typeof fetch)
    await expect(port.record(entries)).resolves.toBeUndefined()
  })

  it('swallows a non-OK response (resolves void, never throws)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: false, status: 500 } as Response)
    const port = makeRemoteLedgerPort(cfg(), fetchImpl as unknown as typeof fetch)
    await expect(port.record(entries)).resolves.toBeUndefined()
  })
})
