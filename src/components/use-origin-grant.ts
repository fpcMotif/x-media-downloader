import { Option } from 'effect'
import { useEffect, useState } from 'preact/hooks'
import { browser } from 'wxt/browser'

export type OriginGrant =
  'no-origin' | 'checking' | 'granted' | 'denied' | 'check-failed' | 'request-failed'

export type GrantAnswers = ReadonlyMap<string, OriginGrant>

export interface OriginGrantHandle {
  readonly grant: OriginGrant
  readonly request: () => Promise<void>
}

const NO_ANSWERS: GrantAnswers = new Map()

export const grantOf = (allowed: boolean): 'granted' | 'denied' => (allowed ? 'granted' : 'denied')

export const queryGrant = async (
  pattern: Option.Option<string>,
  ask: (origin: string) => Promise<boolean>,
): Promise<OriginGrant> => {
  if (Option.isNone(pattern)) return 'no-origin'
  try {
    return grantOf(await ask(pattern.value))
  } catch {
    return 'check-failed'
  }
}

export const offersGrantRequest = (grant: OriginGrant): boolean =>
  grant === 'denied' || grant === 'request-failed'

export const currentGrant = (pattern: Option.Option<string>, answers: GrantAnswers): OriginGrant =>
  Option.isNone(pattern) ? 'no-origin' : (answers.get(pattern.value) ?? 'checking')

export const withAnswer =
  (origin: string, grant: OriginGrant) =>
  (answers: GrantAnswers): GrantAnswers =>
    new Map(answers).set(origin, grant)

const containsOrigin = (origin: string): Promise<boolean> =>
  browser.permissions.contains({ origins: [origin] })

const requestOrigin = (origin: string): Promise<boolean> =>
  browser.permissions.request({ origins: [origin] })

/** Tracks whether the extension holds host access to one origin pattern. Each
 *  answer is stored under the origin it is for, so a new origin reads
 *  `checking` until Chrome answers for it, never another origin's answer.
 *  @param pattern The match pattern to check, or `Option.none()` when there is
 *  nothing to check.
 *  @returns `request` opens Chrome's permission prompt. Call it straight from a
 *  click handler: Chrome rejects the prompt outside a user gesture. */
export function useOriginGrant(pattern: Option.Option<string>): OriginGrantHandle {
  const [answers, setAnswers] = useState<GrantAnswers>(NO_ANSWERS)
  // An Option is a new object on every render; its string value keeps the
  // effect dependency stable.
  const origin = Option.getOrUndefined(pattern)
  useEffect(() => {
    if (origin === undefined) return undefined
    let active = true
    void (async () => {
      const grant = await queryGrant(Option.some(origin), containsOrigin)
      if (active) setAnswers(withAnswer(origin, grant))
    })()
    return () => {
      active = false
    }
  }, [origin])
  return {
    grant: currentGrant(pattern, answers),
    request: async () => {
      if (origin === undefined) return
      try {
        setAnswers(withAnswer(origin, grantOf(await requestOrigin(origin))))
      } catch {
        setAnswers(withAnswer(origin, 'request-failed'))
      }
    },
  }
}
