/**
 * MV3 startup has independent failure domains. A corrupt transfer ledger must
 * fail downloads closed, without turning local UI into a blank error state.
 */
export type ReadinessFailure = 'retryable' | 'permanent'

export type Readiness =
  | { readonly tag: 'available' }
  | {
      readonly tag: 'unavailable'
      readonly failure: ReadinessFailure
      readonly reason: string
    }

export type BackgroundReadinessDomain = 'base' | 'fetched' | 'transfer' | 'clear' | 'cloud'

export type BackgroundReadiness = {
  readonly base: Promise<Readiness>
  readonly fetched: Promise<Readiness>
  readonly transfer: Promise<Readiness>
  readonly clear: Promise<Readiness>
  readonly cloud: Promise<Readiness>
  /** Retries only a failed retryable domain and the failed prerequisites it needs. */
  readonly retry: (domain: BackgroundReadinessDomain) => Promise<Readiness>
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Marks unsafe durable state. Automatic boot retries must never rewrite or loop on it. */
export class PermanentBackgroundBootError extends Error {
  override readonly name = 'PermanentBackgroundBootError'

  constructor(cause: unknown) {
    super(reasonOf(cause), { cause })
  }
}

type Slot = {
  current: Promise<Readiness>
  retrying?: Promise<Readiness>
}

export function makeBackgroundReadiness(deps: {
  readonly base: () => Promise<void>
  readonly fetched: () => Promise<void>
  readonly transfer: () => Promise<void>
  readonly clear: () => Promise<void>
  readonly cloud: () => Promise<void>
  readonly trace: (domain: BackgroundReadinessDomain, reason: string) => void
}): BackgroundReadiness {
  const settle = (
    domain: BackgroundReadinessDomain,
    run: () => Promise<void>,
  ): Promise<Readiness> =>
    run().then(
      () => ({ tag: 'available' as const }),
      (error) => {
        const reason = reasonOf(error)
        deps.trace(domain, reason)
        return {
          tag: 'unavailable' as const,
          failure:
            error instanceof PermanentBackgroundBootError
              ? ('permanent' as const)
              : ('retryable' as const),
          reason,
        }
      },
    )
  const blocked = (
    domain: Exclude<BackgroundReadinessDomain, 'base'>,
    state: Extract<Readiness, { readonly tag: 'unavailable' }>,
  ): Readiness => {
    const reason = `${domain} blocked: ${state.reason}`
    deps.trace(domain, reason)
    return { tag: 'unavailable', failure: state.failure, reason }
  }
  const after = (
    domain: Exclude<BackgroundReadinessDomain, 'base'>,
    prerequisite: Promise<Readiness>,
    run: () => Promise<void>,
  ): Promise<Readiness> =>
    prerequisite.then((state) =>
      state.tag === 'available' ? settle(domain, run) : blocked(domain, state),
    )

  const base = settle('base', deps.base)
  const fetched = after('fetched', base, deps.fetched)
  // Transfer boot deliberately waits for Fetched inspection, but Fetched
  // unavailability only removes Fetched recovery evidence; Direct stays viable.
  const transfer = base.then(async (state) => {
    if (state.tag === 'unavailable') return blocked('transfer', state)
    await fetched
    return await settle('transfer', deps.transfer)
  })
  const slots: Record<BackgroundReadinessDomain, Slot> = {
    base: { current: base },
    fetched: { current: fetched },
    transfer: { current: transfer },
    clear: { current: after('clear', transfer, deps.clear) },
    cloud: { current: after('cloud', base, deps.cloud) },
  }

  const retryAfter = async (
    domain: Exclude<BackgroundReadinessDomain, 'base' | 'transfer'>,
    prerequisite: BackgroundReadinessDomain,
    run: () => Promise<void>,
  ): Promise<Readiness> => {
    const state = await retry(prerequisite)
    return state.tag === 'available' ? await settle(domain, run) : blocked(domain, state)
  }
  const runRetry = async (domain: BackgroundReadinessDomain): Promise<Readiness> => {
    if (domain === 'base') return await settle('base', deps.base)
    if (domain === 'fetched') return await retryAfter('fetched', 'base', deps.fetched)
    if (domain === 'transfer') {
      const state = await retry('base')
      if (state.tag === 'unavailable') return blocked('transfer', state)
      await retry('fetched')
      return await settle('transfer', deps.transfer)
    }
    if (domain === 'clear') return await retryAfter('clear', 'transfer', deps.clear)
    return await retryAfter('cloud', 'base', deps.cloud)
  }
  const retry = (domain: BackgroundReadinessDomain): Promise<Readiness> => {
    const slot = slots[domain]
    if (slot.retrying !== undefined) return slot.retrying
    const previous = slot.current
    let guarded!: Promise<Readiness>
    const running = previous.then((state) =>
      state.tag === 'available' || state.failure === 'permanent' ? state : runRetry(domain),
    )
    guarded = running.finally(() => {
      if (slot.retrying === guarded) delete slot.retrying
    })
    slot.retrying = guarded
    slot.current = guarded
    return guarded
  }

  return {
    get base() {
      return slots.base.current
    },
    get fetched() {
      return slots.fetched.current
    },
    get transfer() {
      return slots.transfer.current
    },
    get clear() {
      return slots.clear.current
    },
    get cloud() {
      return slots.cloud.current
    },
    retry,
  }
}
