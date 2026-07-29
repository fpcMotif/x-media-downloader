import { Result } from 'effect'
import {
  decodeBackgroundRequest,
  readBackgroundRequestTag,
  type BackgroundRequest,
} from '../core/schema'
import { isMessageAllowed, type MessageSenderLike } from '../core/sender-guard'
import {
  messageReadinessDomain,
  unavailableMessageReply,
  type MessageReadinessDomain,
} from './message-readiness'
import type { Readiness } from './readiness'

export interface BackgroundMessageSender extends MessageSenderLike {
  readonly tab?: { readonly id?: number | undefined } | undefined
}

export type BackgroundMessageHandler<Tag extends BackgroundRequest['_tag']> = (
  message: Extract<BackgroundRequest, { _tag: Tag }>,
  sender: BackgroundMessageSender,
) => Promise<unknown>

export type BackgroundMessageHandlers = {
  readonly [Tag in BackgroundRequest['_tag']]?: BackgroundMessageHandler<Tag>
}

/** Production inventory: every decoded request must have one handler. Tests may
 * keep using the partial table above to exercise isolated router paths. */
export type CompleteBackgroundMessageHandlers = {
  readonly [Tag in BackgroundRequest['_tag']]-?: BackgroundMessageHandler<Tag>
}

/** TypeScript loses tag/union correlation on indexed access; keep that cast in the router. */
const handlerFor = <Tag extends BackgroundRequest['_tag']>(
  handlers: BackgroundMessageHandlers,
  tag: Tag,
): BackgroundMessageHandler<Tag> | undefined =>
  handlers[tag] as BackgroundMessageHandler<Tag> | undefined

export type BackgroundMessageListener = (
  message: unknown,
  sender: BackgroundMessageSender | undefined,
  sendResponse: (reply: unknown) => void,
) => boolean

export const narrowMessageHandler =
  <Tag extends BackgroundRequest['_tag']>(
    handler: (
      message: Extract<BackgroundRequest, { _tag: Tag }>,
      sender: BackgroundMessageSender,
    ) => Promise<unknown>,
  ): BackgroundMessageHandler<Tag> =>
  (message, sender) =>
    handler(message as Extract<BackgroundRequest, { _tag: Tag }>, sender)

const protocolFailureStage = (tag: BackgroundRequest['_tag']): string | undefined => {
  switch (tag) {
    case 'SettingsReadRequest':
      return 'settings-read-unavailable'
    case 'SettingsRecoveryRequest':
      return 'settings-recovery-unavailable'
    case 'DailyBudgetReadRequest':
      return 'daily-budget-read-unavailable'
    case 'DailyBudgetResetRequest':
      return 'daily-budget-reset-unavailable'
    case 'ClearLogRequest':
      return 'clear-log-unavailable'
    case 'TransferRecoveryRequest':
      return undefined
  }
}

const requireReply = (tag: BackgroundRequest['_tag'], reply: unknown): unknown => {
  if (reply === undefined) throw new Error(`${tag} handler returned undefined`)
  return reply
}

const handlerError = (tag: BackgroundRequest['_tag'], error: unknown): Error =>
  new Error(
    `${tag}: ${error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown failure'}`,
    { cause: error },
  )

export function makeBackgroundMessageListener(deps: {
  readonly ownId: string
  readonly handlers: BackgroundMessageHandlers
  readonly waitFor: (domain: MessageReadinessDomain) => Promise<Readiness>
  readonly trace: (stage: string, error: unknown) => void
  readonly warn: (message: string, detail?: unknown) => void
}): BackgroundMessageListener {
  return (raw, sender, sendResponse) => {
    const rawTag = readBackgroundRequestTag(raw)
    const decoded = decodeBackgroundRequest(raw)
    if (Result.isFailure(decoded)) {
      if (typeof rawTag === 'string')
        deps.warn(`[XMD] message ${rawTag} FAILED schema decode (dropped):`, decoded.failure)
      return false
    }
    const message = decoded.success
    if (sender === undefined || !isMessageAllowed(message._tag, sender, deps.ownId)) {
      deps.warn(
        `[XMD] message ${message._tag} BLOCKED by sender guard (contentScript=${sender?.tab !== undefined && sender.tab !== null})`,
      )
      return false
    }
    const handler = handlerFor(deps.handlers, message._tag)
    if (handler === undefined) return false
    const domain = messageReadinessDomain(message)
    void deps
      .waitFor(domain)
      .then((state) => {
        if (state.tag === 'available') return handler(message, sender)
        const unavailable = unavailableMessageReply(message)
        if (unavailable !== undefined) return unavailable.value
        throw new Error(`${domain} unavailable: ${state.reason}`)
      })
      .then((reply) => requireReply(message._tag, reply))
      .then(sendResponse)
      .catch((error) => {
        const unavailable = unavailableMessageReply(message)
        const stage = protocolFailureStage(message._tag)
        if (stage === undefined)
          deps.trace('message-handler-failed', handlerError(message._tag, error))
        else deps.trace(stage, error)
        sendResponse(unavailable?.value ?? { ok: false, error: 'handler failed' })
      })
    return true
  }
}
