/**
 * Release-bench — the deterministic autoresearch workload for the Release flow.
 *
 * Drives the REAL dispatch machinery (`background/tab-broadcaster.sendClearToTabs`
 * fan-out → release-tab permalink leg) and the REAL seed composition
 * (`packages/clear/seed.planClearSeed`) against fixture replicas of X's surfaces,
 * with the content-script side running the real `packages/clear` decision stack
 * (see fixtures.ts). Reproduces, offline and byte-identically, the failure families
 * observed live over CDP on 2026-08-23 (x.com moved Bookmarks/Likes into
 * `/i/history`):
 *
 *   1. Permalink pages that never mount (`articles=0` across the budget — incl. a
 *      seeded garbage id whose snowflake decodes to year 2040 ⇒ "page doesn't
 *      exist" forever).  → `wasted_poll_ms`, `exhausted_dispatches`, `doomed_seeds`
 *   2. The detach-as-proof confirm rule recording a flip when the article node is
 *      recycled mid-poll while the post is still bookmarked/liked server-side
 *      (diagnosis doc cause #1).  → `release_success_rate`, `fabricated_flip_count`
 *
 * Emits one `METRIC <name>=<value>` line per metric; exit 0 iff every scenario ran
 * to a verdict. Leg verdicts are DATA, not assertions: failing legs are exactly
 * what the optimization loop must fix.
 */
import { Schema } from 'effect'
import { VirtualClock, drive, FakeXWorld, type TweetSpec } from './fixtures'
import type { MembershipScope } from '@/packages/clear/clearer'
import { planClearSeed } from '@/packages/clear/seed'
import { Settings as SettingsSchema } from '@/packages/schema'

interface LegResult {
  readonly name: string
  /** Broadcaster verdict the GROUND TRUTH requires for this leg to be correct. */
  readonly expectOk: boolean
  /** Set whenever success is claimed — scored against fixture truth. */
  readonly truthId?: string
  readonly truthScope?: MembershipScope
  /** Set when the leg's success claim is DEFERRED-verified (recheck watchdog must
   * be armed) rather than truth-proven at click time — the 'gone' detach contract. */
  readonly deferred?: { readonly id: string; readonly scope: MembershipScope }
  /** The leg's `ok` IS the full assertion (pure-integration legs without a fixture
   * world) — honesty scoring defers to it wholesale. */
  readonly selfAsserted?: boolean
  readonly actualOk: boolean
}

/** The live-measured junk capture (snowflake decodes to year 2040). */
const GARBAGE_ID = '3969701833668148185'

const ID = (n: number): string => `208264737088669${String(n).padStart(4, '0')}`
const PIN = (scope: MembershipScope) => ({ source: 'consented', scope }) as const

async function score(
  makeWorld: (clock: VirtualClock) => FakeXWorld,
  name: string,
  expectOk: boolean,
  run: (world: FakeXWorld) => Promise<{
    ok: boolean
    truth?: { id: string; scope: MembershipScope }
    deferred?: { id: string; scope: MembershipScope }
  }>,
): Promise<LegResult & { world: FakeXWorld }> {
  const clock = new VirtualClock()
  const world = makeWorld(clock)
  const out = await drive(clock, () => run(world))
  return {
    name,
    expectOk,
    actualOk: out.ok,
    ...(out.truth === undefined ? {} : { truthId: out.truth.id, truthScope: out.truth.scope }),
    ...(out.deferred === undefined ? {} : { deferred: out.deferred }),
    world,
  }
}

