import { readFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  INSTAGRAM_DESCRIPTOR,
  META_CDN_HOSTS,
  PLATFORM_CATALOG,
  THREADS_DESCRIPTOR,
  X_DESCRIPTOR,
  allPlatformHostMatch,
  cdnHostsForAllPlatforms,
  cdnMatchPatternsForAllPlatforms,
  descriptorForHostname,
  descriptorForUrl,
  isCdnHostnameForAnyPlatform,
  isCdnHostnameForPlatform,
  isInstagramUrl,
  isThreadsUrl,
  isXUrl,
  originsForAllPlatforms,
  platformForUrl,
} from './catalog'

describe('platform catalog', () => {
  it('owns all page, origin, and CDN facts', () => {
    expect(PLATFORM_CATALOG).toEqual([X_DESCRIPTOR, INSTAGRAM_DESCRIPTOR, THREADS_DESCRIPTOR])
    expect(allPlatformHostMatch()).toEqual([
      'https://x.com/*',
      'https://twitter.com/*',
      'https://www.instagram.com/*',
      'https://www.threads.net/*',
      'https://www.threads.com/*',
    ])
    expect([...originsForAllPlatforms()]).toEqual([
      'https://x.com',
      'https://twitter.com',
      'https://www.instagram.com',
      'https://www.threads.net',
      'https://www.threads.com',
    ])
    expect(cdnHostsForAllPlatforms()).toEqual([
      { host: 'pbs.twimg.com', includeSubdomains: false },
      { host: 'video.twimg.com', includeSubdomains: false },
      { host: 'cdninstagram.com', includeSubdomains: true },
    ])
    expect(cdnMatchPatternsForAllPlatforms()).toEqual([
      'https://pbs.twimg.com/*',
      'https://video.twimg.com/*',
      'https://*.cdninstagram.com/*',
    ])
    expect(META_CDN_HOSTS).toEqual([{ host: 'cdninstagram.com', includeSubdomains: true }])
  })

  it('matches exact platform URLs and hostnames', () => {
    expect(isXUrl('https://x.com/alice/status/1')).toBe(true)
    expect(isXUrl('http://twitter.com/bob')).toBe(false)
    expect(isXUrl('https://x.com.evil.test/alice')).toBe(false)
    expect(isXUrl('not a url')).toBe(false)

    expect(isInstagramUrl('https://www.instagram.com/p/CODE1/')).toBe(true)
    expect(isInstagramUrl('https://www.instagram.com')).toBe(true)
    expect(isInstagramUrl('http://www.instagram.com/p/CODE1/')).toBe(false)
    expect(isInstagramUrl('https://evil.test/?next=https://www.instagram.com/p/CODE1/')).toBe(false)

    expect(isThreadsUrl('https://www.threads.net/@alice/post/CODE1')).toBe(true)
    expect(isThreadsUrl('https://www.threads.com/@alice/post/CODE1')).toBe(true)
    expect(isThreadsUrl('https://www.threads.net')).toBe(true)
    expect(isThreadsUrl('http://www.threads.com/@alice/post/CODE1')).toBe(false)
    expect(isThreadsUrl('https://threads.net/@alice')).toBe(false)

    expect(descriptorForUrl('https://www.instagram.com/p/CODE1/')).toBe(INSTAGRAM_DESCRIPTOR)
    expect(platformForUrl('https://www.threads.com/@alice/post/CODE1')).toBe('threads')
    expect(descriptorForHostname('x.com')).toBe(X_DESCRIPTOR)
    expect(descriptorForHostname('instagram.com')).toBeUndefined()
    expect(descriptorForUrl('https://example.com/')).toBeUndefined()
  })

  it('keeps every URL matcher aligned with its HTTPS page patterns', () => {
    for (const descriptor of PLATFORM_CATALOG) {
      for (const pattern of descriptor.hostMatch) {
        const origin = pattern.slice(0, pattern.indexOf('/', 8))
        const hostname = new URL(origin).hostname
        expect(descriptor.matchesUrl(origin)).toBe(true)
        expect(descriptorForHostname(hostname)).toBe(descriptor)
        expect(descriptor.matchesUrl(origin.replace('https:', 'http:'))).toBe(false)
        expect(descriptor.matchesUrl(`https://${hostname}.evil.test/`)).toBe(false)
        expect(descriptor.matchesUrl(`https://${hostname}@evil.test/`)).toBe(false)
      }
    }
  })

  it('matches registered CDN hostname boundaries', () => {
    expect(isCdnHostnameForPlatform('x', 'pbs.twimg.com')).toBe(true)
    expect(isCdnHostnameForPlatform('x', 'video.twimg.com')).toBe(true)
    expect(isCdnHostnameForPlatform('x', 'evil.pbs.twimg.com')).toBe(false)
    expect(isCdnHostnameForPlatform('x', 'cdninstagram.com')).toBe(false)
    expect(isCdnHostnameForPlatform('instagram', 'cdninstagram.com')).toBe(true)
    expect(isCdnHostnameForPlatform('threads', 'scontent.cdninstagram.com')).toBe(true)
    expect(isCdnHostnameForAnyPlatform('scontent.cdninstagram.com')).toBe(true)
    expect(isCdnHostnameForAnyPlatform('evil-cdninstagram.com')).toBe(false)
  })
})

