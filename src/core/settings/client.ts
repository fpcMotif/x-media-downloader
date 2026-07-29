import { expectReply, safeSend } from '../messaging'
import {
  decodeSettingsUpdateResponse,
  type Settings,
  type SettingsUiPatch,
  type SettingsUpdateRequest,
} from '../schema'

/** The only capability a UI settings client needs from runtime messaging. */
export type SettingsUpdateSender = (request: SettingsUpdateRequest) => Promise<unknown>

export type SettingsUpdateErrorCode =
  | 'context-invalidated'
  | 'send-failed'
  | 'unclaimed'
  | 'malformed-response'
  | 'rejected'

export class SettingsUpdateError extends Error {
  override readonly name = 'SettingsUpdateError'

  constructor(
    readonly code: SettingsUpdateErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
  }
}

export interface SettingsClient {
  readonly update: (patch: SettingsUiPatch) => Promise<Settings>
}

/**
 * UI-side adapter for the background-owned Settings writer. The sender is
 * injected so the protocol can be tested without Chrome runtime globals.
 */
export const makeSettingsClient = (send: SettingsUpdateSender): SettingsClient => ({
  update: async (patch) => {
    const request: SettingsUpdateRequest = {
      _tag: 'SettingsUpdateRequest',
      patch: { ...patch },
    }
    const reply = expectReply(await safeSend(() => send(request)))
    switch (reply.status) {
      case 'context-invalidated':
        throw new SettingsUpdateError(
          'context-invalidated',
          'The extension was reloaded. Refresh this page and try again.',
        )
      case 'error':
        throw new SettingsUpdateError(
          'send-failed',
          'Settings could not reach the background.',
          reply.error,
        )
      case 'unclaimed':
        throw new SettingsUpdateError(
          'unclaimed',
          'The background did not accept the Settings change.',
        )
      case 'ok': {
        const decoded = decodeSettingsUpdateResponse(reply.reply)
        if (decoded === undefined) {
          throw new SettingsUpdateError(
            'malformed-response',
            'The background returned an invalid Settings response.',
            reply.reply,
          )
        }
        if (decoded._tag === 'SettingsUpdateFailure') {
          throw new SettingsUpdateError('rejected', decoded.reason)
        }
        return decoded.settings
      }
    }
  },
})

const runtimeSettingsClient = makeSettingsClient((request) => browser.runtime.sendMessage(request))

/** Commit a UI Settings patch through the background-owned writer. */
export const updateSettings = (patch: SettingsUiPatch): Promise<Settings> =>
  runtimeSettingsClient.update(patch)
