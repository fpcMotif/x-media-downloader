#!/usr/bin/env bun
/**
 * Absence ratchet: counts `| null` and `| undefined` union types in each
 * top-level folder under `src` and holds every count to `absence-budget.json`.
 *
 * A type should say what absence means, with an Effect `Option`, a `_tag` union,
 * or a named literal. Hundreds of nullable unions predate that rule, so the
 * budget accepts today's count as the ceiling. The budget must equal the count,
 * not merely bound it: a change that removes unions must also lower the budget,
 * so the progress is recorded and cannot be spent again by a later change.
 *
 * Optional properties (`name?: T`) are not counted, because
 * `exactOptionalPropertyTypes` already makes them mean "absent".
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { Schema } from 'effect'
import { Visitor, parseSync } from 'oxc-parser'

const ROOT = 'src'
const BUDGET_URL = new URL('./absence-budget.json', import.meta.url)
const SOURCE_EXTENSIONS = ['.ts', '.tsx']
const SKIPPED_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx', '.d.ts']
const SKIPPED_SEGMENT = '/tests/'
const ABSENT_KEYWORDS: ReadonlySet<string> = new Set(['TSNullKeyword', 'TSUndefinedKeyword'])

/** Counts the absence unions in one source file. A union counts when its own
 *  members include `null` or `undefined`, and once even if it holds both. */
export const countAbsence = (file: string, source: string): number => {
  let count = 0
  const visitor = new Visitor({
    TSUnionType(node) {
      if (node.types.some((member) => ABSENT_KEYWORDS.has(member.type))) count += 1
    },
  })
  visitor.visit(parseSync(file, source).program)
  return count
}

const isCountedFile = (path: string): boolean =>
  SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)) &&
  !SKIPPED_SUFFIXES.some((suffix) => path.endsWith(suffix)) &&
  !path.includes(SKIPPED_SEGMENT)

const sourceFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...sourceFiles(path))
    else if (isCountedFile(path)) out.push(path)
  }
  return out
}

/** `src/packages/download/queue.ts` → `src/packages`; `src/env.ts` → `src`. */
const folderOf = (path: string): string => {
  const segments = path.split('/')
  return segments.slice(0, Math.min(2, segments.length - 1)).join('/')
}

const countFile = (file: string): number => countAbsence(file, readFileSync(file, 'utf8'))

/** Sums absence unions per folder key. Every folder with a counted file gets an
 *  entry, even at zero, so a budget for a folder that still exists is not
 *  reported as stale. */
export const tally = (root = ROOT): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const file of sourceFiles(root)) {
    const folder = folderOf(file)
    counts.set(folder, (counts.get(folder) ?? 0) + countFile(file))
  }
  return counts
}

const decodeBudget = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
)

const readBudget = (): Map<string, number> =>
  new Map(Object.entries(decodeBudget(JSON.parse(readFileSync(BUDGET_URL, 'utf8')))))

/** Lists one failure per folder whose count differs from its budget, and one
 *  per budget entry whose folder has no counted source files. */
const compare = (
  counts: ReadonlyMap<string, number>,
  budget: ReadonlyMap<string, number>,
): string[] => {
  const failures: string[] = []
  for (const [folder, count] of counts) {
    const limit = budget.get(folder)
    if (limit === undefined)
      failures.push(
        `absence: ${folder} has ${count} null/undefined unions and no budget. Add "${folder}": ${count} to the budget.`,
      )
    else if (count > limit)
      failures.push(
        `absence: ${folder} has ${count} null/undefined unions, budget ${limit}. Remove the new ones.`,
      )
    else if (count < limit)
      failures.push(
        `absence: ${folder} has ${count} null/undefined unions, budget ${limit}. Lower the budget to ${count}.`,
      )
  }
  for (const [folder, limit] of budget)
    if (!counts.has(folder))
      failures.push(
        `absence: ${folder} has a budget of ${limit} but no source files. Remove it from the budget.`,
      )
  return failures
}

type PathCount = readonly [path: string, count: number]

const byName = ([a]: PathCount, [b]: PathCount): number => a.localeCompare(b)
const byCountThenName = (a: PathCount, b: PathCount): number => b[1] - a[1] || byName(a, b)

const isDirectory = (path: string): boolean => existsSync(path) && statSync(path).isDirectory()

const printFiles = (argument: string | undefined): number => {
  const folder = argument?.replace(/\/+$/, '')
  if (folder === undefined || !isDirectory(folder)) {
    console.error('absence: --files needs an existing folder, for example --files src/packages')
    return 1
  }
  const ranked = sourceFiles(folder)
    .map((file): PathCount => [file, countFile(file)])
    .filter(([, count]) => count > 0)
    .toSorted(byCountThenName)
  for (const [file, count] of ranked) console.info(`${count} ${file}`)
  return 0
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const filesIndex = args.indexOf('--files')

  if (args.includes('--print')) {
    for (const [folder, count] of [...tally()].toSorted(byName))
      console.info(`"${folder}": ${count}`)
    process.exit(0)
  }

  if (filesIndex !== -1) process.exit(printFiles(args[filesIndex + 1]))

  const counts = tally()
  const failures = compare(counts, readBudget())
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure)
    process.exit(1)
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0)
  console.info(`absence: ${total} unions in ${counts.size} folders, all at budget.`)
}
