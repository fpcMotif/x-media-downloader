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

/** An aria2 JSON-RPC call returned an error envelope or a malformed response. */
export class Aria2RpcError extends Data.TaggedError('Aria2RpcError')<{
  readonly message: string
  readonly code?: number
}> {}

/** The offscreen document failed to save a downloaded blob. */
export class OffscreenSaveError extends Data.TaggedError('OffscreenSaveError')<{
  readonly message: string
}> {}
