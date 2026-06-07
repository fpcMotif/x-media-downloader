import { Data } from 'effect'

/** A media download failed to start or was interrupted. */
export class DownloadError extends Data.TaggedError('DownloadError')<{
  readonly id: string
  readonly reason: string
}> {}

/** Media could not be detected/parsed from a source. */
export class DetectError extends Data.TaggedError('DetectError')<{
  readonly reason: string
}> {}
