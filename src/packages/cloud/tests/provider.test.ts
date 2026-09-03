import { describe, expect, it } from 'vitest'
import { PROVIDERS, revokeViaRecipe } from '../provider'
import { DROPBOX_HOST_PATTERNS, DROPBOX_OAUTH, GDRIVE_HOST_PATTERNS, GDRIVE_OAUTH } from '../types'
import { fetchStub } from '../lib/fetch-stub'

/** `RequestInit.body` is `BodyInit | null | undefined`; the recipe under test always
 *  posts a URL-encoded string body, so narrow to that before recording the call. */
const isStringBody = (body: BodyInit | null | undefined): body is string => typeof body === 'string'

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
    const fetchImpl = fetchStub(async (url, init) => {
      const body = init?.body
      if (!isStringBody(body)) throw new Error('expected a string request body')
      calls.push({ url, body })
      return new Response('', { status: 200 })
    })
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
    const fetchImpl = fetchStub(async (u, init) => {
      url = u
      // `Headers` normalizes every `HeadersInit` shape `authHeader()` could ever
      // hand it, so reading the header needs no cast at all.
      auth = new Headers(init?.headers).get('authorization') ?? ''
      return new Response('', { status: 200 })
    })
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
    const fetchImpl = fetchStub(async () => {
      called = true
      return new Response('', { status: 200 })
    })
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
    const fetchImpl = fetchStub(async () => {
      throw new Error('offline')
    })
    await expect(
      revokeViaRecipe(
        PROVIDERS.gdrive.revoke,
        { accessToken: 'AT', refreshToken: 'RT' },
        fetchImpl,
      ),
    ).resolves.toBeUndefined()
  })
})
