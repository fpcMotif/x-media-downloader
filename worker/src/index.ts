interface Env {
  DB: D1Database
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const respond = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })

/** Converts a D1 result row's snake_case keys to camelCase. */
function camel(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v
  }
  return out
}

// ─── route handlers ──────────────────────────────────────────────────────────

async function handleCreateJob(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as {
    id: string
    userId: string
    sourceKind: string
    sourceUrl?: string
    total: number
    items: {
      id: string
      mediaId: string
      tweetId: string
      handle: string
      type: string
      url: string
      ext: string
      filename: string
    }[]
  }
  const now = Date.now()
  const itemStmts = body.items.map((item) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO download_items
         (id,job_id,media_id,tweet_id,handle,type,url,ext,filename,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,'queued',?,?)`,
    ).bind(
      item.id,
      body.id,
      item.mediaId,
      item.tweetId,
      item.handle,
      item.type,
      item.url,
      item.ext,
      item.filename,
      now,
      now,
    ),
  )
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO download_jobs
         (id,user_id,source_kind,source_url,status,total,created_at,updated_at)
       VALUES (?,?,?,?,'running',?,?,?)`,
    ).bind(body.id, body.userId ?? 'default', body.sourceKind, body.sourceUrl ?? null, body.total, now, now),
    ...itemStmts,
  ])
  return respond({ id: body.id }, 201)
}

async function handleUpdateJob(req: Request, env: Env, jobId: string): Promise<Response> {
  const body = (await req.json()) as Record<string, unknown>
  const now = Date.now()
  const fieldMap: Record<string, string> = {
    status: 'status',
    completed: 'completed',
    failed: 'failed',
    bytesReceived: 'bytes_received',
    bytesTotal: 'bytes_total',
    throughputBps: 'throughput_bps',
    etaSeconds: 'eta_seconds',
  }
  const sets: string[] = ['updated_at = ?']
  const vals: unknown[] = [now]
  for (const [key, col] of Object.entries(fieldMap)) {
    if (key in body) {
      sets.push(`${col} = ?`)
      vals.push(body[key] ?? null)
    }
  }
  await env.DB.prepare(`UPDATE download_jobs SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...vals, jobId)
    .run()
  return respond({ id: jobId })
}

async function handleDeleteJob(env: Env, jobId: string): Promise<Response> {
  await env.DB.prepare(`DELETE FROM download_jobs WHERE id = ?`).bind(jobId).run()
  return respond({ id: jobId })
}

async function handleListJobs(env: Env, userId: string, limit: number): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id,source_kind,source_url,status,total,completed,failed,
            bytes_received,bytes_total,throughput_bps,created_at,updated_at
     FROM download_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(userId, limit)
    .all()
  return respond((results ?? []).map((r) => camel(r as Record<string, unknown>)))
}

async function handleGetJob(env: Env, jobId: string): Promise<Response> {
  const job = await env.DB.prepare(`SELECT * FROM download_jobs WHERE id = ?`).bind(jobId).first()
  if (!job) return respond({ error: 'not_found' }, 404)
  const { results: items } = await env.DB.prepare(
    `SELECT * FROM download_items WHERE job_id = ? ORDER BY created_at`,
  )
    .bind(jobId)
    .all()
  return respond({
    ...camel(job as Record<string, unknown>),
    items: (items ?? []).map((r) => camel(r as Record<string, unknown>)),
  })
}

async function handleUpdateItem(
  req: Request,
  env: Env,
  jobId: string,
  itemId: string,
): Promise<Response> {
  const body = (await req.json()) as Record<string, unknown>
  const now = Date.now()
  const fieldMap: Record<string, string> = {
    status: 'status',
    bytesReceived: 'bytes_received',
    bytesTotal: 'bytes_total',
    attemptCount: 'attempt_count',
    lastError: 'last_error',
  }
  const sets: string[] = ['updated_at = ?']
  const vals: unknown[] = [now]
  for (const [key, col] of Object.entries(fieldMap)) {
    if (key in body) {
      sets.push(`${col} = ?`)
      vals.push(body[key] ?? null)
    }
  }
  await env.DB.prepare(
    `UPDATE download_items SET ${sets.join(', ')} WHERE id = ? AND job_id = ?`,
  )
    .bind(...vals, itemId, jobId)
    .run()
  return respond({ id: itemId })
}

// ─── main fetch handler ───────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    const { pathname, searchParams } = new URL(request.url)
    const method = request.method

    try {
      // POST /jobs — create job + items in one batch
      if (method === 'POST' && pathname === '/jobs') return handleCreateJob(request, env)

      // GET /jobs?userId=…&limit=… — list recent jobs
      if (method === 'GET' && pathname === '/jobs') {
        const userId = searchParams.get('userId') ?? 'default'
        const limit = Math.min(Number(searchParams.get('limit') ?? 20), 100)
        return handleListJobs(env, userId, limit)
      }

      // /jobs/:id routes
      const jobMatch = /^\/jobs\/([^/]+)$/.exec(pathname)
      if (jobMatch) {
        const id = jobMatch[1]!
        if (method === 'PATCH') return handleUpdateJob(request, env, id)
        if (method === 'GET') return handleGetJob(env, id)
        if (method === 'DELETE') return handleDeleteJob(env, id)
      }

      // /jobs/:jobId/items/:itemId routes
      const itemMatch = /^\/jobs\/([^/]+)\/items\/([^/]+)$/.exec(pathname)
      if (itemMatch) {
        const [, jobId, itemId] = itemMatch
        if (method === 'PATCH') return handleUpdateItem(request, env, jobId!, itemId!)
      }

      return respond({ error: 'not_found' }, 404)
    } catch (err) {
      return respond({ error: String(err) }, 500)
    }
  },
}
