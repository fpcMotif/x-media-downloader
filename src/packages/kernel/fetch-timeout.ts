import { bindFetch } from './fetch'

const joined = (caller: AbortSignal | null | undefined, own: AbortSignal): AbortSignal =>
  caller ? AbortSignal.any([caller, own]) : own

export const withTotalTimeout = (fetchImpl: typeof fetch, timeoutMs: number): typeof fetch => {
  const bound = bindFetch(fetchImpl)
  return (input, init) =>
    bound(input, { ...init, signal: joined(init?.signal, AbortSignal.timeout(timeoutMs)) })
}

const timeoutError = (what: string): DOMException => new DOMException(what, 'TimeoutError')

export const withStallTimeout = (
  fetchImpl: typeof fetch,
  headersMs: number,
  idleMs: number,
): typeof fetch => {
  const bound = bindFetch(fetchImpl)
  return async (input, init) => {
    const controller = new AbortController()
    const headerTimer = setTimeout(
      () => controller.abort(timeoutError('response headers timed out')),
      headersMs,
    )
    let response: Response
    try {
      response = await bound(input, { ...init, signal: joined(init?.signal, controller.signal) })
    } finally {
      clearTimeout(headerTimer)
    }
    const body = response.body
    if (body === null) return response
    const reader = body.getReader()
    const guarded = new ReadableStream<Uint8Array>({
      async pull(sink) {
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        const stalled = new Promise<never>((_resolve, reject) => {
          idleTimer = setTimeout(() => reject(timeoutError('response body stalled')), idleMs)
        })
        try {
          const step = await Promise.race([reader.read(), stalled])
          if (step.done) sink.close()
          else sink.enqueue(step.value)
        } catch (error) {
          controller.abort(error)
          sink.error(error)
        } finally {
          clearTimeout(idleTimer)
        }
      },
      cancel(reason) {
        controller.abort(reason)
        return reader.cancel(reason)
      },
    })
    return new Response(guarded, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}
