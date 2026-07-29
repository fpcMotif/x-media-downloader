import { Schema } from 'effect'
import { CLOUD_PROVIDERS } from '../schema'
import type { CloudProviderId } from './types'

const OwnerKey = Schema.String.check(
  Schema.isMinLength(64),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[\da-f]{64}$/u),
)
const TransitionId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))

export const ProviderOwnershipTransitionSchema = Schema.Struct({
  transitionId: TransitionId,
  provider: Schema.Literals(CLOUD_PROVIDERS),
  kind: Schema.Literals(['connect', 'disconnect']),
  beforeOwnerKey: Schema.NullOr(OwnerKey),
  afterOwnerKey: Schema.NullOr(OwnerKey),
})
export type ProviderOwnershipTransition = typeof ProviderOwnershipTransitionSchema.Type

interface ProviderRow {
  readonly provider: CloudProviderId
}

export interface ProviderOwnershipState {
  readonly jobs: ReadonlyArray<ProviderRow>
  readonly legacy: ReadonlyArray<ProviderRow>
  readonly quarantine: ReadonlyArray<ProviderRow>
  readonly ownershipTransitions: ReadonlyArray<ProviderOwnershipTransition>
}

export const ownershipTransitionFor = (
  state: ProviderOwnershipState,
  provider: CloudProviderId,
): ProviderOwnershipTransition | undefined =>
  state.ownershipTransitions.find((transition) => transition.provider === provider)

export const isCoherentOwnershipTransitions = (
  transitions: ReadonlyArray<ProviderOwnershipTransition>,
): boolean => {
  const providers = new Set<CloudProviderId>()
  for (const transition of transitions) {
    if (
      providers.has(transition.provider) ||
      (transition.kind === 'connect' && transition.afterOwnerKey === null) ||
      (transition.kind === 'disconnect' && transition.afterOwnerKey !== null)
    )
      return false
    providers.add(transition.provider)
  }
  return true
}

export interface BeginOwnershipTransitionResult<State extends ProviderOwnershipState> {
  readonly state: State
  readonly begun: boolean
}

/** Never overwrites unresolved intent. Recovery must settle it first. */
export function beginProviderOwnershipTransition<State extends ProviderOwnershipState>(
  state: State,
  transition: ProviderOwnershipTransition,
): BeginOwnershipTransitionResult<State> {
  if (ownershipTransitionFor(state, transition.provider) !== undefined)
    return { state, begun: false }
  const ownershipTransitions = [...state.ownershipTransitions, transition]
  if (!isCoherentOwnershipTransitions(ownershipTransitions)) return { state, begun: false }
  return {
    state: {
      ...state,
      ownershipTransitions,
    } as State,
    begun: true,
  }
}

export type OwnershipTransitionOutcome = 'absent' | 'committed' | 'retained' | 'aborted' | 'blocked'

export interface ReconcileOwnershipTransitionResult<State extends ProviderOwnershipState> {
  readonly state: State
  readonly outcome: OwnershipTransitionOutcome
  readonly changed: boolean
}

/**
 * Settings are the durable decision record. The new owner commits and purges old
 * rows. The old owner aborts without data loss. Any third value stays blocked.
 */
export function reconcileProviderOwnership<State extends ProviderOwnershipState>(
  state: State,
  provider: CloudProviderId,
  currentOwnerKey: string | null,
): ReconcileOwnershipTransitionResult<State> {
  const transition = ownershipTransitionFor(state, provider)
  if (transition === undefined) return { state, outcome: 'absent', changed: false }
  if (
    transition.kind === 'connect' &&
    transition.beforeOwnerKey === transition.afterOwnerKey &&
    currentOwnerKey === transition.afterOwnerKey
  )
    return {
      state: {
        ...state,
        ownershipTransitions: state.ownershipTransitions.filter(
          (candidate) => candidate.provider !== provider,
        ),
      } as State,
      outcome: 'retained',
      changed: true,
    }
  if (currentOwnerKey !== transition.afterOwnerKey) {
    if (currentOwnerKey !== transition.beforeOwnerKey)
      return { state, outcome: 'blocked', changed: false }
    return {
      state: {
        ...state,
        ownershipTransitions: state.ownershipTransitions.filter(
          (candidate) => candidate.provider !== provider,
        ),
      } as State,
      outcome: 'aborted',
      changed: true,
    }
  }
  return {
    state: {
      ...state,
      jobs: state.jobs.filter((row) => row.provider !== provider),
      legacy: state.legacy.filter((row) => row.provider !== provider),
      quarantine: state.quarantine.filter((row) => row.provider !== provider),
      ownershipTransitions: state.ownershipTransitions.filter(
        (candidate) => candidate.provider !== provider,
      ),
    } as State,
    outcome: 'committed',
    changed: true,
  }
}

/**
 * Explicit reconnect/disconnect recovery. Ambiguous provider work cannot run
 * under any account, so the user's replacement intent discards it atomically.
 */
export function discardProviderOwnership<State extends ProviderOwnershipState>(
  state: State,
  provider: CloudProviderId,
): State {
  return {
    ...state,
    jobs: state.jobs.filter((row) => row.provider !== provider),
    legacy: state.legacy.filter((row) => row.provider !== provider),
    quarantine: state.quarantine.filter((row) => row.provider !== provider),
    ownershipTransitions: state.ownershipTransitions.filter(
      (candidate) => candidate.provider !== provider,
    ),
  } as State
}
