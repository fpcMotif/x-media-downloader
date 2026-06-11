export interface CloudItemCreate {
  readonly id: string
  readonly mediaId: string
  readonly tweetId: string
  readonly handle: string
  readonly type: 'photo' | 'video' | 'gif'
  readonly url: string
  readonly ext: string
  readonly filename: string
}

export interface CloudJobCreate {
  readonly id: string
  readonly userId: string
  readonly sourceKind: 'tweet' | 'thread' | 'manual'
  readonly sourceUrl?: string
  readonly total: number
  readonly items: readonly CloudItemCreate[]
}

export interface CloudJobUpdate {
  readonly status?: 'running' | 'complete' | 'partial' | 'failed' | 'canceled'
  readonly completed?: number
  readonly failed?: number
  readonly bytesReceived?: number
  readonly bytesTotal?: number
  readonly throughputBps?: number
  readonly etaSeconds?: number | null
}

export interface CloudJobRecord {
  readonly id: string
  readonly sourceKind: string
  readonly sourceUrl: string | null
  readonly status: 'queued' | 'running' | 'complete' | 'partial' | 'failed' | 'canceled'
  readonly total: number
  readonly completed: number
  readonly failed: number
  readonly bytesReceived: number
  readonly bytesTotal: number
  readonly throughputBps: number
  readonly createdAt: number
  readonly updatedAt: number
}
