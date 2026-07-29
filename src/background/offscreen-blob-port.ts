import { isOffscreenBlobReply } from '../core/offscreen-blob-protocol'

export interface OffscreenBlobPort {
  readonly ensureDocument: () => Promise<void>
  readonly isDocumentPresent: () => Promise<boolean>
  readonly begin: (leaseId: string, mimeType: string) => Promise<void>
  readonly append: (leaseId: string, bytes: Uint8Array) => Promise<void>
  readonly finalize: (leaseId: string) => Promise<string>
  readonly discard: (leaseId: string) => Promise<void>
  readonly closeDocument: () => Promise<void>
}

export interface OffscreenPresencePort {
  readonly getContexts?: (filter: {
    readonly contextTypes: ReadonlyArray<'OFFSCREEN_DOCUMENT'>
    readonly documentUrls: ReadonlyArray<string>
  }) => Promise<ReadonlyArray<unknown>>
  readonly matchAllClients?: () => Promise<ReadonlyArray<{ readonly url: string }>>
}

export async function isOffscreenDocumentPresent(
  presence: OffscreenPresencePort,
  documentUrl: string,
): Promise<boolean> {
  if (presence.getContexts !== undefined) {
    const contexts = await presence.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [documentUrl],
    })
    return contexts.length > 0
  }
  return ((await presence.matchAllClients?.()) ?? []).some((client) => client.url === documentUrl)
}

const defaultOffscreenDocumentUrl = (): string => browser.runtime.getURL('/offscreen.html')
const sendOffscreen = async (request: unknown): Promise<unknown> =>
  browser.runtime.sendMessage(request)

/** Chromium runtime adapter. The background worker alone owns browser downloads. */
export function makeOffscreenBlobPort(
  opts: {
    readonly presence?: OffscreenPresencePort
    readonly documentUrl?: string
  } = {},
): OffscreenBlobPort {
  const documentUrl = opts.documentUrl ?? defaultOffscreenDocumentUrl()
  const runtime = browser.runtime as unknown as {
    readonly getContexts?: OffscreenPresencePort['getContexts']
  }
  const clientScope = globalThis as typeof globalThis & {
    readonly clients?: {
      readonly matchAll: () => Promise<ReadonlyArray<{ readonly url: string }>>
    }
  }
  const presence = opts.presence ?? {
    ...(runtime.getContexts === undefined
      ? {}
      : {
          getContexts: (filter: Parameters<NonNullable<OffscreenPresencePort['getContexts']>>[0]) =>
            runtime.getContexts!(filter),
        }),
    ...(clientScope.clients === undefined
      ? {}
      : { matchAllClients: () => clientScope.clients!.matchAll() }),
  }
  let opening: Promise<void> | null = null
  const call = async (message: unknown): Promise<ReturnType<typeof parseReply>> => {
    const reply = parseReply(await sendOffscreen(message))
    if (reply._tag === 'OffscreenBlobError') throw new Error(reply.reason)
    return reply
  }
  return {
    isDocumentPresent: () => isOffscreenDocumentPresent(presence, documentUrl),
    ensureDocument: async () => {
      if (await isOffscreenDocumentPresent(presence, documentUrl)) return
      if (opening === null)
        opening = browser.offscreen
          .createDocument({
            url: '/offscreen.html',
            reasons: ['BLOBS'],
            justification: 'Build bounded media Blob URLs for browser downloads',
          })
          .finally(() => {
            opening = null
          })
      await opening
    },
    begin: async (leaseId, mimeType) => {
      const reply = await call({
        _tag: 'OffscreenBlobBegin',
        leaseId,
        mimeType,
      })
      if (reply._tag !== 'OffscreenBlobOk') throw new Error('invalid offscreen begin reply')
    },
    append: async (leaseId, bytes) => {
      const reply = await call({
        _tag: 'OffscreenBlobAppend',
        leaseId,
        bytes: Array.from(bytes),
      })
      if (reply._tag !== 'OffscreenBlobOk') throw new Error('invalid offscreen append reply')
    },
    finalize: async (leaseId) => {
      const reply = await call({ _tag: 'OffscreenBlobFinalize', leaseId })
      if (reply._tag !== 'OffscreenBlobFinalized')
        throw new Error('invalid offscreen finalize reply')
      return reply.objectUrl
    },
    discard: async (leaseId) => {
      const reply = await call({ _tag: 'OffscreenBlobDiscard', leaseId })
      if (reply._tag !== 'OffscreenBlobOk') throw new Error('invalid offscreen discard reply')
    },
    closeDocument: () => browser.offscreen.closeDocument(),
  }
}

function parseReply(value: unknown) {
  if (!isOffscreenBlobReply(value)) throw new Error('invalid offscreen Blob reply')
  return value
}
