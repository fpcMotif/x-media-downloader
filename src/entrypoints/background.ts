import { Effect, Result, Schema } from 'effect'
import { Message, type MediaItem } from '../core/schema'
import { SettingsService, SettingsServiceLive } from '../core/settings'
import { makeDirectStrategy } from '../core/download/strategy'
import { makeDownloadQueueCore } from '../core/download/queue'
import { renderFilename } from '../core/download/filename'

const handleDownload = (items: ReadonlyArray<MediaItem>) =>
  Effect.gen(function* () {
    const svc = yield* SettingsService
    const settings = yield* svc.get
    const strategy = makeDirectStrategy({
      download: (opts) => browser.downloads.download(opts),
    })
    const queue = makeDownloadQueueCore({ strategy, concurrency: settings.downloadConcurrency })
    const res = yield* queue.enqueue(items, (item) =>
      renderFilename(settings.filenameTemplate, item),
    )
    return { _tag: 'QueueUpdate' as const, completed: res.completed, total: res.total }
  }).pipe(Effect.provide(SettingsServiceLive))

export default defineBackground(() => {
  // Listeners registered synchronously at the top of main() (grounding §b).
  browser.downloads.onChanged.addListener(() => {
    // Progress/persistence tracking — task 007 background wiring (future).
  })

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const decoded = Schema.decodeUnknownResult(Message)(message)
    if (Result.isFailure(decoded)) return false
    const msg = decoded.success
    if (msg._tag === 'DownloadRequest') {
      void Effect.runPromise(handleDownload(msg.items)).then(sendResponse)
      return true // keep the channel open for the async reply
    }
    return false
  })
})
