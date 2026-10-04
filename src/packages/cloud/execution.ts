export interface UploadCandidate {
  readonly item: {
    readonly id: string
    readonly url: string
    readonly handle: string
    readonly ext: string
  }
  readonly filename: string
  readonly estimatedBytes?: number
}

export interface CloudHistoryNotice {
  readonly mediaId: string
  readonly kind: 'queued' | 'completed' | 'failed'
  readonly at: number
}
