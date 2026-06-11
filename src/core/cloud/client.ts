import type { CloudItemUpdate, CloudJobCreate, CloudJobRecord, CloudJobUpdate } from './types'

export interface CloudClient {
  readonly createJob: (job: CloudJobCreate) => Promise<void>
  readonly updateJob: (id: string, update: CloudJobUpdate) => Promise<void>
  readonly updateItem: (jobId: string, itemId: string, update: CloudItemUpdate) => Promise<void>
  readonly listJobs: (userId: string) => Promise<CloudJobRecord[]>
  readonly deleteJob: (id: string) => Promise<void>
}

export function makeCloudClient(workerUrl: string): CloudClient {
  const base = workerUrl.replace(/\/$/, '')

  const send = (path: string, method: string, body?: unknown): Promise<void> => {
    const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
    if (body !== undefined) init.body = JSON.stringify(body)
    return fetch(`${base}${path}`, init).then(() => undefined)
  }

  return {
    createJob: (job) => send('/jobs', 'POST', job).catch(() => {}),
    updateJob: (id, update) => send(`/jobs/${id}`, 'PATCH', update).catch(() => {}),
    updateItem: (jobId, itemId, update) =>
      send(`/jobs/${jobId}/items/${itemId}`, 'PATCH', update).catch(() => {}),
    deleteJob: (id) => send(`/jobs/${id}`, 'DELETE').catch(() => {}),
    listJobs: (userId) =>
      fetch(`${base}/jobs?userId=${encodeURIComponent(userId)}`)
        .then((r) => r.json() as Promise<CloudJobRecord[]>)
        .catch(() => []),
  }
}
