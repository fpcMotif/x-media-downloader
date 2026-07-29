import { describe, expect, it } from 'vitest'
import {
  historyActionsForTerminal,
  syncEventsForTerminal,
  terminalProjectionFromEntry,
  type TerminalProjection,
} from './terminal-outcome'
import type { TransferEntry } from './transfer-registry-model'

const NOW = 1_000

describe('terminalProjectionFromEntry', () => {
  it('exports only terminal truth, never the original URL', () => {
    const entry: TransferEntry = {
      createdAt: 10,
      request: {
        id: 'media-1',
        projectionId: 'terminal-1',
        url: 'https://secret.example/original',
        filename: 'media.jpg',
        mode: 'aria2',
        historyPolicy: 'record',
      },
      phase: {
        tag: 'terminal-pending',
        observedAt: NOW,
        projectAt: NOW,
        evidence: {
          tag: 'aria2',
          gid: '0000000000000001',
          profileId: 'profile-1',
          status: 'complete',
          completedLength: '7',
          totalLength: '7',
        },
      },
    }

    expect(terminalProjectionFromEntry(entry)).toEqual({
      projectionId: 'terminal-1',
      requestId: 'media-1',
      logicalRequestId: 'media-1',
      createdAt: 10,
      observedAt: NOW,
      outcome: 'complete',
      mode: 'aria2',
      historyPolicy: 'record',
      filename: 'media.jpg',
      evidence: {
        tag: 'aria2',
        gid: '0000000000000001',
        profileId: 'profile-1',
        status: 'complete',
        completedLength: '7',
        totalLength: '7',
      },
    })
  })

  it('keeps new queued and terminal projections on one canonical request id', () => {
    const item = {
      id: 'shared',
      platform: 'instagram' as const,
      postId: 'post-1',
      author: 'alice',
      type: 'photo' as const,
      url: 'https://scontent.cdninstagram.com/v/t51.82787-15/shared.jpg',
      ext: 'jpg',
      index: 0,
    }
    const projection: TerminalProjection = {
      projectionId: 'projection-1',
      requestId: 'xmd:v1:media:instagram:6:shared',
      logicalRequestId: 'xmd:v1:media:instagram:6:shared',
      createdAt: 10,
      observedAt: 20,
      outcome: 'complete',
      mode: 'direct',
      historyPolicy: 'record',
      filename: 'shared.jpg',
      item,
      evidence: { tag: 'browser', downloadId: 1, state: 'complete' },
    }

    expect(historyActionsForTerminal(projection).map((action) => action.requestId)).toEqual([
      'xmd:v1:media:instagram:6:shared',
      'xmd:v1:media:instagram:6:shared',
    ])
    expect(syncEventsForTerminal(projection, 'device-1').map((event) => event.requestId)).toEqual([
      'xmd:v1:media:instagram:6:shared',
      'xmd:v1:media:instagram:6:shared',
    ])
  })

  it('splits a legacy correlation key from canonical History and UI identity', () => {
    const item = {
      id: 'shared',
      platform: 'instagram' as const,
      postId: 'post-1',
      author: 'alice',
      type: 'photo' as const,
      url: 'https://scontent.cdninstagram.com/v/t51.82787-15/shared.jpg',
      ext: 'jpg',
      index: 0,
    }
    const projection: TerminalProjection = {
      projectionId: 'legacy-projection',
      requestId: 'shared',
      logicalRequestId: 'xmd:v1:media:instagram:6:shared',
      createdAt: 10,
      observedAt: 20,
      outcome: 'complete',
      mode: 'direct',
      historyPolicy: 'transition-only',
      filename: 'shared.jpg',
      item,
      evidence: { tag: 'browser', downloadId: 1, state: 'complete' },
    }

    expect(historyActionsForTerminal(projection)).toMatchObject([
      { requestId: 'xmd:v1:media:instagram:6:shared' },
    ])
    expect(syncEventsForTerminal(projection, 'device-1')).toMatchObject([{ requestId: 'shared' }])
  })
})
