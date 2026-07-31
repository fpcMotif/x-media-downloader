import type { MediaItem } from '@/packages/schema'

/** Locate a fresh MediaItem for retry — prefer exact id, else postId+index+type. */
export function findFreshMediaItem(
  target: Pick<MediaItem, 'id' | 'postId' | 'index' | 'type'>,
  candidates: ReadonlyArray<MediaItem>,
): MediaItem | undefined {
  const byId = candidates.find((c) => c.id === target.id)
  if (byId !== undefined) return byId
  const matches = candidates.filter(
    (c) => c.postId === target.postId && c.index === target.index && c.type === target.type,
  )
  return matches.length === 1 ? matches[0] : undefined
}

/** Tab messaging port for unit tests. */
export interface TabMessagingPort {
  readonly queryTabs: () => Promise<ReadonlyArray<{ readonly id: number }>>
  readonly sendTabMessage: (
    tabId: number,
    message: {
      readonly _tag: 'RefreshMediaUrlRequest'
      readonly itemId: string
      readonly tweetId: string
      readonly index?: number
      readonly type?: MediaItem['type']
    },
  ) => Promise<{ readonly url?: string } | undefined>
}

/** Ask an open X tab's content script for a fresher CDN url before retry. */
export async function refreshMediaUrlFromTabs(
  item: MediaItem,
  port: TabMessagingPort,
): Promise<string | null> {
  const tabs = await port.queryTabs()
  const message = {
    _tag: 'RefreshMediaUrlRequest' as const,
    itemId: item.id,
    tweetId: item.postId,
    index: item.index,
    type: item.type,
  }
  for (const tab of tabs) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential: first tab to answer wins; don't fan out to every tab
      const res = await port.sendTabMessage(tab.id, message)
      if (typeof res?.url === 'string' && res.url.length > 0) return res.url
    } catch {
      /* tab has no injected content script */
    }
  }
  return null
}
