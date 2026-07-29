import {
  badgeNudgeDelayMs,
  badgeSavedRevertMs,
  beginSave,
  enterMedia,
  hiddenBadge,
  leaveMedia,
  nudgeBadge,
  resolveOutcome,
  resolveSave,
  type BadgeState,
} from '../../core/badge'
import {
  beginSendAll,
  launcherFailedRevertMs,
  launcherSavedRevertMs,
  resolveOutcomeAll,
  resolveSendAll,
  settleLauncher,
  type LauncherPhase,
} from '../../core/launcher'
import type { MediaItem } from '../../core/schema'
import { mediaRequestId } from '../../core/download/request-identity'
import type { ClearExpect, TrackedStart } from './tracked-download'

export type HoverMediaElement = HTMLImageElement | HTMLVideoElement

export interface DownloadAffordanceClock {
  readonly now: () => number
  readonly after: (ms: number, task: () => void) => () => void
}

export interface DownloadAffordanceSnapshot {
  readonly badge: BadgeState
  readonly badgeMedia: HoverMediaElement | null
  readonly badgeRequestId: string | null
  readonly badgeRequestKey: string | null
  readonly launcher: LauncherPhase
  readonly launcherBatchIds: ReadonlySet<string>
}

export interface DownloadAffordances {
  /** Reconcile the badge with the current hover. Detection stays with the overlay. */
  apply(input: {
    readonly enabled: boolean
    readonly modifierHeld: boolean
    readonly media: HoverMediaElement | null
    readonly key: string | null
    readonly resolvable: boolean
  }): void
  snapshot(): DownloadAffordanceSnapshot
  onBadgeClick(): void
  launchAll(): void
  /** Shared tracked-start lifecycle used by Quick Grab. */
  launchQuickGrab(input: {
    readonly items: ReadonlyArray<MediaItem>
    readonly item: MediaItem
    readonly armedAt: number
    readonly isStale: () => boolean
    readonly resolve: (ok: boolean) => void
  }): void
  onTransferOutcome(requestId: string, outcome: 'complete' | 'failed'): boolean
  onRouteChange(): void
  stop(): void
}

