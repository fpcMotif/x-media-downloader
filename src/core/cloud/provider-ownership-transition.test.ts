import { describe, expect, it } from 'vitest'
import {
  beginProviderOwnershipTransition,
  discardProviderOwnership,
  reconcileProviderOwnership,
  type ProviderOwnershipTransition,
} from './provider-ownership-transition'

const OLD = 'a'.repeat(64)
const NEW = 'b'.repeat(64)
const UNKNOWN = 'c'.repeat(64)

const connect: ProviderOwnershipTransition = {
  transitionId: 'connect-1',
  provider: 'gdrive',
  kind: 'connect',
  beforeOwnerKey: OLD,
  afterOwnerKey: NEW,
}

const state = () => ({
  jobs: [{ provider: 'gdrive' as const }, { provider: 'dropbox' as const }],
  legacy: [{ provider: 'gdrive' as const }, { provider: 'dropbox' as const }],
  quarantine: [{ provider: 'gdrive' as const }, { provider: 'dropbox' as const }],
  ownershipTransitions: [] as ReadonlyArray<ProviderOwnershipTransition>,
})

describe('Cloud Ownership Transition', () => {
  it('never overwrites unresolved intent for the same provider', () => {
    const begun = beginProviderOwnershipTransition(state(), connect)
    expect(begun.begun).toBe(true)
    const duplicate = beginProviderOwnershipTransition(begun.state, {
      ...connect,
      transitionId: 'connect-2',
    })
    expect(duplicate).toEqual({ state: begun.state, begun: false })
  })

  it('refuses incoherent intent before it reaches durable state', () => {
    expect(
      beginProviderOwnershipTransition(state(), {
        ...connect,
        afterOwnerKey: null,
      }),
    ).toEqual({ state: state(), begun: false })
  })

  it('aborts on the old owner and preserves every row', () => {
    const begun = beginProviderOwnershipTransition(state(), connect).state
    const reconciled = reconcileProviderOwnership(begun, 'gdrive', OLD)
    expect(reconciled).toMatchObject({ outcome: 'aborted', changed: true })
    expect(reconciled.state.jobs).toEqual(state().jobs)
    expect(reconciled.state.legacy).toEqual(state().legacy)
    expect(reconciled.state.quarantine).toEqual(state().quarantine)
    expect(reconciled.state.ownershipTransitions).toEqual([])
  })

  it('commits on the new owner and purges only that provider', () => {
    const begun = beginProviderOwnershipTransition(state(), connect).state
    const reconciled = reconcileProviderOwnership(begun, 'gdrive', NEW)
    expect(reconciled).toMatchObject({ outcome: 'committed', changed: true })
    expect(reconciled.state.jobs).toEqual([{ provider: 'dropbox' }])
    expect(reconciled.state.legacy).toEqual([{ provider: 'dropbox' }])
    expect(reconciled.state.quarantine).toEqual([{ provider: 'dropbox' }])
    expect(reconciled.state.ownershipTransitions).toEqual([])
  })

  it('retains rows when reconnect keeps the same owner', () => {
    const begun = beginProviderOwnershipTransition(state(), {
      ...connect,
      afterOwnerKey: OLD,
    }).state
    const reconciled = reconcileProviderOwnership(begun, 'gdrive', OLD)
    expect(reconciled).toMatchObject({ outcome: 'retained', changed: true })
    expect(reconciled.state.jobs).toEqual(state().jobs)
    expect(reconciled.state.legacy).toEqual(state().legacy)
    expect(reconciled.state.quarantine).toEqual(state().quarantine)
    expect(reconciled.state.ownershipTransitions).toEqual([])
  })

  it('commits disconnect when Settings has no owner', () => {
    const transition: ProviderOwnershipTransition = {
      transitionId: 'disconnect-1',
      provider: 'gdrive',
      kind: 'disconnect',
      beforeOwnerKey: OLD,
      afterOwnerKey: null,
    }
    const begun = beginProviderOwnershipTransition(state(), transition).state
    expect(reconcileProviderOwnership(begun, 'gdrive', null).outcome).toBe('committed')
  })

  it('keeps intent and rows blocked on an unknown owner', () => {
    const begun = beginProviderOwnershipTransition(state(), connect).state
    const reconciled = reconcileProviderOwnership(begun, 'gdrive', UNKNOWN)
    expect(reconciled).toEqual({
      state: begun,
      outcome: 'blocked',
      changed: false,
    })
  })

  it('discards only the provider chosen for explicit recovery', () => {
    const begun = beginProviderOwnershipTransition(state(), connect).state
    const discarded = discardProviderOwnership(begun, 'gdrive')
    expect(discarded.jobs).toEqual([{ provider: 'dropbox' }])
    expect(discarded.legacy).toEqual([{ provider: 'dropbox' }])
    expect(discarded.quarantine).toEqual([{ provider: 'dropbox' }])
    expect(discarded.ownershipTransitions).toEqual([])
  })
})
