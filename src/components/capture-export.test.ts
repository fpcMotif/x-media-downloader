import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { collectJsonlExport, runJsonlExport, type RequestExportChunk } from './capture-export'

describe('collectJsonlExport', () => {
  it('collects chunks in order until next is null', async () => {
    const calls: Array<string | undefined> = []
    const requestChunk: RequestExportChunk = async (after) => {
      calls.push(after)
      if (after === undefined) {
        return Option.some({ lines: 'a', next: '1', filename: 'f.jsonl' })
      }
      return Option.some({ lines: 'b', next: null, filename: 'f.jsonl' })
    }

    const result = await collectJsonlExport(requestChunk)

    expect(result).toEqual({ kind: 'ready', filename: 'f.jsonl', chunks: ['a', 'b'] })
    expect(calls).toEqual([undefined, '1'])
  })

  it('reports an empty archive as empty', async () => {
    const requestChunk: RequestExportChunk = async () => Option.some({ lines: '', next: null })

    expect(await collectJsonlExport(requestChunk)).toEqual({ kind: 'empty' })
  })

  it('reports a missing reply as unreachable', async () => {
    let n = 0
    const requestChunk: RequestExportChunk = async () => {
      n += 1
      return n === 1 ? Option.some({ lines: 'a', next: '1' }) : Option.none()
    }

    expect(await collectJsonlExport(requestChunk)).toEqual({ kind: 'unreachable' })
  })

  it('reports a throwing sender as unreachable', async () => {
    const requestChunk: RequestExportChunk = async () => {
      throw new Error('Extension context invalidated')
    }

    expect(await collectJsonlExport(requestChunk)).toEqual({ kind: 'unreachable' })
  })

  it('falls back to xharvest.jsonl when filename is absent', async () => {
    const requestChunk: RequestExportChunk = async () => Option.some({ lines: 'a', next: null })

    expect(await collectJsonlExport(requestChunk)).toEqual({
      kind: 'ready',
      filename: 'xharvest.jsonl',
      chunks: ['a'],
    })
  })
})

describe('runJsonlExport', () => {
  it('reports worker unreachability without triggering a download', async () => {
    const outcome = await runJsonlExport(async () => Option.none())

    expect(outcome).toEqual({ ok: false, detail: 'Could not reach the extension worker.' })
  })

  it('reports an empty archive without triggering a download', async () => {
    const outcome = await runJsonlExport(async () => Option.some({ lines: '', next: null }))

    expect(outcome).toEqual({
      ok: false,
      detail: 'Nothing harvested yet — turn on Capture and browse X.',
    })
  })
})
