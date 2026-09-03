#!/usr/bin/env bun
/**
 * Deep-module boundary enforcement: each directory under `src/packages` exposes
 * only its root files; everything in a subfolder is private.
 *
 * Replaces dependency-cruiser, which resolves through the `typescript` compiler
 * API and refuses >= 7. On this repo it cruised zero modules and still exited 0 —
 * reporting "no violations" while parsing nothing, and hiding four real ones.
 * `oxc-parser` has no opinion about the TypeScript version.
 *
 * Type-only imports count as edges: importing another package's internals for a
 * type pins that file's path and shape just as a value import does. It is also
 * why Bun's `Transpiler.scanImports` is unusable here — it erases them.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { parseSync } from 'oxc-parser'

/** `true` only for an existing regular file — a directory must never satisfy a
 *  module specifier, or its `index.*` edge is lost. */
const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Where packages live. One immediate child dir per package (flat, no nesting). */
const PACKAGES_ROOT = 'src/packages'

/** Extensions tried, in order, when a specifier omits one. */
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.json']

/** Directories whose contents are not part of the first-party graph. */
const SKIP = ['src/components/ui/']

const R = PACKAGES_ROOT
/** Anything nested inside a package subfolder. A package's ROOT files are its
 *  entry points and are deliberately NOT matched — they stay importable. */
const PACKAGE_INTERNALS = new RegExp(`^${R}/[^/]+/[^/]+/`)
const IN_ANY_PACKAGE = new RegExp(`^${R}/`)
const IN_ANY_TESTS = new RegExp(`^${R}/[^/]+/tests/`)
/** Captures the owning package name in group 1. */
const PACKAGE_OF = new RegExp(`^${R}/([^/]+)/`)
const TESTS_OF = new RegExp(`^${R}/([^/]+)/tests/`)

export interface Violation {
  readonly rule: string
  readonly from: string
  readonly to: string
  /** The full cycle, for `no-circular`; absent on the pairwise rules. */
  readonly cycle?: ReadonlyArray<string>
}

const posix = (p: string): string => p.replaceAll('\\', '/')

/** Every module specifier in one source file: static imports, `export ... from`,
 *  and dynamic `import()`. Type-only forms included — see the module doc. */
const specifiersOf = (file: string, source: string): string[] => {
  const { module } = parseSync(file, source)
  const found: string[] = module.staticImports.map((entry) => entry.moduleRequest.value)

  for (const statement of module.staticExports)
    for (const entry of statement.entries)
      if (entry.moduleRequest) found.push(entry.moduleRequest.value)

  // Dynamic imports carry source offsets rather than a parsed value, and the span
  // covers the quotes.
  for (const entry of module.dynamicImports)
    found.push(source.slice(entry.moduleRequest.start + 1, entry.moduleRequest.end - 1))

  return found
}

/** Resolve one specifier to a repo-relative module path, or `null` when it is a
 *  bare npm/node specifier or resolves to nothing on disk. `@/x` and `~/x` are
 *  WXT's aliases for `src/x`. */
const resolveSpecifier = (fromFile: string, spec: string): string | null => {
  let base: string
  if (spec.startsWith('@/') || spec.startsWith('~/')) base = `src/${spec.slice(2)}`
  else if (spec === '@' || spec === '~') base = 'src'
  else if (spec.startsWith('.')) {
    const dir = fromFile.slice(0, fromFile.lastIndexOf('/'))
    const joined = `${dir}/${spec}`
    const parts: string[] = []
    for (const segment of joined.split('/')) {
      if (segment === '.' || segment === '') continue
      if (segment === '..') parts.pop()
      else parts.push(segment)
    }
    base = parts.join('/')
  } else return null // bare specifier: npm package or node: builtin

  // Directories must not match: `@/packages/schema` resolving to the folder
  // instead of its `index.ts` silently drops every edge through it.
  const candidates = [
    base,
    ...EXTENSIONS.map((e) => base + e),
    ...EXTENSIONS.map((e) => `${base}/index${e}`),
  ]
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate
  }
  return null
}

/** `true` when `to` is inside a package OTHER than the one owning `from`. */
const differentPackage = (from: string, to: string): boolean => {
  const owner = PACKAGE_OF.exec(from)?.[1]
  const target = PACKAGE_OF.exec(to)?.[1]
  return owner !== undefined && target !== undefined && owner !== target
}

