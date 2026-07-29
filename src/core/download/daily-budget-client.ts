import { expectReply, safeSend } from '../messaging'
import {
  decodeDailyBudgetReadResponse,
  decodeDailyBudgetResetResponse,
  type DailyBudgetReadRequest,
  type DailyBudgetResetRequest,
  type DailyBudgetUsage,
} from '../schema/daily-budget'

export type DailyBudgetSender = (
  request: DailyBudgetReadRequest | DailyBudgetResetRequest,
) => Promise<unknown>

export type DailyBudgetUsageOutcome =
  | { readonly status: 'available'; readonly usage: DailyBudgetUsage }
  | { readonly status: 'unavailable' }

/** UI-only bridge to the background-owned daily-budget store. */
export const makeDailyBudgetClient = (send: DailyBudgetSender) => ({
  readToday: async (): Promise<DailyBudgetUsageOutcome> => {
    const reply = expectReply(await safeSend(() => send({ _tag: 'DailyBudgetReadRequest' })))
    if (reply.status !== 'ok') return { status: 'unavailable' }
    const decoded = decodeDailyBudgetReadResponse(reply.reply)
    if (decoded === undefined || decoded._tag === 'DailyBudgetUnavailable') {
      return { status: 'unavailable' }
    }
    return { status: 'available', usage: decoded.usage }
  },
  resetToday: async (): Promise<DailyBudgetUsageOutcome> => {
    const reply = expectReply(await safeSend(() => send({ _tag: 'DailyBudgetResetRequest' })))
    if (reply.status !== 'ok') return { status: 'unavailable' }
    const decoded = decodeDailyBudgetResetResponse(reply.reply)
    if (decoded === undefined || decoded._tag === 'DailyBudgetUnavailable') {
      return { status: 'unavailable' }
    }
    return { status: 'available', usage: decoded.usage }
  },
})

const runtimeDailyBudgetClient = makeDailyBudgetClient((request) =>
  browser.runtime.sendMessage(request),
)

export const readDailyBudgetToday = (): Promise<DailyBudgetUsageOutcome> =>
  runtimeDailyBudgetClient.readToday()

export const resetDailyBudgetToday = (): Promise<DailyBudgetUsageOutcome> =>
  runtimeDailyBudgetClient.resetToday()
