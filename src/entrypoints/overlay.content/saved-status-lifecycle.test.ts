import { beforeEach, describe, expect, it } from 'vitest'
import { makeSavedStatusLifecycle } from './saved-status-lifecycle'

const article = (tweetId: string): HTMLElement => {
  const el = document.createElement('article')
  el.setAttribute('data-testid', 'tweet')
  el.innerHTML = `<a href="/alice/status/${tweetId}"><time></time></a>`
  return el
}

const deferred = <A>() => {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function clock() {
  let next: (() => void) | null = null
  return {
    after: (_ms: number, task: () => void) => {
      next = task
      return () => {
        next = null
      }
    },
    run: () => {
      const task = next
      next = null
      task?.()
    },
  }
}

describe('Saved Status lifecycle', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('removes chips and rejects an in-flight reply after disable', async () => {
    const tweet = article('1')
    tweet.append(Object.assign(document.createElement('div'), { className: 'xdl-saved-chip' }))
    document.body.append(tweet)
    const c = clock()
    const reply = deferred<string[]>()
    const lifecycle = makeSavedStatusLifecycle({
      document,
      debounceMs: 1,
      clock: c,
      inScope: () => true,
      requestSavedStatus: () => reply.promise,
    })

    lifecycle.apply(true)
    c.run()
    lifecycle.apply(false)
    reply.resolve(['1'])
    await reply.promise
    await Promise.resolve()

    expect(document.querySelectorAll('.xdl-saved-chip')).toHaveLength(0)
  })

  it('clears route marks and stops scheduling after teardown', async () => {
    document.body.append(article('1'))
    const c = clock()
    let requests = 0
    const lifecycle = makeSavedStatusLifecycle({
      document,
      debounceMs: 1,
      clock: c,
      inScope: () => true,
      requestSavedStatus: async () => {
        requests++
        return ['1']
      },
    })

    lifecycle.apply(true)
    c.run()
    await Promise.resolve()
    expect(document.querySelectorAll('.xdl-saved-chip')).toHaveLength(1)
    expect(document.querySelector('article')?.getAttribute('style')).toContain('position: relative')

    lifecycle.onLocationChange()
    expect(document.querySelectorAll('.xdl-saved-chip')).toHaveLength(0)
    expect(document.querySelector('article')?.getAttribute('style')).toBeNull()
    lifecycle.stop()
    document.body.append(article('2'))
    await Promise.resolve()
    c.run()

    expect(requests).toBe(1)
  })

  it('preserves a host-owned inline position', async () => {
    const tweet = article('1')
    tweet.style.position = 'absolute'
    document.body.append(tweet)
    const c = clock()
    const lifecycle = makeSavedStatusLifecycle({
      document,
      debounceMs: 1,
      clock: c,
      inScope: () => true,
      requestSavedStatus: async () => ['1'],
    })

    lifecycle.apply(true)
    c.run()
    await Promise.resolve()
    lifecycle.stop()

    expect(tweet.style.position).toBe('absolute')
    expect(tweet.querySelector('.xdl-saved-chip')).toBeNull()
  })
})