export async function runBench(): Promise<void> {
  // S1 — History ▸ Bookmarks tab sweep: five member posts + one already-cleared,
  // cleared from the `/i/history` list tab itself (pin consented bookmark).
  const s1 = await score(
    (clock) => new FakeXWorld(clock, () => ({ state: 'notfound' })),
    'history-bookmarks-list-sweep',
    true,
    async (world) => {
      const specs: TweetSpec[] = Array.from({ length: 5 }, (_, i) => ({
        id: ID(i),
        bookmark: 'member' as const,
      }))
      specs.push({ id: ID(99), bookmark: 'cleared' as const })
      world.addListTab('/i/history', specs)
      const results = await world
        .broadcaster()
        .sendClearToTabs(ID(0), ['bookmark'], undefined, false, PIN('bookmark'))
      return {
        ok: results.length > 0 && results.every((r) => r.ok),
        truth: { id: ID(0), scope: 'bookmark' as const },
      }
    },
  )

  // S2 — same on the Likes tab URL shape.
  const s2 = await score(
    (clock) => new FakeXWorld(clock, () => ({ state: 'notfound' })),
    'history-likes-list-sweep',
    true,
    async (world) => {
      world.addListTab(
        '/i/history/likes',
        Array.from({ length: 4 }, (_, i) => ({ id: ID(10 + i), like: 'member' as const })),
      )
      const results = await world
        .broadcaster()
        .sendClearToTabs(ID(10), ['like'], undefined, false, PIN('like'))
      return {
        ok: results.length > 0 && results.every((r) => r.ok),
        truth: { id: ID(10), scope: 'like' as const },
      }
    },
  )

  // S3 — cross-list clear ("clear from every list"): a home-feed tab holds a post
  // that is BOTH bookmarked and liked; both scopes must fire from one dispatch.
  const s3 = await score(
    (clock) => new FakeXWorld(clock, () => ({ state: 'notfound' })),
    'alllists-both-scopes',
    true,
    async (world) => {
      world.addListTab('/home', [{ id: ID(20), bookmark: 'member', like: 'member' }])
      const results = await world
        .broadcaster()
        .sendClearToTabs(ID(20), ['bookmark', 'like'], undefined, true, { source: 'none' })
      return {
        ok: results.length === 2 && results.every((r) => r.ok),
        truth: { id: ID(20), scope: 'bookmark' as const },
      }
    },
  )

  // S4 — release-tab permalink mounts LATE (observed slow-render case) but then
  // clears fine under the pinned scope.
  const s4 = await score(
    (clock) =>
      new FakeXWorld(clock, () => ({ state: 'member', mountAfterMs: 1800, bookmark: 'member' })),
    'permalink-late-mount',
    true,
    async (world) => {
      const results = await world
        .broadcaster()
        .sendClearToTabs(ID(30), ['bookmark'], undefined, false, PIN('bookmark'))
      return {
        ok: results.every((r) => r.ok),
        truth: { id: ID(30), scope: 'bookmark' as const },
      }
    },
  )

  // S5 — permalink NEVER mounts (the live garbage-id / not-found shell): every
  // release attempt finds an error block until reload+backoff ends the leg.
  // Ground truth demands an honest FAIL; its burn counts as waste.
  const s5 = await score(
    (clock) => new FakeXWorld(clock, () => ({ state: 'notfound' })),
    'permalink-never-mounts',
    false,
    async (world) => {
      const results = await world
        .broadcaster()
        .sendClearToTabs(ID(31), ['bookmark'], undefined, false, PIN('bookmark'))
      return { ok: results.every((r) => r.ok) }
    },
  )

  // S6 — click never takes + node recycled mid-poll with the id ABSENT afterwards
  // ('gone'): no synchronous DOM signal can separate recycle from server-side
  // removal, so the contract is DEFERRED verification — the verdict may read ok,
  // but ONLY with the recheck watchdog armed via onFlip. Ground truth never shows
  // cleared; a later sweep must be what honestly noops it.
  const s6 = await score(
    (clock) => new FakeXWorld(clock, () => ({ state: 'notfound' })),
    'detach-midpoll-gone-deferred-to-recheck',
    true,
    async (world) => {
      const tabId = world.addListTab('/i/history', [
        { id: ID(40), bookmark: 'member', inert: true },
      ])
      const cell = world.tabWin(tabId)?.document.querySelector('[data-testid="cellInnerDiv"]')
      world.clock.at(400, () => cell?.remove())
      const results = await world
        .broadcaster()
        .sendClearToTabs(ID(40), ['bookmark'], undefined, false, PIN('bookmark'))
      const ok = results.every((r) => r.ok) && world.flipArmed(ID(40), 'bookmark')
      return {
        ok,
        deferred: { id: ID(40), scope: 'bookmark' as const },
      }
    },
  )

  // S7 — click never takes + the SAME id remounts elsewhere still as a member:
  // the fabricated-flip smoking gun; must never read as a verified release.
  const s7 = await score(
    (clock) => new FakeXWorld(clock, () => ({ state: 'notfound' })),
    'detach-midpoll-id-remounts-member',
    false,
    async (world) => {
      const tabId = world.addListTab('/i/history', [
        { id: ID(41), bookmark: 'member', inert: true },
      ])
      const win = world.tabWin(tabId)
      const cell = win?.document.querySelector('[data-testid="cellInnerDiv"]')
      world.clock.at(400, () => {
        cell?.remove()
        if (!win) return
        const col = win.document.querySelector('[data-testid="primaryColumn"]')
        const fresh = win.document.createElement('div')
        fresh.setAttribute('data-testid', 'cellInnerDiv')
        fresh.innerHTML = `
          <article data-testid="tweet">
            <a href="/author/status/${ID(41)}"><time></time></a>
            <button data-testid="removeBookmark"></button>
            <button data-testid="like"></button>
          </article>`
        col?.appendChild(fresh)
      })
      const results = await world
        .broadcaster()
        .sendClearToTabs(ID(41), ['bookmark'], undefined, false, PIN('bookmark'))
      return {
        ok: results.every((r) => r.ok),
        truth: { id: ID(41), scope: 'bookmark' as const },
      }
    },
  )

  // S9 — orphan-tab skip (spec Part D): a tab whose content script rejects on
  // TWO consecutive dispatches is skipped thereafter (skipped=/stale= tokens),
  // while the healthy tab keeps clearing. Guards the dead-tab tax on every
  // dispatch.
  const s9 = await score(
    (clock) => new FakeXWorld(clock, () => ({ state: 'notfound' })),
    'orphan-tab-skipped-after-two-misses',
    true,
    async (world) => {
      world.addOrphanTab('/i/history')
      world.addListTab('/i/history', [{ id: ID(60), bookmark: 'member' }])
      const broadcaster = world.broadcaster()
      await broadcaster.sendClearToTabs(ID(60), ['bookmark'], undefined, false, PIN('bookmark'))
      await broadcaster.sendClearToTabs(ID(60), ['bookmark'], undefined, false, PIN('bookmark'))
      const third = await broadcaster.sendClearToTabs(
        ID(60),
        ['bookmark'],
        undefined,
        false,
        PIN('bookmark'),
      )
      const lastDispatch = [...world.trace].reverse().find((t) => t.stage === 'clear-dispatch')
      const orphanWasSkipped = lastDispatch?.detail.includes('skipped=1') === true
      return {
        ok: third.every((r) => r.ok) && orphanWasSkipped,
        truth: { id: ID(60), scope: 'bookmark' as const },
      }
    },
  )

  // S8 — seed-time gate INTEGRATION: the real `planClearSeed` must refuse the
  // live garbage id while seeding the genuine snowflake — this failure class
  // never reaches a dispatch at all.
  const seedSettings = Schema.decodeUnknownSync(SettingsSchema)({
    clearOnSave: true,
    autoUnbookmarkOnSave: true,
  })
  const mediaItem = (id: string, postId: string) => ({
    id,
    platform: 'x' as const,
    postId,
    author: 'alice',
    type: 'photo' as const,
    url: `https://pbs.twimg.com/media/${id}.jpg`,
    ext: 'jpg',
    index: 0,
  })
  const mediaById = new Map(
    [mediaItem('m-garbage', GARBAGE_ID), mediaItem('m-good', ID(50))].map((item) => [
      item.id,
      item,
    ]),
  )
  const seedVerdict = planClearSeed({
    requests: [
      { id: 'm-garbage', url: 'https://x/m-garbage', filename: 'm-garbage.jpg' },
      { id: 'm-good', url: 'https://x/m-good', filename: 'm-good.jpg' },
    ],
    mediaById,
    settings: seedSettings,
  })
  const doomedSeeds =
    seedVerdict.decision === 'seed'
      ? [...seedVerdict.byTweet.keys()].filter((id) => id === GARBAGE_ID).length
      : -1
  const s8ok =
    seedVerdict.decision === 'seed' &&
    seedVerdict.unclearableCount === 1 &&
    doomedSeeds === 0 &&
    seedVerdict.byTweet.get(ID(50))?.length === 1

  const legs: Array<LegResult & Partial<{ world: FakeXWorld }>> = [s1, s2, s3, s4, s5, s6, s7, s9]
  legs.push({
    name: 'seed-gate-refuses-garbage-id',
    expectOk: true,
    selfAsserted: true,
    actualOk: s8ok,
  })

  let wastedPollMs = 0
  let fabricatedFlips = 0
  let exhaustedDispatches = 0
  let correct = 0

  for (const leg of legs) {
    for (const line of leg.world?.trace ?? []) {
      if (line.stage === 'clear-flip-fabricated') fabricatedFlips++
      if (line.stage === 'clear-release-poll') {
        const elapsed = Number(/elapsedMs=(\d+)/.exec(line.detail)?.[1] ?? '0')
        const reason = /reason=(\w+)$/.exec(line.detail)?.[1] ?? 'unknown'
        if (reason !== 'mounted') {
          wastedPollMs += elapsed
          exhaustedDispatches++
        }
      }
    }
    const verdictMatches = leg.actualOk === leg.expectOk
    const honest = !leg.actualOk
      ? true
      : leg.selfAsserted === true
        ? true
        : leg.world !== undefined && leg.deferred !== undefined
          ? leg.world.flipArmed(leg.deferred.id, leg.deferred.scope)
          : leg.world !== undefined &&
            leg.truthId !== undefined &&
            leg.truthScope !== undefined &&
            leg.world.truthCleared(leg.truthId, leg.truthScope)
    if (verdictMatches && honest) correct++
    else
      console.error(
        `LEG ${leg.name}: actualOk=${leg.actualOk} expectOk=${leg.expectOk} honest=${honest}`,
      )
  }

  console.log(`METRIC release_success_rate=${(correct / legs.length).toFixed(4)}`)
  console.log(`METRIC wasted_poll_ms=${wastedPollMs}`)
  console.log(`METRIC fabricated_flip_count=${fabricatedFlips}`)
  console.log(`METRIC exhausted_dispatches=${exhaustedDispatches}`)
  console.log(`METRIC doomed_seeds=${doomedSeeds}`)
  console.log(`METRIC workload_ms=${legs.reduce((sum, l) => sum + (l.world?.clock.nowMs ?? 0), 0)}`)
}

runBench().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
