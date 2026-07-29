import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allPlatformHostMatch } from './catalog'

interface BuiltManifest {
  readonly host_permissions?: readonly string[]
  readonly background?: { readonly service_worker?: string }
  readonly action?: { readonly default_popup?: string }
  readonly content_scripts?: ReadonlyArray<{
    readonly js?: readonly string[]
    readonly matches?: readonly string[]
  }>
}

describe('built platform context seam', () => {
  it('keeps DOM behavior out of worker, popup, and offscreen bundles', { timeout: 30_000 }, () => {
    execFileSync('bun', ['run', 'build'], { stdio: 'pipe' })

    const output = resolve('.output/chrome-mv3')
    const manifest = JSON.parse(
      readFileSync(resolve(output, 'manifest.json'), 'utf8'),
    ) as BuiltManifest
    const worker = manifest.background?.service_worker
    const popup = manifest.action?.default_popup
    expect(worker).toBeTypeOf('string')
    expect(popup).toBeTypeOf('string')

    const platformMatches = [...allPlatformHostMatch()].toSorted()
    for (const contentScript of manifest.content_scripts ?? []) {
      expect([...(contentScript.matches ?? [])].toSorted()).toEqual(platformMatches)
    }
    for (const pattern of platformMatches) {
      expect(manifest.host_permissions).toContain(pattern)
    }

    const nonContentRoots = [
      resolve(output, worker!),
      ...scriptsFromHtml(output, popup!),
      ...scriptsFromHtml(output, 'offscreen.html'),
    ]
    const nonContentSource = [...bundleClosure(output, nonContentRoots)]
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')

    const domBehaviorMarkers =
      /\bHTML(?:Image|Video)Element\b|data-pressable-container|window\.innerWidth/u
    expect(nonContentSource).not.toMatch(domBehaviorMarkers)

    const contentRoots = (manifest.content_scripts ?? []).flatMap((entry) =>
      (entry.js ?? []).map((file) => resolve(output, file)),
    )
    const contentSource = [...bundleClosure(output, contentRoots)]
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
    expect(contentSource).toMatch(domBehaviorMarkers)
  })
})

function scriptsFromHtml(output: string, htmlPath: string): readonly string[] {
  const html = readFileSync(resolve(output, htmlPath), 'utf8')
  return [...html.matchAll(/(?:src|href)="([^"]+\.js)"/gu)].map((match) =>
    resolve(output, match[1]!.replace(/^\//u, '')),
  )
}

function bundleClosure(output: string, roots: readonly string[]): ReadonlySet<string> {
  const visited = new Set<string>()
  const visit = (file: string): void => {
    if (visited.has(file)) return
    expect(existsSync(file)).toBe(true)
    visited.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+\.js)["']/gu)) {
      const specifier = match[1]!
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue
      visit(
        specifier.startsWith('/')
          ? resolve(output, specifier.slice(1))
          : resolve(dirname(file), specifier),
      )
    }
  }
  roots.forEach(visit)
  return visited
}
