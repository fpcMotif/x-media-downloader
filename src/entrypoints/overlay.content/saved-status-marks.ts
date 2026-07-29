import { Option } from 'effect'
import { TWEET_ARTICLE_SEL } from '../../core/adapters/x/dom'
import { tweetIdOfArticle } from '../../core/clear/clearer'

const SAVED_CHIP_CLASS = 'xdl-saved-chip'
const POSITION_OWNER_ATTRIBUTE = 'data-xdl-saved-position-owner'

/** Remove Saved-status marks and only the host style this feature installed. */
export const clearSavedStatusMarks = (doc: Document): void => {
  for (const chip of doc.querySelectorAll(`.${SAVED_CHIP_CLASS}`)) chip.remove()
  for (const host of doc.querySelectorAll(`[${POSITION_OWNER_ATTRIBUTE}]`)) {
    if (host instanceof HTMLElement && host.style.position === 'relative')
      host.style.removeProperty('position')
    host.removeAttribute(POSITION_OWNER_ATTRIBUTE)
  }
}

/** Inject one mark. The ownership marker makes the host mutation reversible. */
export const markArticleSaved = (article: Element, doc: Document): void => {
  if (article.querySelector(`.${SAVED_CHIP_CLASS}`) !== null) return
  if (article instanceof HTMLElement && article.style.position === '') {
    article.style.position = 'relative'
    article.setAttribute(POSITION_OWNER_ATTRIBUTE, '')
  }
  const chip = doc.createElement('div')
  chip.className = SAVED_CHIP_CLASS
  chip.textContent = 'Saved ✓'
  chip.setAttribute('aria-label', 'Already downloaded')
  article.appendChild(chip)
}

/** Saved status appears only on X home and List timelines. */
export const isSavedStatusScope = (pathname: string): boolean =>
  pathname === '/home' || /^\/i\/lists\/\d+/.test(pathname)

export const savedStatusVisible = (pathname: string, showSavedStatus: boolean): boolean =>
  showSavedStatus && isSavedStatusScope(pathname)

/**
 * Mark the positive subset returned by the background. Scope is checked before
 * and after the request so stale SPA replies cannot paint a new route.
 */
export async function sweepSavedStatus(deps: {
  readonly document: Document
  readonly inScope: () => boolean
  readonly requestSavedStatus: (tweetIds: string[]) => Promise<string[]>
}): Promise<void> {
  if (!deps.inScope()) return
  const byTweet = new Map<string, Element>()
  for (const article of deps.document.querySelectorAll(TWEET_ARTICLE_SEL)) {
    const tweetId = tweetIdOfArticle(article)
    if (Option.isNone(tweetId) || byTweet.has(tweetId.value)) continue
    byTweet.set(tweetId.value, article)
  }
  if (byTweet.size === 0) return
  const saved = await deps.requestSavedStatus([...byTweet.keys()])
  if (!deps.inScope()) return
  for (const tweetId of saved) {
    const article = byTweet.get(tweetId)
    if (article !== undefined) markArticleSaved(article, deps.document)
  }
}
