import { expectReply, safeSend } from '../messaging'
import {
  decodeSettingsRecoveryResponse,
  type SettingsRecoveryRequest,
  type SettingsRecoveryResponse,
} from '../schema/settings-recovery'

export type SettingsRecoverySender = (request: SettingsRecoveryRequest) => Promise<unknown>

export interface SettingsRecoveryClient {
  readonly inspect: () => Promise<SettingsRecoveryResponse>
  readonly recover: (
    action: 'repair' | 'reset',
    fingerprint: string,
  ) => Promise<SettingsRecoveryResponse>
}

const unavailable = (): SettingsRecoveryResponse => ({
  _tag: 'SettingsRecoveryFailure',
  reason: 'unavailable',
})

/** Options-side adapter for the background-owned Settings Recovery interface. */
export const makeSettingsRecoveryClient = (
  send: SettingsRecoverySender,
): SettingsRecoveryClient => {
  const request = async (message: SettingsRecoveryRequest): Promise<SettingsRecoveryResponse> => {
    const reply = expectReply(await safeSend(() => send(message)))
    if (reply.status !== 'ok') return unavailable()
    return decodeSettingsRecoveryResponse(reply.reply) ?? unavailable()
  }

  return {
    inspect: () => request({ _tag: 'SettingsRecoveryRequest', action: 'inspect' }),
    recover: (action, fingerprint) =>
      request({
        _tag: 'SettingsRecoveryRequest',
        action,
        fingerprint,
      }),
  }
}

const runtimeClient = makeSettingsRecoveryClient((request) => browser.runtime.sendMessage(request))

export const inspectSettingsRecovery = (): Promise<SettingsRecoveryResponse> =>
  runtimeClient.inspect()

export const confirmSettingsRecovery = (
  action: 'repair' | 'reset',
  fingerprint: string,
): Promise<SettingsRecoveryResponse> => runtimeClient.recover(action, fingerprint)
