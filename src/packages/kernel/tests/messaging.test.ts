import { describe, it, expect } from 'vitest'
import { isContextInvalidatedError, safeSend, expectReply } from '../messaging'

describe('isContextInvalidatedError', () => {
  it('recognizes the dead-context wordings that mean "reload the tab"', () => {
    for (const msg of [
      'Extension context invalidated.',
      'Error: Extension context invalidated.',
      'The message port closed before a response was received.',
      'Could not establish connection. Receiving end does not exist.',
      'chrome.runtime must be loaded in a web extension environment.',
      // V8 wording once `browser.runtime` / `browser` itself is gone (teardown path).
      "Cannot read properties of undefined (reading 'sendMessage')",
      "Cannot read properties of null (reading 'runtime')",
    ]) {
      expect(isContextInvalidatedError(new Error(msg))).toBe(true)
    }
  })

  it('does NOT misclassify unrelated errors as a dead context', () => {
    // The reviewer's concern: an unrelated TypeError must not read as "refresh the
    // page". The regex pins the property to sendMessage/runtime, so a different
    // missing property — or any ordinary failure — stays a real error.
    for (const msg of [
      'Network request failed',
      'aria2 RPC returned 500',
      "Cannot read properties of undefined (reading 'foo')",
      "Cannot read properties of null (reading 'downloads')",
      'Invalid media item',
    ]) {
      expect(isContextInvalidatedError(new Error(msg))).toBe(false)
    }
  })

  it('handles a thrown string without throwing', () => {
    expect(isContextInvalidatedError('Extension context invalidated')).toBe(true)
    expect(isContextInvalidatedError('just a string')).toBe(false)
  })
})

describe('safeSend', () => {
  it('returns the reply on success', async () => {
    const out = await safeSend(() => Promise.resolve({ completed: 1, total: 1 }))
    expect(out).toEqual({ status: 'ok', reply: { completed: 1, total: 1 } })
  })

  it('captures a SYNCHRONOUS dead-context throw (the reason it takes a thunk)', async () => {
    const out = await safeSend(() => {
      throw new Error('Extension context invalidated')
    })
    expect(out).toEqual({ status: 'context-invalidated' })
  })

  it('captures an ASYNC dead-context rejection', async () => {
    const out = await safeSend(() => Promise.reject(new Error('message port closed')))
    expect(out).toEqual({ status: 'context-invalidated' })
  })

  it('passes a genuine failure through as an error outcome', async () => {
    const error = new Error('aria2 RPC returned 500')
    expect(await safeSend(() => Promise.reject(error))).toEqual({ status: 'error', error })
    const thrown = new Error('boom')
    expect(
      await safeSend(() => {
        throw thrown
      }),
    ).toEqual({ status: 'error', error: thrown })
  })
})

describe('expectReply', () => {
  it('reclassifies an "ok" outcome with an undefined reply as "unclaimed"', () => {
    // The guard-drop / decode-fail signature: the background's onMessage listener
    // returned `false` without ever calling `sendResponse`, so Chrome resolves the
    // sender's promise with `reply: undefined` — structurally identical to a
    // legitimate handler that resolved with nothing, until this reclassifies it.
    expect(expectReply({ status: 'ok', reply: undefined })).toEqual({ status: 'unclaimed' })
  })

  it('passes an "ok" outcome with a defined reply through unchanged', () => {
    const reply = { completed: 1, total: 1 }
    expect(expectReply({ status: 'ok', reply })).toEqual({ status: 'ok', reply })
  })

  it('passes a "context-invalidated" outcome through unchanged', () => {
    expect(expectReply({ status: 'context-invalidated' })).toEqual({
      status: 'context-invalidated',
    })
  })

  it('passes an "error" outcome through unchanged', () => {
    const error = new Error('boom')
    expect(expectReply({ status: 'error', error })).toEqual({ status: 'error', error })
  })
})
