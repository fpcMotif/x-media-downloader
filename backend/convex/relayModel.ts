import { v } from 'convex/values'

export const CHUNK_BYTES = 8 * 1024 * 1024
export const LEASE_MS = 11 * 60 * 1000
export const relayState = v.union(
  v.literal('queued'),
  v.literal('uploading'),
  v.literal('completed'),
  v.literal('failed'),
)
export const relayInput = {
  deviceId: v.string(),
  mediaId: v.string(),
  sourceUrl: v.string(),
  path: v.string(),
  contentType: v.string(),
  budgetDay: v.string(),
  estimatedBytes: v.number(),
}
export const relayProgress = {
  fileId: v.optional(v.string()),
  session: v.optional(v.string()),
  folderIds: v.optional(v.array(v.string())),
  total: v.optional(v.number()),
  etag: v.optional(v.string()),
  resolvedUrl: v.optional(v.string()),
  offset: v.number(),
  sourceBytes: v.number(),
  uploadedBytes: v.number(),
  peakRss: v.number(),
}
export const relayFields = {
  ...relayInput,
  ...relayProgress,
  execution: v.literal('convex'),
  provider: v.literal('gdrive'),
  status: relayState,
  at: v.number(),
  acceptedAt: v.number(),
  epoch: v.number(),
  fence: v.number(),
  leaseUntil: v.number(),
  failures: v.number(),
  nextAt: v.number(),
  error: v.optional(v.string()),
  maxBytes: v.number(),
  maxElapsedMs: v.number(),
  maxRetries: v.number(),
  folderId: v.string(),
}
export const relayDoc = v.object({
  _id: v.id('relay_jobs'),
  _creationTime: v.number(),
  ...relayFields,
})
export const publicJob = v.object({
  mediaId: v.string(),
  deviceId: v.string(),
  execution: v.literal('convex'),
  provider: v.literal('gdrive'),
  status: relayState,
  path: v.string(),
  at: v.number(),
  acceptedAt: v.number(),
  offset: v.number(),
  total: v.optional(v.number()),
  fileId: v.optional(v.string()),
  error: v.optional(v.string()),
  failures: v.number(),
  sourceBytes: v.number(),
  uploadedBytes: v.number(),
  peakRss: v.number(),
})

function limit(raw: string | undefined, fallback: number, ceiling: number): number {
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling)
    throw new Error('Invalid relay limit configuration')
  return value
}
export function limits() {
  return {
    maxBytes: limit(process.env.RELAY_MAX_BYTES, 512 * 1024 * 1024, 2 * 1024 * 1024 * 1024),
    maxElapsedMs: limit(process.env.RELAY_MAX_ELAPSED_MS, 60 * 60 * 1000, 24 * 60 * 60 * 1000),
    maxRetries: limit(process.env.RELAY_MAX_RETRIES, 3, 10),
  }
}
export function setupReason(): string | null {
  if (process.env.RELAY_ENABLED !== 'true') return 'Deployment experiment is disabled'
  if (
    !process.env.RELAY_DRIVE_CLIENT_ID ||
    !process.env.RELAY_DRIVE_CLIENT_SECRET ||
    !process.env.RELAY_DRIVE_REFRESH_TOKEN ||
    !process.env.RELAY_DRIVE_FOLDER_ID
  )
    return 'Deployment Drive configuration is incomplete'
  try {
    limits()
  } catch {
    return 'Invalid relay limit configuration'
  }
  return null
}
