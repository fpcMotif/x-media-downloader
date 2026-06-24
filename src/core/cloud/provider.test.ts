import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '../schema'
import { PROVIDERS, revokeViaRecipe } from './provider'
import { DROPBOX_HOST_PATTERNS, DROPBOX_OAUTH, GDRIVE_HOST_PATTERNS, GDRIVE_OAUTH } from './types'

const settingsWith = (patch: Partial<Settings>): Settings => patch as unknown as Settings

describe('PROVIDERS registry', () => {
  it('describes Google Drive as a record (oauth, host patterns, label, fields)', () => {
    const p = PROVIDERS.gdrive
    expect(p.id).toBe('gdrive')
    expect(p.label).toBe('Google Drive')
    expect(p.oauth).toBe(GDRIVE_OAUTH)
    expect(p.hostPatterns).toEqual([...GDRIVE_HOST_PATTERNS])
    expect(p.fields.clientId).toBe('gdriveClientId')
    expect(p.fields.accessToken).toBe('gdriveAccessToken')
    expect(p.fields.folderId).toBe('gdriveFolderId')
  })

  it('describes Dropbox as a record with no folderId field', () => {
    const p = PROVIDERS.dropbox
    expect(p.id).toBe('dropbox')
    expect(p.label).toBe('Dropbox')
    expect(p.oauth).toBe(DROPBOX_OAUTH)
    expect(p.hostPatterns).toEqual([...DROPBOX_HOST_PATTERNS])
    expect(p.fields.clientId).toBe('dropboxClientId')
    expect(p.fields.folderId).toBeUndefined()
  })
})

describe('revokeViaRecipe', () => {
  it('revokes the refresh token at the Google endpoint via a form body (gdrive)', async () => {
    const calls: { url: string; body: string }[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) })
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch
    await revokeViaRecipe(
      PROVIDERS.gdrive.revoke,
      { accessToken: 'AT', refreshToken: 'RT' },
      fetchImpl,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/revoke')
    expect(new URLSearchParams(calls[0]!.body).get('token')).toBe('RT')
  })

  it('revokes via the access token in an auth header at the Dropbox endpoint', async () => {
    let url = ''
    let auth = ''
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      url = String(u)
      auth = ((init?.headers ?? {}) as Record<string, string>)['authorization'] ?? ''
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch
    await revokeViaRecipe(
      PROVIDERS.dropbox.revoke,
      { accessToken: 'AT', refreshToken: '' },
      fetchImpl,
    )
    expect(url).toBe('https://api.dropboxapi.com/2/auth/token/revoke')
    expect(auth).toBe('Bearer AT')
  })

  it('no-ops when the recipe credential is empty', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch
    await revokeViaRecipe(
      PROVIDERS.gdrive.revoke,
      { accessToken: 'AT', refreshToken: '' },
      fetchImpl,
    )
    await revokeViaRecipe(
      PROVIDERS.dropbox.revoke,
      { accessToken: '', refreshToken: 'RT' },
      fetchImpl,
    )
    expect(called).toBe(false)
  })

  it('swallows network errors (best-effort; local clear proceeds regardless)', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    await expect(
      revokeViaRecipe(
        PROVIDERS.gdrive.revoke,
        { accessToken: 'AT', refreshToken: 'RT' },
        fetchImpl,
      ),
    ).resolves.toBeUndefined()
  })
})

describe('CloudProvider.makeDestination', () => {
  it('gdrive resolves + persists the root folder when none is stored, then builds a destination', async () => {
    // ensureRootFolder lists the folder; a found id short-circuits the create path.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ files: [{ id: 'root123' }] }), {
        status: 200,
      })) as unknown as typeof fetch
    const writeSettings = vi.fn<(patch: Partial<Settings>) => Promise<Settings>>(async (patch) =>
      settingsWith(patch),
    )
    const dest = await PROVIDERS.gdrive.makeDestination({
      accessToken: 'AT',
      fetchImpl,
      fetchSource: fetchImpl,
      settings: settingsWith({ gdriveFolderId: '' }),
      writeSettings,
      caches: { driveFolders: new Map() },
    })
    expect(writeSettings).toHaveBeenCalledWith({ gdriveFolderId: 'root123' })
    expect(typeof dest.upload).toBe('function')
  })

  it('gdrive skips root resolution when a folder id is already stored', async () => {
    const fetchImpl = vi.fn<() => Promise<Response>>(
      async () => new Response('', { status: 200 }),
    ) as unknown as typeof fetch
    const writeSettings = vi.fn<(patch: Partial<Settings>) => Promise<Settings>>(async (patch) =>
      settingsWith(patch),
    )
    const dest = await PROVIDERS.gdrive.makeDestination({
      accessToken: 'AT',
      fetchImpl,
      fetchSource: fetchImpl,
      settings: settingsWith({ gdriveFolderId: 'existing' }),
      writeSettings,
      caches: { driveFolders: new Map() },
    })
    expect(writeSettings).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(typeof dest.upload).toBe('function')
  })

  it('dropbox builds a destination without touching settings', async () => {
    const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch
    const writeSettings = vi.fn<(patch: Partial<Settings>) => Promise<Settings>>(async (patch) =>
      settingsWith(patch),
    )
    const dest = await PROVIDERS.dropbox.makeDestination({
      accessToken: 'AT',
      fetchImpl,
      fetchSource: fetchImpl,
      settings: settingsWith({}),
      writeSettings,
      caches: { driveFolders: new Map() },
    })
    expect(writeSettings).not.toHaveBeenCalled()
    expect(typeof dest.upload).toBe('function')
  })
})
