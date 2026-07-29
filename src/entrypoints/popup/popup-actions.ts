import {
  DOWNLOAD_START_FAILED,
  drainResult,
  INVALID_RESPONSE,
  NO_ACTIVE_TAB,
  PAGE_UNREACHABLE,
  SWEEP_STALE_CONTEXT,
  sweepResult,
} from '@/components/action-copy'
import type { TabContext } from './context'
import { isXContext } from './context'

export type PopupIntent =
  | { readonly kind: 'download-page'; readonly releaseAfter: boolean }
  | { readonly kind: 'sweep-list'; readonly releaseAfter: boolean }

export type ActionId = PopupIntent['kind']
export type ActionError =
  | 'no-active-tab'
  | 'page-unreachable'
  | 'stale-context'
  | 'background'
  | 'invalid-response'

export interface Notice {
  readonly kind: 'result' | 'actionable-error'
  readonly text: string
  readonly expiresAt: number | null
}

export interface PopupActionView {
  readonly active: ActionId | null
  readonly notices: Readonly<Record<'download', Notice | null>>
}

export type ActionOutcome =
  | { readonly kind: 'completed'; readonly action: ActionId; readonly work: number }
  | {
      readonly kind: 'partial'
      readonly action: ActionId
      readonly work: number
      readonly error: ActionError
    }
  | { readonly kind: 'inapplicable'; readonly action: ActionId }
  | { readonly kind: 'failed'; readonly action: ActionId; readonly error: ActionError }
  | { readonly kind: 'busy'; readonly action: ActionId; readonly active: ActionId }

export interface PopupActions {
  run(intent: PopupIntent): Promise<ActionOutcome>
  inspect(): PopupActionView
  subscribe(listener: () => void): () => void
  dispose(): void
}

export interface PopupActionTab {
  readonly id: number
  readonly url: string
}

export interface PopupActionTabsPort {
  query(query: {
    readonly active: boolean
    readonly currentWindow: boolean
  }): Promise<readonly { readonly id?: number | undefined; readonly url?: string | undefined }[]>
  sendMessage(tabId: number, request: { readonly _tag: string }): Promise<unknown>
}

export interface PopupActionClockPort {
  now(): number
  after(ms: number, task: () => void): () => void
}

export interface PopupActionDeps {
  readonly tabs: PopupActionTabsPort
  readonly clock: PopupActionClockPort
  readonly tabContext: (url: string) => TabContext
  readonly markDone: () => void | Promise<void>
}

type ActionCluster = 'download'
interface ActionDefinition {
  readonly cluster: ActionCluster
  readonly request: { readonly _tag: string }
  readonly appliesTo: (context: TabContext) => boolean
}
type ParsedReply =
  | { readonly kind: 'completed'; readonly work: number; readonly text: string }
  | {
      readonly kind: 'partial'
      readonly work: number
      readonly text: string
      readonly error: ActionError
    }
  | { readonly kind: 'inapplicable'; readonly text: string }
  | { readonly kind: 'failed'; readonly error: ActionError }

