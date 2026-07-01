import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync('src/entrypoints/options/App.tsx', 'utf8')
const iconsSource = readFileSync('src/components/icons.tsx', 'utf8')

/** Pull the `icon:` component name out of a `{ id: '<id>', ... }` SECTIONS entry. */
const sectionIcon = (id: string): string | undefined => {
  const idx = appSource.indexOf(`id: '${id}'`)
  if (idx === -1) return undefined
  const chunk = appSource.slice(idx, appSource.indexOf('}', idx) + 1)
  return chunk.match(/icon:\s*(\w+)/)?.[1]
}

describe('settings sidebar nav icons', () => {
  it('gives General and Filters visually distinct icons', () => {
    const general = sectionIcon('general')
    const filters = sectionIcon('filters')
    expect(general).toBeDefined()
    expect(filters).toBeDefined()
    expect(filters).not.toBe(general)
  })

  it('points Filters at a dedicated FunnelIcon', () => {
    expect(sectionIcon('filters')).toBe('FunnelIcon')
    expect(iconsSource).toContain('export function FunnelIcon')
  })
})
