import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const overlaySource = readFileSync(fileURLToPath(import.meta.resolve('./index.tsx')), 'utf8')

const DOCUMENT_ADD = /document\.addEventListener\(\s*([^,()]+?)\s*,\s*(\w+)\s*\)/g
const DOCUMENT_REMOVE = /document\.removeEventListener\(\s*([^,()]+?)\s*,\s*(\w+)\s*\)/g

const pairs = (pattern: RegExp): string[] =>
  [...overlaySource.matchAll(pattern)].map((match) => `${match[1]} -> ${match[2]}`)

describe('overlay document listeners', () => {
  it('finds the direct document listeners it is meant to guard', () => {
    expect(pairs(DOCUMENT_ADD)).toContain("'xmd:mutation-response' -> handleMutationResponse")
  })

  it('removes every direct document listener on invalidation', () => {
    const removed = new Set(pairs(DOCUMENT_REMOVE))
    const leaked = pairs(DOCUMENT_ADD).filter((pair) => !removed.has(pair))
    expect(leaked).toEqual([])
  })
})