const ACTIONS: Readonly<Record<ActionId, ActionDefinition>> = {
  'download-page': {
    cluster: 'download',
    request: { _tag: 'DrainPageRequest' },
    appliesTo: isXContext,
  },
  'sweep-list': {
    cluster: 'download',
    request: { _tag: 'SweepPageRequest' },
    appliesTo: (context) => context === 'x-list',
  },
}
const ERROR_COPY: Readonly<Record<ActionError, string>> = {
  'no-active-tab': NO_ACTIVE_TAB,
  'page-unreachable': PAGE_UNREACHABLE,
  'stale-context': SWEEP_STALE_CONTEXT,
  background: DOWNLOAD_START_FAILED,
  'invalid-response': INVALID_RESPONSE,
}
const initialView = (): PopupActionView => ({
  active: null,
  notices: { download: null },
})
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const hasExactKeys = (value: Record<string, unknown>, required: readonly string[]): boolean => {
  const actual = Object.keys(value).toSorted()
  const expected = required.toSorted()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const parseDrain = (reply: unknown, releaseAfter: boolean): ParsedReply => {
  if (!isRecord(reply) || reply._tag !== 'DrainPageResponse' || typeof reply.ok !== 'boolean')
    return { kind: 'failed', error: 'invalid-response' }
  if (reply.ok) {
    if (!hasExactKeys(reply, ['_tag', 'ok', 'count']) || !isCount(reply.count))
      return { kind: 'failed', error: 'invalid-response' }
    return { kind: 'completed', work: reply.count, text: drainResult(reply.count, releaseAfter) }
  }
  if (!hasExactKeys(reply, ['_tag', 'ok', 'reason']))
    return { kind: 'failed', error: 'invalid-response' }
  if (reply.reason === 'context') return { kind: 'failed', error: 'stale-context' }
  if (reply.reason === 'background') return { kind: 'failed', error: 'background' }
  return { kind: 'failed', error: 'invalid-response' }
}
const parseSweep = (reply: unknown, releaseAfter: boolean): ParsedReply => {
  if (!isRecord(reply)) return { kind: 'failed', error: 'invalid-response' }
  const hasReason = Object.hasOwn(reply, 'reason')
  if (
    !hasExactKeys(
      reply,
      hasReason
        ? ['_tag', 'ok', 'queued', 'skipped', 'reason']
        : ['_tag', 'ok', 'queued', 'skipped'],
    ) ||
    reply._tag !== 'SweepPageResponse' ||
    typeof reply.ok !== 'boolean' ||
    !isCount(reply.queued) ||
    !isCount(reply.skipped)
  )
    return { kind: 'failed', error: 'invalid-response' }
  if (reply.ok) {
    if (hasReason) return { kind: 'failed', error: 'invalid-response' }
    return {
      kind: 'completed',
      work: reply.queued,
      text: sweepResult({ queued: reply.queued, skipped: reply.skipped }, releaseAfter),
    }
  }
  if (!hasReason) return { kind: 'failed', error: 'page-unreachable' }
  const error: ActionError | undefined =
    reply.reason === 'context'
      ? 'stale-context'
      : reply.reason === 'background' || reply.reason === 'failed'
        ? 'background'
        : undefined
  if (reply.queued !== 0 || reply.skipped !== 0) {
    if (error === undefined) return { kind: 'failed', error: 'invalid-response' }
    return {
      kind: 'partial',
      work: reply.queued,
      error,
      text: `${sweepResult(
        { queued: reply.queued, skipped: reply.skipped },
        releaseAfter,
      )} ${ERROR_COPY[error]}`,
    }
  }
  if (error !== undefined) return { kind: 'failed', error }
  if (reply.reason === 'not-list-page')
    return { kind: 'inapplicable', text: sweepResult({ reason: 'not-list-page' }, releaseAfter) }
  return { kind: 'failed', error: 'invalid-response' }
}
const parseReply = (intent: PopupIntent, reply: unknown): ParsedReply => {
  switch (intent.kind) {
    case 'download-page':
      return parseDrain(reply, intent.releaseAfter)
    case 'sweep-list':
      return parseSweep(reply, intent.releaseAfter)
  }
}

export function makePopupActions(deps: PopupActionDeps): PopupActions {
  let view = initialView()
  let active: ActionId | null = null
  const listeners = new Set<() => void>()
  const generation: Record<ActionCluster, number> = { download: 0 }
  const cancelNotice: Record<ActionCluster, (() => void) | null> = { download: null }
  let introCompleted = false
  let disposed = false
  const publish = (): void => {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        /* One view adapter must not starve others. */
      }
    }
  }
  const replaceNotice = (cluster: ActionCluster, notice: Notice | null): void => {
    view = { ...view, notices: { ...view.notices, [cluster]: notice } }
  }
  const setActive = (next: ActionId | null): void => {
    active = next
    view = { ...view, active: next }
  }
  const clearClusterAtStart = (cluster: ActionCluster): number => {
    generation[cluster] += 1
    cancelNotice[cluster]?.()
    cancelNotice[cluster] = null
    replaceNotice(cluster, null)
    return generation[cluster]
  }
  const ownsCluster = (cluster: ActionCluster, startedAt: number): boolean =>
    !disposed && generation[cluster] === startedAt
  const showResult = (cluster: ActionCluster, startedAt: number, text: string): void => {
    if (!ownsCluster(cluster, startedAt)) return
    cancelNotice[cluster]?.()
    const expiresAt = deps.clock.now() + 6000
    replaceNotice(cluster, { kind: 'result', text, expiresAt })
    cancelNotice[cluster] = deps.clock.after(6000, () => {
      if (!ownsCluster(cluster, startedAt)) return
      cancelNotice[cluster] = null
      replaceNotice(cluster, null)
      publish()
    })
  }
  const showError = (cluster: ActionCluster, startedAt: number, error: ActionError): void => {
    if (!ownsCluster(cluster, startedAt)) return
    cancelNotice[cluster]?.()
    cancelNotice[cluster] = null
    replaceNotice(cluster, { kind: 'actionable-error', text: ERROR_COPY[error], expiresAt: null })
  }
  const showPartial = (cluster: ActionCluster, startedAt: number, text: string): void => {
    if (!ownsCluster(cluster, startedAt)) return
    cancelNotice[cluster]?.()
    cancelNotice[cluster] = null
    replaceNotice(cluster, { kind: 'actionable-error', text, expiresAt: null })
  }
  const completeIntro = (): void => {
    if (disposed || introCompleted) return
    introCompleted = true
    try {
      void Promise.resolve(deps.markDone()).catch(() => {})
    } catch {
      /* Persistence cannot invalidate Stage work. */
    }
  }
  const execute = async (
    intent: PopupIntent,
    definition: ActionDefinition,
    startedAt: number,
  ): Promise<ActionOutcome> => {
    let tab: PopupActionTab | null
    try {
      const candidate = (await deps.tabs.query({ active: true, currentWindow: true }))[0]
      tab =
        candidate?.id === undefined || candidate.url === undefined
          ? null
          : { id: candidate.id, url: candidate.url }
    } catch {
      showError(definition.cluster, startedAt, 'page-unreachable')
      return { kind: 'failed', action: intent.kind, error: 'page-unreachable' }
    }
    if (tab === null) {
      showError(definition.cluster, startedAt, 'no-active-tab')
      return { kind: 'failed', action: intent.kind, error: 'no-active-tab' }
    }
    let context: TabContext
    try {
      context = deps.tabContext(tab.url)
    } catch {
      showError(definition.cluster, startedAt, 'page-unreachable')
      return { kind: 'failed', action: intent.kind, error: 'page-unreachable' }
    }
    if (!definition.appliesTo(context)) return { kind: 'inapplicable', action: intent.kind }
    let reply: unknown
    try {
      reply = await deps.tabs.sendMessage(tab.id, definition.request)
    } catch {
      showError(definition.cluster, startedAt, 'page-unreachable')
      return { kind: 'failed', action: intent.kind, error: 'page-unreachable' }
    }
    const parsed = parseReply(intent, reply)
    switch (parsed.kind) {
      case 'completed':
        if (definition.cluster === 'download') completeIntro()
        showResult(definition.cluster, startedAt, parsed.text)
        return { kind: 'completed', action: intent.kind, work: parsed.work }
      case 'inapplicable':
        showResult(definition.cluster, startedAt, parsed.text)
        return { kind: 'inapplicable', action: intent.kind }
      case 'partial':
        if (definition.cluster === 'download') completeIntro()
        showPartial(definition.cluster, startedAt, parsed.text)
        return {
          kind: 'partial',
          action: intent.kind,
          work: parsed.work,
          error: parsed.error,
        }
      case 'failed':
        showError(definition.cluster, startedAt, parsed.error)
        return { kind: 'failed', action: intent.kind, error: parsed.error }
    }
  }
  const run = (intent: PopupIntent): Promise<ActionOutcome> => {
    if (disposed) return Promise.resolve({ kind: 'inapplicable', action: intent.kind })
    if (active !== null) return Promise.resolve({ kind: 'busy', action: intent.kind, active })
    const definition = ACTIONS[intent.kind]
    setActive(intent.kind)
    const startedAt = clearClusterAtStart(definition.cluster)
    publish()
    return execute(intent, definition, startedAt).finally(() => {
      if (active === intent.kind) setActive(null)
      if (!disposed) publish()
    })
  }
  return {
    run,
    inspect: () => ({
      active: view.active,
      notices: {
        download: view.notices.download === null ? null : { ...view.notices.download },
      },
    }),
    subscribe: (listener) => {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      cancelNotice.download?.()
      cancelNotice.download = null
      setActive(null)
      view = initialView()
      listeners.clear()
    },
  }
}