describe('catalog context seam', () => {
  it('has no runtime dependency on behavior or DOM modules', () => {
    const entry = resolve('src/core/adapters/catalog.ts')
    const closure = runtimeImportClosure(entry)
    const relativePaths = [...closure].map((file) => file.slice(process.cwd().length + 1))

    expect(relativePaths).toEqual(['src/core/adapters/catalog.ts'])
    const source = [...closure].map((file) => readFileSync(file, 'utf8')).join('\n')
    expect(source).not.toMatch(
      /\b(?:window|document|Element|ParentNode|HTMLImageElement|HTMLVideoElement)\b/u,
    )
  })

  it('keeps non-content consumers on the catalog seam', () => {
    const nonContentRoots = [
      'wxt.config.ts',
      'src/entrypoints/background.ts',
      'src/entrypoints/offscreen/main.ts',
      'src/entrypoints/popup/main.tsx',
      'src/entrypoints/options/main.tsx',
    ]
    const closure = new Set<string>()
    for (const entry of nonContentRoots)
      for (const file of runtimeImportClosure(entry)) closure.add(file)
    const behaviorModules = [...closure]
      .map((file) => file.slice(process.cwd().length + 1))
      .filter((file) =>
        /core\/adapters\/(?:registry|x\/(?:adapter|dom|index)|instagram\/adapter|threads\/adapter|meta-shared\/(?:dom|post-anchor))\.ts$/u.test(
          file,
        ),
      )
    expect(behaviorModules).toEqual([])
  })

  it('follows runtime re-exports and ignores type-only edges', () => {
    expect(
      runtimeModuleSpecifiers(
        'fixture.ts',
        [
          "export { value } from './behavior'",
          "export type { Shape } from './shape'",
          "import { type Other } from './other'",
          "import type { Model } from './model'",
        ].join('\n'),
      ),
    ).toEqual(['./behavior'])
  })
})

function runtimeImportClosure(entry: string): ReadonlySet<string> {
  const visited = new Set<string>()
  const visit = (file: string): void => {
    if (visited.has(file)) return
    visited.add(file)
    const source = readFileSync(file, 'utf8')
    for (const specifier of runtimeModuleSpecifiers(file, source)) {
      const target = specifier.startsWith('@/')
        ? resolve('src', specifier.slice(2))
        : specifier.startsWith('.')
          ? resolve(dirname(file), specifier)
          : undefined
      if (target === undefined) continue
      const candidates =
        extname(target) === ''
          ? [
              `${target}.ts`,
              `${target}.tsx`,
              resolve(target, 'index.ts'),
              resolve(target, 'index.tsx'),
            ]
          : [target]
      const resolved = candidates.find((candidate) => {
        try {
          readFileSync(candidate)
          return true
        } catch {
          return false
        }
      })
      if (resolved !== undefined) visit(resolved)
    }
  }
  visit(resolve(entry))
  return visited
}

function runtimeModuleSpecifiers(file: string, source: string): readonly string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && importHasRuntimeEdge(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && exportHasRuntimeEdge(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        specifiers.push(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      const [argument] = node.arguments
      if (argument !== undefined && ts.isStringLiteral(argument)) {
        specifiers.push(argument.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return specifiers
}

function importHasRuntimeEdge(declaration: ts.ImportDeclaration): boolean {
  const clause = declaration.importClause
  if (clause === undefined) return true
  if (clause.isTypeOnly) return false
  if (clause.name !== undefined) return true
  const bindings = clause.namedBindings
  if (bindings === undefined || ts.isNamespaceImport(bindings)) return true
  return bindings.elements.length === 0 || bindings.elements.some((element) => !element.isTypeOnly)
}

function exportHasRuntimeEdge(declaration: ts.ExportDeclaration): boolean {
  if (declaration.isTypeOnly) return false
  const clause = declaration.exportClause
  if (clause === undefined || !ts.isNamedExports(clause)) return true
  return clause.elements.length === 0 || clause.elements.some((element) => !element.isTypeOnly)
}