const pairwiseViolations = (from: string, to: string): string[] => {
  const broken: string[] = []
  const intoInternals = PACKAGE_INTERNALS.test(to)

  // App/root code may import a package's entry points, but nothing in its subfolders.
  if (!IN_ANY_PACKAGE.test(from) && intoInternals) broken.push('entrypoint-boundary-from-app')

  // A package's own files import each other freely, but reach OTHER packages
  // only through their entry points.
  if (
    PACKAGE_OF.test(from) &&
    !IN_ANY_TESTS.test(from) &&
    intoInternals &&
    differentPackage(from, to)
  )
    broken.push('entrypoint-boundary-across-packages')

  // Tests go through entry points too, never any package's internals — not even
  // their own. Their own tests/ fixtures are the exception.
  const owningTestPackage = TESTS_OF.exec(from)?.[1]
  if (
    owningTestPackage !== undefined &&
    intoInternals &&
    !to.startsWith(`${R}/${owningTestPackage}/tests/`)
  )
    broken.push('tests-through-entrypoints')

  // A tests/ folder is reachable only from tests — nothing else imports fixtures.
  if (!IN_ANY_TESTS.test(from) && IN_ANY_TESTS.test(to)) broken.push('tests-folder-is-private')

  return broken
}

/** One node's frame in the iterative Tarjan walk. */
interface Frame {
  readonly node: string
  readonly iterator: Iterator<string>
}

/** Drains Tarjan's stack down to `root`, which is one complete component. */
const popComponent = (stack: string[], onStack: Set<string>, root: string): string[] => {
  const component: string[] = []
  for (;;) {
    const popped = stack.pop()
    if (popped === undefined) break
    onStack.delete(popped)
    component.push(popped)
    if (popped === root) break
  }
  return component
}

/** Finds import cycles. Tarjan, so a group of files that all reach each other is
 *  reported once instead of once per file. Iterative to avoid deep recursion. */
const findCycles = (graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] => {
  const index = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0
  const edgesOf = (node: string): Iterator<string> =>
    (graph.get(node) ?? new Set<string>()).values()

  /** First visit to a node: number it, stack it, and queue its edges. */
  const enter = (node: string, work: Frame[]): void => {
    index.set(node, counter)
    lowlink.set(node, counter)
    counter += 1
    stack.push(node)
    onStack.add(node)
    work.push({ node, iterator: edgesOf(node) })
  }

  const lower = (node: string, against: number): void => {
    lowlink.set(node, Math.min(lowlink.get(node) ?? 0, against))
  }

  /** Walk one edge: descend into an unseen child, or lower against a stacked one. */
  const step = (frame: Frame, child: string, work: Frame[]): void => {
    if (!index.has(child)) enter(child, work)
    else if (onStack.has(child)) lower(frame.node, index.get(child) ?? 0)
  }

  for (const root of graph.keys()) {
    if (index.has(root)) continue
    const work: Frame[] = []
    enter(root, work)

    while (work.length > 0) {
      const frame = work.at(-1)
      if (frame === undefined) break
      const next = frame.iterator.next()

      if (next.done !== true) {
        step(frame, next.value, work)
        continue
      }

      work.pop()
      const parent = work.at(-1)
      if (parent !== undefined) lower(parent.node, lowlink.get(frame.node) ?? 0)

      if (lowlink.get(frame.node) !== index.get(frame.node)) continue
      const component = popComponent(stack, onStack, frame.node)
      // A lone module is only a cycle if it imports itself.
      const first = component[0] ?? ''
      const selfLoop = component.length === 1 && graph.get(first)?.has(first) === true
      if (component.length > 1 || selfLoop) components.push(component.toReversed())
    }
  }
  return components
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs'])

/** Every first-party source file under `dir`, repo-relative and posix-separated. */
const sourceFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = posix(`${dir}/${entry.name}`)
    if (SKIP.some((prefix) => path.startsWith(prefix))) continue
    if (entry.isDirectory()) out.push(...sourceFiles(path))
    else if (SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf('.')))) out.push(path)
  }
  return out
}

export const cruise = (root = 'src'): Violation[] => {
  const violations: Violation[] = []
  const graph = new Map<string, Set<string>>()

  for (const file of sourceFiles(root)) {
    const source = readFileSync(file, 'utf8')
    const edges = new Set<string>()
    for (const spec of specifiersOf(file, source)) {
      const target = resolveSpecifier(file, spec)
      if (target !== null && target !== file) edges.add(target)
    }
    // Judge edges, not specifiers: importing both a type and a value from the
    // same module is one edge, and should be one finding.
    for (const target of edges)
      for (const rule of pairwiseViolations(file, target))
        violations.push({ rule, from: file, to: target })
    graph.set(file, edges)
  }

  for (const cycle of findCycles(graph))
    violations.push({ rule: 'no-circular', from: cycle[0] ?? '', to: cycle[1] ?? '', cycle })

  return violations
}

if (import.meta.main) {
  const violations = cruise()
  if (violations.length === 0) {
    console.info('boundaries: no violations')
    process.exit(0)
  }
  for (const violation of violations) {
    if (violation.cycle)
      console.error(`  error ${violation.rule}: ${violation.cycle.join(' →\n      ')}`)
    else console.error(`  error ${violation.rule}: ${violation.from} → ${violation.to}`)
  }
  console.error(`\nx ${violations.length} dependency violations`)
  process.exit(1)
}
