import { describe, it, expect } from 'vitest'
import { errText, authHeader, httpErr } from './http'

describe('http utilities', () => {
  describe('authHeader', () => {
    it('returns a bearer authorization header', () => {
      expect(authHeader('my-token')).toEqual({
        authorization: 'Bearer my-token',
      })
    })
  })

  describe('errText', () => {
    it('resolves with the text from the response', async () => {
      const res = {
        text: () => Promise.resolve('server error message'),
      } as unknown as Response

      await expect(errText(res)).resolves.toBe('server error message')
    })

    it('resolves with an empty string if text() rejects', async () => {
      const res = {
        text: () => Promise.reject(new Error('connection dropped mid-read')),
      } as unknown as Response

      await expect(errText(res)).resolves.toBe('')
    })
  })

  describe('httpErr', () => {
    it('formats an error without a body', () => {
      const res = { status: 404 } as unknown as Response
      expect(httpErr('drive', res, '')).toBe('drive HTTP 404')
    })

    it('formats an error with a short body', () => {
      const res = { status: 400 } as unknown as Response
      expect(httpErr('dropbox', res, 'bad request')).toBe('dropbox HTTP 400: bad request')
    })

    it('truncates a long body to 200 characters', () => {
      const res = { status: 500 } as unknown as Response
      const longBody = 'A'.repeat(300)
      const err = httpErr('provider', res, longBody)
      expect(err).toBe(`provider HTTP 500: ${'A'.repeat(200)}`)
      expect(err.length).toBe(19 + 200) // 'provider HTTP 500: ' + 200 'A's
    })
  })
})
