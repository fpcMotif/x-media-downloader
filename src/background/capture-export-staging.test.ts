import { describe, expect, it } from 'vitest'
import {
  CAPTURE_EXPORT_STAGE_CHUNK_BYTES,
  makeCaptureExportStaging,
  type CaptureExportStageStore,
  type CaptureJsonlLine,
} from './capture-export-staging'

const memoryStore = () => {
  let id: string | undefined
  let ready = false
  const parts: Uint8Array[][] = []
  const store: CaptureExportStageStore = {
    begin: async (next) => {
      if (id !== undefined) throw new Error('occupied')
      id = next
      ready = false
    },
    append: async (owner, part, bytes) => {
      if (id !== owner || ready || part > parts.length || part + 1 < parts.length)
        throw new Error('unavailable')
      if (part === parts.length) parts.push([])
      parts[part]!.push(new Uint8Array(bytes))
    },
    ready: async (owner, partCount) => {
      if (id !== owner || partCount !== parts.length) throw new Error('unavailable')
      ready = true
    },
    read: async (owner, part, index) => {
      if (id !== owner || !ready || part >= parts.length) throw new Error('unavailable')
      return parts[part]![index]
    },
    discard: async (owner) => {
      if (owner !== undefined && owner !== id) return
      id = undefined
      ready = false
      parts.length = 0
    },
  }
  return { store, id: () => id, parts: () => parts }
}

const lines = (...values: ReadonlyArray<string>): AsyncIterable<CaptureJsonlLine> =>
  (async function* () {
    for (const value of values) yield () => [value]
  })()

const collect = async (
  read: () => Promise<{ readonly done: boolean; readonly value?: Uint8Array }>,
) => {
  const parts: Uint8Array[] = []
  // oxlint-disable no-await-in-loop -- a ByteSource has ordered, one-pass reads
  for (;;) {
    const next = await read()
    if (next.done) break
    parts.push(next.value!)
  }
  // oxlint-enable no-await-in-loop
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return new TextDecoder().decode(output)
}

describe('CaptureExportStaging', () => {
  it('splits only between JSONL lines and reads every bounded part in order', async () => {
    const memory = memoryStore()
    const staging = makeCaptureExportStaging({ store: memory.store })

    await expect(staging.materializeJsonl('job', lines('aa', 'bb', 'cccc'), 5)).resolves.toEqual({
      kind: 'ready',
      partCount: 2,
    })

    expect(await collect(staging.source('job', 0).read)).toBe('aa\nbb')
    expect(await collect(staging.source('job', 1).read)).toBe('cccc')
    expect(
      memory
        .parts()
        .flat()
        .every((chunk) => chunk.byteLength <= 5),
    ).toBe(true)
  })

  it('coalesces fragments into bounded durable chunks without whole-line memory', async () => {
    const memory = memoryStore()
    const staging = makeCaptureExportStaging({ store: memory.store })
    const text = 'x'.repeat(CAPTURE_EXPORT_STAGE_CHUNK_BYTES + 3)

    await expect(staging.materializeJsonl('job', lines(text), text.length)).resolves.toEqual({
      kind: 'ready',
      partCount: 1,
    })

    expect(memory.parts()[0]?.map((chunk) => chunk.byteLength)).toEqual([
      CAPTURE_EXPORT_STAGE_CHUNK_BYTES,
      3,
    ])
    expect(await collect(staging.source('job', 0).read)).toBe(text)
  })

  it('drops an oversized line and makes cancel terminal without deleting another owner', async () => {
    const memory = memoryStore()
    const staging = makeCaptureExportStaging({ store: memory.store })

    await expect(staging.materializeJsonl('job', lines('abcdef'), 5)).resolves.toEqual({
      kind: 'too-large',
    })
    expect(memory.id()).toBeUndefined()

    await staging.materializeJsonl('job-2', lines('ok'), 2)
    const source = staging.source('job-2', 0)
    await source.cancel()
    await expect(source.read()).resolves.toEqual({ done: true })
    await staging.discard('another-owner')
    expect(memory.id()).toBe('job-2')
  })

  it('cleans failed and stale detached jobs', async () => {
    const memory = memoryStore()
    let writes = 0
    const failingStore: CaptureExportStageStore = {
      ...memory.store,
      append: async (...args) => {
        writes += 1
        if (writes === 2) throw new Error('disk failed')
        await memory.store.append(...args)
      },
    }
    const failing = makeCaptureExportStaging({ store: failingStore })
    const text = 'x'.repeat(CAPTURE_EXPORT_STAGE_CHUNK_BYTES + 1)

    await expect(failing.materializeJsonl('failed', lines(text), text.length)).rejects.toThrow(
      'disk failed',
    )
    expect(memory.id()).toBeUndefined()

    const staging = makeCaptureExportStaging({ store: memory.store })
    await staging.materializeJsonl('stale', lines('ok'), 2)
    await staging.discardStale()
    expect(memory.id()).toBeUndefined()
  })
})