export const makeDownloadAffordances = (deps: {
  readonly clock: DownloadAffordanceClock
  readonly rerender: () => void
  readonly resolveItem: (media: HoverMediaElement, key: string) => MediaItem | null
  readonly mediaIsCurrent: (media: HoverMediaElement, key: string) => boolean
  readonly allItems: () => ReadonlyArray<MediaItem>
  readonly clearExpect: (items: ReadonlyArray<MediaItem>) => ClearExpect | undefined
  readonly sendTracked: (
    items: ReadonlyArray<MediaItem>,
    clearExpect?: ClearExpect,
  ) => Promise<TrackedStart>
  readonly trace: (
    source: 'quickgrab' | 'badge',
    stage: string,
    opts: { readonly item?: MediaItem; readonly key?: string; readonly elapsedMs?: number },
  ) => void
}): DownloadAffordances => {
  let stopped = false
  let epoch = 0
  let badge: BadgeState = hiddenBadge
  let badgeMedia: HoverMediaElement | null = null
  let badgeRequestId: string | null = null
  let badgeRequestKey: string | null = null
  let badgeNudgeCancel: (() => void) | null = null
  let badgeRevertCancel: (() => void) | null = null
  let launcher: LauncherPhase = 'idle'
  let launcherBatchIds = new Set<string>()
  let launcherRevertCancel: (() => void) | null = null

  const rerender = (): void => {
    if (!stopped) deps.rerender()
  }
  const clearBadgeTimers = (): void => {
    badgeNudgeCancel?.()
    badgeNudgeCancel = null
    badgeRevertCancel?.()
    badgeRevertCancel = null
  }
  const clearLauncherRevert = (): void => {
    launcherRevertCancel?.()
    launcherRevertCancel = null
  }
  const resetBadge = (): void => {
    clearBadgeTimers()
    badge = hiddenBadge
    badgeMedia = null
    badgeRequestId = null
    badgeRequestKey = null
  }
  const run = (input: {
    readonly items: ReadonlyArray<MediaItem>
    readonly source?: 'quickgrab' | 'badge'
    readonly item?: MediaItem
    readonly armedAt?: number
    readonly isStale: () => boolean
    readonly resolve: (ok: boolean) => void
    readonly onSettled?: (ok: boolean, taskEpoch: number) => void
  }): void => {
    const taskEpoch = epoch
    void (async () => {
      const startedAt = deps.clock.now()
      if (input.source && input.item)
        deps.trace(input.source, 'queued', {
          item: input.item,
          ...(input.armedAt === undefined ? {} : { elapsedMs: startedAt - input.armedAt }),
        })
      const start = await deps.sendTracked(input.items, deps.clearExpect(input.items))
      const ok = start._tag === 'started'
      if (input.source && input.item)
        deps.trace(input.source, ok ? 'start-ack' : 'start-failed', {
          item: input.item,
          elapsedMs: deps.clock.now() - startedAt,
        })
      if (stopped || taskEpoch !== epoch || input.isStale()) return
      input.resolve(ok)
      rerender()
      input.onSettled?.(ok, taskEpoch)
    })()
  }

  return {
    apply(input) {
      if (stopped) return
      const next =
        input.media && input.key
          ? enterMedia(badge, input.key, {
              enabled: input.enabled,
              resolvable: input.resolvable,
              modifierHeld: input.modifierHeld,
            })
          : leaveMedia(badge)
      if (next === badge) {
        if (next.phase !== 'hidden' && input.media && badgeMedia !== input.media) {
          badgeMedia = input.media
          rerender()
        }
        return
      }
      clearBadgeTimers()
      badge = next
      badgeMedia = next.phase === 'hidden' ? null : input.media
      if (next.phase === 'shown') {
        deps.trace('badge', 'shown', next.key ? { key: next.key } : {})
        const taskEpoch = epoch
        badgeNudgeCancel = deps.clock.after(badgeNudgeDelayMs, () => {
          badgeNudgeCancel = null
          if (stopped || taskEpoch !== epoch) return
          const nudged = nudgeBadge(badge)
          if (nudged === badge) return
          badge = nudged
          deps.trace('badge', 'nudged', badge.key ? { key: badge.key } : {})
          rerender()
        })
      }
      rerender()
    },
    snapshot: () => ({
      badge,
      badgeMedia,
      badgeRequestId,
      badgeRequestKey,
      launcher,
      launcherBatchIds,
    }),
    onBadgeClick() {
      if (stopped) return
      const media = badgeMedia
      const key = badge.key
      const next = beginSave(badge)
      if (!media || !key || next === badge) return
      if (!deps.mediaIsCurrent(media, key)) {
        resetBadge()
        rerender()
        return
      }
      const item = deps.resolveItem(media, key)
      if (!item) {
        deps.trace('badge', 'no-item-for-hover', { key })
        resetBadge()
        rerender()
        return
      }
      clearBadgeTimers()
      badge = next
      badgeRequestId = mediaRequestId(item)
      badgeRequestKey = key
      rerender()
      run({
        items: [item],
        source: 'badge',
        item,
        isStale: () => badge.key !== key || badge.phase !== 'queued',
        resolve: (ok) => {
          badge = resolveSave(badge, ok)
        },
        onSettled: (_ok, taskEpoch) => {
          if (badge.phase !== 'saved') return
          badgeRevertCancel = deps.clock.after(badgeSavedRevertMs, () => {
            badgeRevertCancel = null
            if (stopped || taskEpoch !== epoch || badge.phase !== 'saved' || badge.key !== key)
              return
            badge = { phase: 'shown', key }
            rerender()
          })
        },
      })
    },
    launchAll() {
      if (stopped) return
      const next = beginSendAll(launcher)
      if (next === launcher) return
      clearLauncherRevert()
      launcher = next
      const batch = deps.allItems()
      launcherBatchIds = new Set(batch.map(mediaRequestId))
      rerender()
      run({
        items: batch,
        isStale: () => launcher !== 'queued',
        resolve: (ok) => {
          launcher = resolveSendAll(launcher, ok)
        },
        onSettled: (ok, taskEpoch) => {
          launcherRevertCancel = deps.clock.after(
            ok ? launcherSavedRevertMs : launcherFailedRevertMs,
            () => {
              launcherRevertCancel = null
              if (stopped || taskEpoch !== epoch) return
              const settled = settleLauncher(launcher)
              if (settled === launcher) return
              launcher = settled
              rerender()
            },
          )
        },
      })
    },
    launchQuickGrab(input) {
      run({
        items: input.items,
        source: 'quickgrab',
        item: input.item,
        armedAt: input.armedAt,
        isStale: input.isStale,
        resolve: input.resolve,
      })
    },
    onTransferOutcome(requestId, outcome) {
      if (stopped) return false
      const ok = outcome === 'complete'
      let changed = false
      if (
        requestId === badgeRequestId &&
        badge.key !== null &&
        badge.key === badgeRequestKey &&
        badgeMedia !== null &&
        deps.mediaIsCurrent(badgeMedia, badge.key)
      ) {
        const next = resolveOutcome(badge, ok)
        if (next !== badge) {
          clearBadgeTimers()
          badge = next
          changed = true
        }
      }
      if (launcherBatchIds.has(requestId)) {
        const next = resolveOutcomeAll(launcher, ok)
        if (next !== launcher) {
          clearLauncherRevert()
          launcher = next
          changed = true
        }
      }
      if (changed) rerender()
      return changed
    },
    onRouteChange() {
      if (stopped) return
      epoch++
      resetBadge()
      clearLauncherRevert()
      launcher = 'idle'
      launcherBatchIds = new Set()
    },
    stop() {
      if (stopped) return
      stopped = true
      epoch++
      resetBadge()
      clearLauncherRevert()
      launcher = 'idle'
      launcherBatchIds = new Set()
    },
  }
}
