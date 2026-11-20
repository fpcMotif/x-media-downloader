import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  type OriginGrant,
  currentGrant,
  grantOf,
  offersGrantRequest,
  queryGrant,
  withAnswer,
} from './use-origin-grant'

const A = 'https://a.example/*'
const B = 'https://b.example/*'

describe('grantOf', () => {
  it('names both answers of the permissions API', () => {
    expect(grantOf(true)).toBe('granted')
    expect(grantOf(false)).toBe('denied')
  })
})

describe('queryGrant', () => {
  it('is no-origin without a valid origin pattern and asks nothing', async () => {
    let asked = 0
    const grant = await queryGrant(Option.none(), () => {
      asked += 1
      return Promise.resolve(true)
    })
    expect(grant).toBe('no-origin')
    expect(asked).toBe(0)
  })

  it('asks for exactly the given origin', async () => {
    const seen: string[] = []
    const grant = await queryGrant(Option.some(A), (origin) => {
      seen.push(origin)
      return Promise.resolve(false)
    })
    expect(grant).toBe('denied')
    expect(seen).toEqual([A])
  })

  it('is check-failed when the permissions API throws', async () => {
    const grant = await queryGrant(Option.some(A), () =>
      Promise.reject(new Error('Invalid match pattern')),
    )
    expect(grant).toBe('check-failed')
  })
})

describe('offersGrantRequest', () => {
  it('offers the Grant button after a denial or a failed request only', () => {
    expect(offersGrantRequest('denied')).toBe(true)
    expect(offersGrantRequest('request-failed')).toBe(true)
    const noButton = ['no-origin', 'checking', 'granted', 'check-failed'] satisfies OriginGrant[]
    for (const grant of noButton) expect(offersGrantRequest(grant)).toBe(false)
  })
})

describe('currentGrant', () => {
  const answers = new Map<string, OriginGrant>([[A, 'granted']])

  it('is no-origin when there is nothing to check, whatever was stored', () => {
    expect(currentGrant(Option.none(), answers)).toBe('no-origin')
  })

  it('is checking while no answer exists for this origin', () => {
    expect(currentGrant(Option.some(B), answers)).toBe('checking')
  })

  it('is the stored answer for this origin', () => {
    expect(currentGrant(Option.some(A), answers)).toBe('granted')
  })
})

describe('withAnswer', () => {
  it('a late answer for one origin leaves another origin answer in place', () => {
    const before = new Map<string, OriginGrant>([[B, 'granted']])
    const after = withAnswer(A, 'denied')(before)
    expect(currentGrant(Option.some(B), after)).toBe('granted')
    expect(currentGrant(Option.some(A), after)).toBe('denied')
  })
})
