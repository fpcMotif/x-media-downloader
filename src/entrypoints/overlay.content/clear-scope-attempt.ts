import { Option } from 'effect'
import {
  CLEAR_TESTID,
  CLEARED_STUB_ATTR,
  alreadyCleared,
  caretControl,
  cellOf,
  clearControl,
  findArticle,
  findFeedbackButton,
  findNotInterestedItem,
  flipConfirmed,
  isMember,
  notInterestedConfirmed,
} from '../../core/clear/clearer'
import type { ClearScope, ClearTweetState } from '../../core/schema'

const POLL_INTERVAL_MS = 200
const POLL_ATTEMPTS = 6
const CONFIRM_TIMEOUT_MS = POLL_ATTEMPTS * POLL_INTERVAL_MS

type ClearAttemptPhase = 'preflight' | 'attempted' | 'verified'

export interface ClearScopeAttemptDeps {
  readonly document: Document
  readonly wait?: (delayMs: number) => Promise<void>
  readonly trace?: (...args: unknown[]) => void
}

const stateAfterThrow = (phase: ClearAttemptPhase): ClearTweetState =>
  phase === 'preflight' ? 'preflight-failed' : phase === 'attempted' ? 'uncertain' : 'cleared'

const actionTestids = (article: Element): string[] =>
  [...article.querySelectorAll('[data-testid]')]
    .map((element) => element.getAttribute('data-testid') ?? '')
    .filter((testId) => /bookmark|like/i.test(testId))

/** Owns the exact DOM mutation boundary and maps every thrown path fail-closed. */
export const makeClearScopeAttempt = (
  deps: ClearScopeAttemptDeps,
): ((tweetId: string, scope: ClearScope) => Promise<ClearTweetState>) => {
  const wait = deps.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)))
  const trace = deps.trace

  const dismissMenu = (): void => {
    deps.document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }

  const dismissFeedbackStub = async (cell: Element | null): Promise<void> => {
    if (cell === null) return
    // oxlint-disable no-await-in-loop -- short bounded poll for the follow-up panel.
    for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
      const feedback = findFeedbackButton(cell)
      if (Option.isSome(feedback)) {
        trace?.('notInterested', '→ dismissing feedback stub:', feedback.value.textContent?.trim())
        ;(
          (feedback.value.closest('button,[role="button"]') as HTMLElement | null) ?? feedback.value
        ).click()
        return
      }
      await wait(POLL_INTERVAL_MS)
    }
    // oxlint-enable no-await-in-loop
  }

  const clearNotInterested = async (
    article: Element,
    tweetId: string,
    setPhase: (phase: ClearAttemptPhase) => void,
  ): Promise<ClearTweetState> => {
    const caret = caretControl(article)
    if (caret === null) {
      trace?.('notInterested', tweetId, '→ no caret control (selector rot?)')
      return 'preflight-failed'
    }
    const cell = cellOf(article)
    const caretTarget = (caret.closest('button,[role="button"]') as HTMLElement | null) ?? caret
    const before = new Set(deps.document.querySelectorAll('[role="menu"]'))
    trace?.('notInterested', tweetId, '→ opening caret menu')
    caretTarget.click()
    let item: HTMLElement | null = null
    // oxlint-disable no-await-in-loop -- staged poll with a fixed cap.
    for (let attempt = 1; attempt <= POLL_ATTEMPTS && item === null; attempt += 1) {
      await wait(POLL_INTERVAL_MS)
      const opened = [...deps.document.querySelectorAll('[role="menu"]')].filter(
        (menu) => !before.has(menu),
      )
      if (opened.length > 1) break
      const [sole] = opened
      if (sole !== undefined) item = Option.getOrNull(findNotInterestedItem(sole))
    }
    if (item === null) {
      trace?.('notInterested', '→ own menu/item not found; dismissing')
      dismissMenu()
      return 'preflight-failed'
    }
    trace?.('notInterested', '→ clicking "Not interested in this post"')
    setPhase('attempted')
    item.click()
    for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
      await wait(POLL_INTERVAL_MS)
      if (notInterestedConfirmed(article)) {
        setPhase('verified')
        trace?.('notInterested', `→ confirmed after ${attempt * POLL_INTERVAL_MS}ms`)
        cell?.setAttribute(CLEARED_STUB_ATTR, '')
        await dismissFeedbackStub(cell)
        return 'cleared'
      }
    }
    // oxlint-enable no-await-in-loop
    trace?.('notInterested', '→ NO collapse; dismissing')
    dismissMenu()
    return 'uncertain'
  }

  const run = async (
    tweetId: string,
    scope: ClearScope,
    setPhase: (phase: ClearAttemptPhase) => void,
  ): Promise<ClearTweetState> => {
    const article = findArticle(deps.document, tweetId)
    if (Option.isNone(article)) {
      trace?.(scope, tweetId, '→ no matching article on page')
      return 'preflight-failed'
    }
    if (scope === 'notInterested') return await clearNotInterested(article.value, tweetId, setPhase)
    if (!isMember(article.value, scope)) {
      const cleared = alreadyCleared(article.value, scope)
      trace?.(
        scope,
        '→ not a member; alreadyCleared =',
        cleared,
        '· testids present:',
        actionTestids(article.value),
      )
      return cleared ? 'already-clear' : 'not-actionable'
    }
    const control = clearControl(article.value, scope)
    if (control === null) {
      trace?.(scope, '→ member but control not found (selector rot?)', actionTestids(article.value))
      return 'preflight-failed'
    }
    const target = (control.closest('button,[role="button"]') as HTMLElement | null) ?? control
    trace?.(scope, '→ clicking', CLEAR_TESTID[scope].active)
    setPhase('attempted')
    target.click()
    // oxlint-disable no-await-in-loop -- sequential poll with a fixed cap.
    for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
      await wait(POLL_INTERVAL_MS)
      if (flipConfirmed(article.value, scope)) {
        setPhase('verified')
        trace?.(scope, `→ flip confirmed after ${attempt * POLL_INTERVAL_MS}ms`)
        return 'cleared'
      }
    }
    // oxlint-enable no-await-in-loop
    trace?.(
      scope,
      `→ NO flip after ${CONFIRM_TIMEOUT_MS / 1000}s · testids now:`,
      actionTestids(article.value),
    )
    return 'uncertain'
  }

  return async (tweetId, scope) => {
    let phase: ClearAttemptPhase = 'preflight'
    try {
      return await run(tweetId, scope, (next) => {
        phase = next
      })
    } catch {
      return stateAfterThrow(phase)
    }
  }
}
