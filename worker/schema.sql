CREATE TABLE IF NOT EXISTS download_jobs (
  id          TEXT    PRIMARY KEY,
  user_id     TEXT    NOT NULL DEFAULT 'default',
  source_kind TEXT    NOT NULL,
  source_url  TEXT,
  status      TEXT    NOT NULL DEFAULT 'running',
  total       INTEGER NOT NULL DEFAULT 0,
  completed   INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  bytes_received INTEGER NOT NULL DEFAULT 0,
  bytes_total    INTEGER NOT NULL DEFAULT 0,
  throughput_bps REAL    NOT NULL DEFAULT 0,
  eta_seconds    REAL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS download_items (
  id           TEXT    PRIMARY KEY,
  job_id       TEXT    NOT NULL REFERENCES download_jobs(id) ON DELETE CASCADE,
  media_id     TEXT    NOT NULL,
  tweet_id     TEXT    NOT NULL,
  handle       TEXT    NOT NULL,
  type         TEXT    NOT NULL,
  url          TEXT    NOT NULL,
  ext          TEXT    NOT NULL,
  filename     TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'queued',
  bytes_received INTEGER NOT NULL DEFAULT 0,
  bytes_total    INTEGER NOT NULL DEFAULT 0,
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_job        ON download_items(job_id);
CREATE INDEX IF NOT EXISTS idx_jobs_user_date   ON download_jobs(user_id, created_at DESC);
